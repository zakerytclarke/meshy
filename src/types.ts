export type TabId = "messages" | "map" | "logs" | "radio";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "configuring"
  | "connected";

/** Outline until someone has been here. Grey after a visit. Color after a message. */
export type Reach = "unknown" | "visited" | "miss" | "node" | "mesh";

export type DeliveryState =
  | "pending"
  | "hit-node"
  | "hit-mesh"
  | "failed"
  | "received";

export interface NodeRecord {
  num: number;
  longName: string;
  shortName: string;
  lat?: number;
  lng?: number;
  altitude?: number;
  snr?: number;
  rssi?: number;
  hopsAway?: number;
  lastHeard?: number;
  battery?: number;
  voltage?: number;
  channel?: number;
  viaMqtt?: boolean;
  hwModel?: string;
}

export interface ChannelRecord {
  index: number;
  role: "primary" | "secondary" | "disabled";
  name: string;
  pskBase64: string;
}

export interface ChatMessage {
  id: string;
  packetId: number;
  from: number;
  to: number;
  channel: number;
  direct: boolean;
  text: string;
  time: number;
  outgoing: boolean;
  delivery: DeliveryState;
  snr?: number;
  rssi?: number;
  hops?: number | null;
  detail?: string;
}

export interface SignalCell {
  key: string;
  latIndex: number;
  lngIndex: number;
  reach: Exclude<Reach, "unknown">;
  /** 0 is a weak local contact. 1 is a strong packet that propagated. */
  score: number;
  /** True after a message was received here or a send was acknowledged. */
  contact?: boolean;
  snr?: number;
  rssi?: number;
  hops: number | null;
  rx: number;
  tx: number;
  updated: number;
  note: string;
  /** Nodes heard while we were in this square, who have not sent a GPS fix. */
  heard?: number[];
  /** Packets heard while we were in this square, oldest first. */
  history?: CellEvent[];
}

export interface CellEvent {
  time: number;
  num: number;
  hops: number | null;
  label: string;
  text?: string;
}

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy?: number;
  time: number;
}

export interface LogEntry {
  id: string;
  time: number;
  dir: "rx" | "tx" | "sys";
  kind: string;
  summary: string;
  detail: unknown;
}

export interface RadioSnapshot {
  region?: string;
  modemPreset?: string;
  hopLimit?: number;
  txPower?: number;
  channelNum?: number;
  firmware?: string;
}

export interface ChatRef {
  kind: "channel" | "dm";
  id: number;
}

export interface Banner {
  tone: "error" | "ok";
  text: string;
}

export const BROADCAST_NUM = 0xffffffff;
export const CELL_DEGREES = 0.004;
