import type { LogEntry, NodeRecord, SignalCell } from "../types";

export interface CoverageShare {
  app: "meshy";
  version: 1;
  logs: LogEntry[];
  cells: Record<string, SignalCell>;
  nodes: Array<Pick<NodeRecord, "num" | "lat" | "lng" | "hopsAway" | "lastHeard">>;
}

export function buildShare(logs: LogEntry[], cells: Record<string, SignalCell>, nodes: NodeRecord[]): CoverageShare {
  return {
    app: "meshy",
    version: 1,
    logs: logs.map(deidentifyLog),
    cells: Object.fromEntries(Object.values(cells).map((cell) => [cell.key, deidentifyCell(cell)])),
    nodes: nodes
      .filter((node) => node.lat != null && node.lng != null)
      .map((node) => ({
        num: node.num,
        lat: node.lat,
        lng: node.lng,
        hopsAway: node.hopsAway,
        lastHeard: node.lastHeard,
      })),
  };
}

export function parseShare(value: unknown): CoverageShare | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CoverageShare>;
  if (record.app !== "meshy" || record.version !== 1) return null;
  if (!Array.isArray(record.logs) || !record.cells || typeof record.cells !== "object" || !Array.isArray(record.nodes)) return null;
  return {
    app: "meshy",
    version: 1,
    logs: record.logs.filter(isLog).map(deidentifyLog),
    cells: Object.fromEntries(
      Object.values(record.cells as Record<string, unknown>)
        .filter(isCell)
        .map((cell) => [cell.key, deidentifyCell(cell)]),
    ),
    nodes: record.nodes.filter(isNode),
  };
}

export function mergeShare(
  current: { logs: LogEntry[]; cells: Record<string, SignalCell>; nodes: NodeRecord[] },
  incoming: CoverageShare,
): { logs: LogEntry[]; cells: Record<string, SignalCell>; nodes: NodeRecord[] } {
  const cells = { ...current.cells };
  for (const cell of Object.values(incoming.cells)) {
    cells[cell.key] = mergeCell(cells[cell.key], cell);
  }
  const seen = new Set(current.logs.map(logKey));
  const logs = [...current.logs];
  for (const entry of incoming.logs) {
    const key = logKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    logs.push({ ...entry, id: crypto.randomUUID(), detail: {} });
  }
  logs.sort((a, b) => b.time - a.time);
  return {
    logs: logs.slice(0, 1200),
    cells: capCells(cells),
    nodes: mergeNodes(current.nodes, incoming.nodes),
  };
}

function deidentifyLog(entry: LogEntry): LogEntry {
  return {
    id: entry.id,
    time: entry.time,
    dir: entry.dir,
    kind: entry.kind,
    summary: entry.kind === "Text" ? entry.summary.replace(/: .*?(?= · |$)/, "") : entry.summary,
    detail: {},
  };
}

function deidentifyCell(cell: SignalCell): SignalCell {
  return {
    ...cell,
    note: cell.contact ? "Message" : "Been here",
    history: cell.history?.map((event) => ({ time: event.time, num: event.num, hops: event.hops, label: event.label })),
  };
}

function mergeCell(local: SignalCell | undefined, incoming: SignalCell): SignalCell {
  if (!local) return incoming;
  const contact = Boolean(local.contact || incoming.contact);
  const winner = contactScore(incoming) > contactScore(local) ? incoming : local;
  const heard = unique([...(local.heard ?? []), ...(incoming.heard ?? [])]).slice(-40);
  const history = uniqueEvents([...(local.history ?? []), ...(incoming.history ?? [])]).slice(-30);
  return {
    ...winner,
    key: local.key,
    latIndex: local.latIndex,
    lngIndex: local.lngIndex,
    contact,
    reach: contact ? winner.reach : "visited",
    score: contact ? Math.max(contactScore(local), contactScore(incoming)) : 0,
    rx: local.rx + incoming.rx,
    tx: local.tx + incoming.tx,
    updated: Math.max(local.updated, incoming.updated),
    heard: heard.length > 0 ? heard : undefined,
    history: history.length > 0 ? history : undefined,
  };
}

function contactScore(cell: SignalCell): number {
  return cell.contact ? cell.score : -1;
}

function mergeNodes(local: NodeRecord[], incoming: CoverageShare["nodes"]): NodeRecord[] {
  const next = local.map((node) => ({ ...node }));
  for (const item of incoming) {
    const index = next.findIndex((node) => node.num === item.num);
    if (index === -1) {
      next.push({
        num: item.num,
        longName: "Unknown node",
        shortName: "?",
        lat: item.lat,
        lng: item.lng,
        hopsAway: item.hopsAway,
        lastHeard: item.lastHeard,
      });
      continue;
    }
    const node = next[index];
    if (node.lat == null && item.lat != null) node.lat = item.lat;
    if (node.lng == null && item.lng != null) node.lng = item.lng;
    if (item.hopsAway != null && (node.hopsAway == null || item.hopsAway < node.hopsAway)) node.hopsAway = item.hopsAway;
    if (item.lastHeard != null && (node.lastHeard == null || item.lastHeard > node.lastHeard)) node.lastHeard = item.lastHeard;
  }
  return next;
}

function capCells(cells: Record<string, SignalCell>): Record<string, SignalCell> {
  const values = Object.values(cells);
  if (values.length <= 4000) return cells;
  values.sort((a, b) => b.updated - a.updated);
  const kept: Record<string, SignalCell> = {};
  for (const cell of values.slice(0, 4000)) kept[cell.key] = cell;
  return kept;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function uniqueEvents(events: NonNullable<SignalCell["history"]>): NonNullable<SignalCell["history"]> {
  const seen = new Set<string>();
  const kept = [];
  for (const event of events) {
    const key = `${event.time}:${event.num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...event, text: event.text });
  }
  kept.sort((a, b) => a.time - b.time);
  return kept;
}

function logKey(entry: LogEntry): string {
  return `${entry.time}|${entry.dir}|${entry.kind}|${entry.summary}`;
}

function isLog(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as LogEntry;
  return typeof entry.time === "number" && typeof entry.kind === "string" && typeof entry.summary === "string" && (entry.dir === "rx" || entry.dir === "tx" || entry.dir === "sys");
}

function isCell(value: unknown): value is SignalCell {
  if (!value || typeof value !== "object") return false;
  const cell = value as SignalCell;
  return typeof cell.key === "string" && typeof cell.score === "number" && typeof cell.updated === "number";
}

function isNode(value: unknown): value is CoverageShare["nodes"][number] {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { num?: unknown }).num === "number";
}
