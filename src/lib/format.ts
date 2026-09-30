import { BROADCAST_NUM, type NodeRecord } from "../types";

export function nodeId(num: number): string {
  return "!" + (num >>> 0).toString(16).padStart(8, "0");
}

export function nodeName(nodes: NodeRecord[], num: number, myNum: number): string {
  if (myNum !== 0 && num === myNum) return "You";
  if (num === BROADCAST_NUM) return "Everyone";
  const node = nodes.find((item) => item.num === num);
  if (node?.longName) return node.longName;
  if (node?.shortName) return node.shortName;
  if (num === 0) return "Radio";
  return nodeId(num);
}

export function shortName(nodes: NodeRecord[], num: number, myNum: number): string {
  if (myNum !== 0 && num === myNum) {
    const mine = nodes.find((item) => item.num === num);
    return mine?.shortName || "ME";
  }
  const node = nodes.find((item) => item.num === num);
  return (node?.shortName || nodeId(num).slice(-4)).slice(0, 4);
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  const clock = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  if (sameDay) return clock;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function formatAgo(ms: number | undefined): string {
  if (!ms) return "Not heard";
  const delta = Date.now() - ms;
  if (delta < 15_000) return "Just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

export function enumLabel(table: object, value: number | undefined): string | undefined {
  if (value == null) return undefined;
  const name = (table as Record<number, string | number>)[value];
  if (typeof name !== "string") return undefined;
  return name
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function positionDegrees(
  latitudeI?: number,
  longitudeI?: number,
): { lat: number; lng: number } | null {
  if (latitudeI == null || longitudeI == null) return null;
  if (latitudeI === 0 && longitudeI === 0) return null;
  const lat = latitudeI * 1e-7;
  const lng = longitudeI * 1e-7;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

export function toDetail(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): unknown => {
    if (current == null || typeof current === "number" || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (current instanceof Uint8Array) return bytesToBase64(current);
    if (current instanceof Date) return current.toISOString();
    if (depth > 7) return "[truncated]";
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[circular]";
    seen.add(current);
    if (Array.isArray(current)) return current.slice(0, 32).map((item) => walk(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      if (key.startsWith("$") || typeof item === "function") continue;
      output[key] = walk(item, depth + 1);
    }
    return output;
  };
  return walk(value, 0);
}

export function threadKey(kind: "channel" | "dm", id: number): string {
  return `${kind}:${id}`;
}

export function hopsLabel(hops: number | null | undefined): string {
  if (hops == null) return "Hop count not reported";
  if (hops <= 0) return "Direct neighbor";
  if (hops === 1) return "1 hop through the mesh";
  return `${hops} hops through the mesh`;
}

/** Short hop count shown under a node name. */
export function hopCount(hops: number | null | undefined, mine = false): string {
  if (mine) return "This radio";
  if (hops == null) return "Hops unknown";
  return hops === 1 ? "1 hop" : `${hops} hops`;
}
