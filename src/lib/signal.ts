import { CELL_DEGREES, type CellEvent, type SignalCell } from "../types";

export interface Observation {
  points: { lat: number; lng: number; heard?: number[]; event?: CellEvent }[];
  snr?: number;
  rssi?: number;
  hops: number | null;
  dir: "rx" | "tx";
  missed?: boolean;
  note: string;
  time: number;
}

/** Zoom level where one block pixel span is defined. 64px here is about a city block. */
export const BLOCK_ZOOM = 16;
export const BLOCK_PX = 64;

export function projectBlock(lat: number, lng: number): { x: number; y: number } {
  const scale = 256 * 2 ** BLOCK_ZOOM;
  const x = ((lng + 180) / 360) * scale;
  const clamped = Math.min(89.9, Math.max(-89.9, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

export function blockIndex(lat: number, lng: number): { x: number; y: number } {
  const projected = projectBlock(lat, lng);
  return { x: Math.floor(projected.x / BLOCK_PX), y: Math.floor(projected.y / BLOCK_PX) };
}

export function blockKey(x: number, y: number): string {
  return `b:${x}:${y}`;
}

export function blockCorners(x: number, y: number): { north: number; south: number; west: number; east: number } {
  const northWest = unprojectBlock(x * BLOCK_PX, y * BLOCK_PX);
  const southEast = unprojectBlock((x + 1) * BLOCK_PX, (y + 1) * BLOCK_PX);
  return { north: northWest.lat, south: southEast.lat, west: northWest.lng, east: southEast.lng };
}

function unprojectBlock(x: number, y: number): { lat: number; lng: number } {
  const scale = 256 * 2 ** BLOCK_ZOOM;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

export function cellIndex(lat: number, lng: number): { latIndex: number; lngIndex: number } {
  return {
    latIndex: Math.floor(lat / CELL_DEGREES),
    lngIndex: Math.floor(lng / CELL_DEGREES),
  };
}

export function cellKey(latIndex: number, lngIndex: number): string {
  return `${latIndex}:${lngIndex}`;
}

export function cellEdges(latIndex: number, lngIndex: number): {
  south: number;
  north: number;
  west: number;
  east: number;
} {
  return {
    south: latIndex * CELL_DEGREES,
    north: (latIndex + 1) * CELL_DEGREES,
    west: lngIndex * CELL_DEGREES,
    east: (lngIndex + 1) * CELL_DEGREES,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** LoRa SNR roughly spans -20 dB (barely decoded) to +8 dB (strong). */
function signalUnit(snr?: number, rssi?: number): number {
  if (typeof snr === "number" && !Number.isNaN(snr)) return clamp((snr + 20) / 28, 0, 1);
  if (typeof rssi === "number" && rssi !== 0) return clamp((rssi + 130) / 80, 0, 1);
  return 0.35;
}

export function judge(input: {
  snr?: number;
  rssi?: number;
  hops: number | null;
  missed?: boolean;
}): { reach: SignalCell["reach"]; score: number } {
  if (input.missed) return { reach: "miss", score: 0.06 };
  const signal = signalUnit(input.snr, input.rssi);
  if (input.hops != null && input.hops >= 2) {
    return { reach: "mesh", score: 0.45 + signal * 0.55 };
  }
  if (input.hops === 1) {
    return { reach: "mesh", score: 0.28 + signal * 0.34 };
  }
  return { reach: "node", score: 0.05 + signal * 0.37 };
}

export function colorForScore(score: number): string {
  const amount = clamp(score, 0, 1);
  const red: [number, number, number] = [255, 93, 74];
  const yellow: [number, number, number] = [240, 193, 74];
  const green: [number, number, number] = [61, 220, 132];
  const [start, end, mix] = amount < 0.5 ? [red, yellow, amount / 0.5] : [yellow, green, (amount - 0.5) / 0.5];
  const channel = (index: 0 | 1 | 2) => Math.round(start[index] + (end[index] - start[index]) * mix);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

export function reachTitle(cell: Pick<SignalCell, "reach" | "hops">): string {
  if (cell.reach === "miss") return "No node answered";
  if (cell.reach === "mesh" && cell.hops != null && cell.hops >= 2) return "Traveled the mesh";
  if (cell.reach === "mesh") return "Relayed onward";
  return "Reached a node";
}

export function paintCells(prev: Record<string, SignalCell>, observation: Observation): Record<string, SignalCell> {
  if (observation.points.length === 0) return prev;
  const judged = judge(observation);
  const next = { ...prev };
  const seen = new Set<string>();
  for (const point of observation.points) {
    const { x, y } = blockIndex(point.lat, point.lng);
    const latIndex = x;
    const lngIndex = y;
    const key = blockKey(x, y);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = next[key];
    const heard = existing?.heard ? existing.heard.slice() : [];
    for (const num of point.heard ?? []) {
      if (!heard.includes(num)) heard.push(num);
    }
    const history = existing?.history ? existing.history.slice() : [];
    if (point.event && point.event.num !== 0) history.push(point.event);
    next[key] = {
      key,
      latIndex,
      lngIndex,
      reach: judged.reach,
      score: judged.score,
      snr: observation.snr ?? existing?.snr,
      rssi: observation.rssi ?? existing?.rssi,
      hops: observation.hops,
      rx: (existing?.rx ?? 0) + (observation.dir === "rx" ? 1 : 0),
      tx: (existing?.tx ?? 0) + (observation.dir === "tx" ? 1 : 0),
      updated: observation.time,
      note: observation.note,
      heard: heard.length > 0 ? heard.slice(-40) : undefined,
      history: history.length > 0 ? history.slice(-30) : undefined,
    };
  }
  return capCells(next);
}

function capCells(cells: Record<string, SignalCell>): Record<string, SignalCell> {
  const values = Object.values(cells);
  if (values.length <= 4000) return cells;
  values.sort((a, b) => b.updated - a.updated);
  const kept: Record<string, SignalCell> = {};
  for (const cell of values.slice(0, 4000)) kept[cell.key] = cell;
  return kept;
}
