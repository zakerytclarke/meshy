import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { threadKey } from "../lib/format";
import { RadioSession, bluetoothSupported } from "../lib/session";
import { paintCells } from "../lib/signal";
import { buildShare, mergeShare, parseShare, type CoverageShare } from "../lib/share";
import {
  type Banner,
  type ChannelRecord,
  type ChatMessage,
  type ChatRef,
  type ConnectionStatus,
  type DeliveryState,
  type LogEntry,
  type GeoFix,
  type NodeRecord,
  type RadioSnapshot,
  type TabId,
} from "../types";

interface AppState {
  tab: TabId;
  status: ConnectionStatus;
  statusDetail: string;
  statusNote: string;
  banner: Banner | null;
  busy: string | null;
  myNodeNum: number;
  nodes: NodeRecord[];
  channels: ChannelRecord[];
  messages: ChatMessage[];
  logs: LogEntry[];
  cells: Record<string, import("../types").SignalCell>;
  radio: RadioSnapshot;
  browserFix: GeoFix | null;
  activeChat: ChatRef | null;
  readAt: Record<string, number>;
  radioName: string | null;
}

interface MeshApi extends AppState {
  bluetoothAvailable: boolean;
  setTab: (tab: TabId) => void;
  connect: (forcePicker?: boolean) => void;
  disconnect: () => Promise<void>;
  sendMessage: (text: string) => void;
  addChannel: (name: string, keyOrLink: string) => Promise<boolean>;
  removeChannel: (index: number) => Promise<void>;
  saveName: (longName: string, shortName: string) => Promise<void>;
  reboot: () => Promise<void>;
  openChat: (chat: ChatRef) => void;
  closeChat: () => void;
  messageNode: (num: number) => void;
  requestPosition: (num: number) => void;
  traceRoute: (num: number) => void;
  exportCoverage: () => CoverageShare;
  importCoverage: (value: unknown) => boolean;
  clearCoverage: () => void;
  clearChats: () => void;
  dismissBanner: () => void;
}

const MeshContext = createContext<MeshApi | null>(null);

function readJson<T>(key: string, fallback: T, guard: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadState(): AppState {
  const meta = readJson(
    "mesh.meta",
    { myNodeNum: 0, radio: {} as RadioSnapshot, readAt: {} as Record<string, number>, browserFix: null as GeoFix | null },
    (value): value is { myNodeNum: number; radio: RadioSnapshot; readAt: Record<string, number>; browserFix: GeoFix | null } =>
      isRecord(value),
  );
  return {
    tab: "messages",
    status: "disconnected",
    statusDetail: "Not connected",
    statusNote: "",
    banner: null,
    busy: null,
    myNodeNum: typeof meta.myNodeNum === "number" ? meta.myNodeNum : 0,
    nodes: readJson("mesh.nodes", [], Array.isArray),
    channels: readJson("mesh.channels", [], Array.isArray),
    messages: readJson("mesh.messages", [], Array.isArray),
    logs: readJson("mesh.logs", [], Array.isArray),
    cells: readJson("mesh.cells", {}, isRecord),
    radio: meta.radio ?? {},
    browserFix: isFix(meta.browserFix) ? meta.browserFix : null,
    activeChat: null,
    readAt: meta.readAt ?? {},
    radioName: savedRadioName(),
  };
}

function savedRadioName(): string | null {
  try {
    const raw = localStorage.getItem("mesh.radioDevice");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name ? name : "Radio";
  } catch {
    return null;
  }
}

function isFix(value: unknown): value is GeoFix {
  if (!isRecord(value)) return false;
  const fix = value as Partial<GeoFix>;
  return typeof fix.lat === "number" && typeof fix.lng === "number" && typeof fix.time === "number";
}

const PHONE_FRESH_MS = 2 * 60 * 1000;

/** Phone GPS places the packets you hear while walking. The radio fix is used when the phone has no recent location. */
export function selfPoint(current: Pick<AppState, "nodes" | "myNodeNum" | "browserFix">): { lat: number; lng: number } | null {
  const phone = current.browserFix;
  if (phone && Date.now() - phone.time < PHONE_FRESH_MS) return { lat: phone.lat, lng: phone.lng };
  const me = current.nodes.find((node) => node.num === current.myNodeNum);
  if (me?.lat != null && me.lng != null) return { lat: me.lat, lng: me.lng };
  if (phone) return { lat: phone.lat, lng: phone.lng };
  return null;
}

function movedMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function mergeNode(list: NodeRecord[], patch: Partial<NodeRecord> & { num: number }): NodeRecord[] {
  const index = list.findIndex((node) => node.num === patch.num);
  if (index === -1) {
    return [
      ...list,
      {
        longName: "Unknown node",
        shortName: "?",
        ...patch,
      },
    ];
  }
  const next = { ...list[index] };
  for (const key of Object.keys(patch) as (keyof NodeRecord)[]) {
    const value = patch[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

export function MeshProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef<RadioSession | null>(null);
  const paintTimer = useRef(0);
  if (!sessionRef.current) {
    sessionRef.current = new RadioSession({
      getNodes: () => stateRef.current.nodes,
      getChannels: () => stateRef.current.channels,
      getMyNum: () => stateRef.current.myNodeNum,
      getSelfPoint: () => selfPoint(stateRef.current),
      onStatus: (status, detail, note) =>
        commit(
          (current) => ({
            ...current,
            status,
            statusDetail: detail,
            statusNote: status === "connected" ? "" : note !== undefined ? note : current.statusNote,
          }),
          true,
        ),
      onBanner: (tone, text) => commit((current) => ({ ...current, banner: { tone, text }, busy: null })),
      onMyNode: (num) => commit((current) => ({ ...current, myNodeNum: num })),
      onNode: (patch) => commit((current) => ({ ...current, nodes: mergeNode(current.nodes, patch) })),
      onChannel: (channel) =>
        commit((current) => {
          const rest = current.channels.filter((item) => item.index !== channel.index);
          const channels =
            channel.role === "disabled"
              ? rest
              : [...rest, channel].sort((a, b) => a.index - b.index);
          return { ...current, channels };
        }),
      onRadio: (patch) => commit((current) => ({ ...current, radio: { ...current.radio, ...patch } })),
      onMessage: (message) =>
        commit((current) => {
          if (message.packetId && current.messages.some((item) => item.packetId === message.packetId)) return current;
          return { ...current, messages: [...current.messages, message].slice(-2000) };
        }),
      onDelivery: (packetId, delivery, extra) => commit((current) => applyDelivery(current, packetId, delivery, extra)),
      onLog: (entry) =>
        commit((current) => ({
          ...current,
          logs: [{ id: crypto.randomUUID(), time: Date.now(), ...entry }, ...current.logs].slice(0, 1200),
        })),
      onObservation: (observation) =>
        commit((current) => ({ ...current, cells: paintCells(current.cells, observation) })),
      onSavedRadio: (name) => commit((current) => ({ ...current, radioName: name })),
    });
  }

  function commit(recipe: (current: AppState) => AppState, immediate = false) {
    stateRef.current = recipe(stateRef.current);
    if (immediate) {
      window.clearTimeout(paintTimer.current);
      paintTimer.current = 0;
      setState(stateRef.current);
      return;
    }
    // Node packets arrive in a burst. Paint on a steady cadence so the phone
    // can keep servicing Bluetooth, and so a burst cannot postpone the paint forever.
    if (paintTimer.current) return;
    paintTimer.current = window.setTimeout(() => {
      paintTimer.current = 0;
      setState(stateRef.current);
    }, 80);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = saveState(stateRef.current);
      if (!trimmed) return;
      commit((current) => ({
        ...current,
        messages: trimmed.messages,
        logs: trimmed.logs,
        cells: trimmed.cells,
      }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state.messages, state.logs, state.cells, state.nodes, state.channels, state.myNodeNum, state.radio, state.readAt, state.browserFix]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          time: position.timestamp || Date.now(),
        };
        const previous = stateRef.current.browserFix;
        if (previous && movedMeters(previous, next) < 8) return;
        commit((current) => ({
          ...current,
          browserFix: next,
          cells: paintCells(current.cells, {
            points: [{ lat: next.lat, lng: next.lng }],
            hops: null,
            dir: "rx",
            visit: true,
            note: "Been here",
            time: next.time,
          }),
        }));
      },
      () => {
        /* The radio GPS can still place the node. */
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const askedFix = useRef(false);
  useEffect(() => {
    if (state.status !== "connected" || !state.myNodeNum) {
      askedFix.current = false;
      return;
    }
    if (askedFix.current) return;
    const timer = window.setTimeout(() => {
      askedFix.current = true;
      try {
        sessionRef.current?.requestPosition(stateRef.current.myNodeNum);
      } catch {
        askedFix.current = false;
      }
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [state.status, state.myNodeNum]);

  useEffect(() => {
    void sessionRef.current?.restore();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void sessionRef.current?.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const chat = state.activeChat;
    if (state.tab !== "messages" || !chat) return;
    const key = threadKey(chat.kind, chat.id);
    const latest = state.messages.reduce((max, message) => {
      if (!inOpenChat(message, chat, state.myNodeNum)) return max;
      return Math.max(max, message.time);
    }, 0);
    if ((state.readAt[key] ?? 0) >= latest) return;
    commit((current) => {
      if (current.tab !== "messages" || !current.activeChat) return current;
      if (current.activeChat.kind !== chat.kind || current.activeChat.id !== chat.id) return current;
      return { ...current, readAt: { ...current.readAt, [key]: Date.now() } };
    });
  }, [state.tab, state.activeChat, state.messages, state.readAt, state.myNodeNum]);

  const api = useMemo<MeshApi>(() => {
    const session = sessionRef.current!;
    return {
      ...state,
      bluetoothAvailable: bluetoothSupported(),
      setTab: (tab) => commit((current) => ({ ...current, tab })),
      connect: (forcePicker) => {
        void session.connect(forcePicker);
      },
      disconnect: () => session.disconnect(),
      sendMessage: (text) => {
        const chat = stateRef.current.activeChat;
        const current = stateRef.current;
        if (!chat || current.status !== "connected") {
          commit((item) => ({ ...item, banner: { tone: "error", text: "Connect the radio before sending." } }));
          return;
        }
        const destination = chat.kind === "dm" ? chat.id : "broadcast";
        const channel = chat.kind === "channel" ? chat.id : 0;
        void session.sendText(text, destination, channel);
      },
      addChannel: async (name, keyOrLink) => {
        commit((current) => ({ ...current, busy: "Saving channel…", banner: null }));
        try {
          const added = await session.addChannels(name, keyOrLink);
          commit((current) => ({
            ...current,
            busy: null,
            banner: { tone: "ok", text: `Channel saved. Share this key: ${added}` },
          }));
          return true;
        } catch (error) {
          commit((current) => ({
            ...current,
            busy: null,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not add the channel." },
          }));
          return false;
        }
      },
      removeChannel: async (index) => {
        commit((current) => ({ ...current, busy: "Removing channel…", banner: null }));
        try {
          await session.removeChannel(index);
          commit((current) => ({ ...current, busy: null, banner: { tone: "ok", text: "Channel removed." } }));
        } catch (error) {
          commit((current) => ({
            ...current,
            busy: null,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not remove the channel." },
          }));
        }
      },
      saveName: async (longName, shortName) => {
        commit((current) => ({ ...current, busy: "Saving name…", banner: null }));
        try {
          await session.saveName(longName, shortName);
          commit((current) => ({ ...current, busy: null, banner: { tone: "ok", text: "Name saved on the radio." } }));
        } catch (error) {
          commit((current) => ({
            ...current,
            busy: null,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not save the name." },
          }));
        }
      },
      reboot: async () => {
        commit((current) => ({ ...current, busy: "Rebooting…", banner: null }));
        try {
          await session.reboot();
        } catch (error) {
          commit((current) => ({
            ...current,
            busy: null,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not reboot." },
          }));
        }
      },
      openChat: (chat) =>
        commit((current) => ({
          ...current,
          tab: "messages",
          activeChat: chat,
          readAt: { ...current.readAt, [`${chat.kind}:${chat.id}`]: Date.now() },
        })),
      closeChat: () => commit((current) => ({ ...current, activeChat: null })),
      messageNode: (num) =>
        commit((current) => ({
          ...current,
          tab: "messages",
          activeChat: { kind: "dm", id: num },
          readAt: { ...current.readAt, [`dm:${num}`]: Date.now() },
        })),
      requestPosition: (num) => {
        try {
          session.requestPosition(num);
          commit((current) => ({ ...current, banner: { tone: "ok", text: "Asked that node for a location." } }));
        } catch (error) {
          commit((current) => ({
            ...current,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not request a location." },
          }));
        }
      },
      traceRoute: (num) => {
        try {
          session.traceRoute(num);
          commit((current) => ({
            ...current,
            banner: { tone: "ok", text: "Tracing the path. Squares update if the reply comes back through the mesh." },
          }));
        } catch (error) {
          commit((current) => ({
            ...current,
            banner: { tone: "error", text: error instanceof Error ? error.message : "Could not trace the path." },
          }));
        }
      },
      exportCoverage: () => buildShare(stateRef.current.logs, stateRef.current.cells, stateRef.current.nodes),
      importCoverage: (value) => {
        const share = parseShare(value);
        if (!share) {
          commit((current) => ({ ...current, banner: { tone: "error", text: "That file is not a Meshy coverage export." } }));
          return false;
        }
        commit((current) => {
          const merged = mergeShare(current, share);
          return {
            ...current,
            logs: merged.logs,
            cells: merged.cells,
            nodes: merged.nodes,
            banner: { tone: "ok", text: "Coverage combined. Message text stays out of the imported file." },
          };
        });
        return true;
      },
      clearCoverage: () => commit((current) => ({ ...current, cells: {} })),
      clearChats: () => commit((current) => ({ ...current, messages: [], activeChat: null })),
      dismissBanner: () => commit((current) => ({ ...current, banner: null })),
    };
  }, [state]);

  return <MeshContext.Provider value={api}>{children}</MeshContext.Provider>;
}

function inOpenChat(message: ChatMessage, chat: ChatRef, myNum: number): boolean {
  if (chat.kind === "channel") return !message.direct && message.channel === chat.id;
  if (message.outgoing && message.direct && message.to === chat.id) return true;
  return message.direct && ((message.from === chat.id && message.to === myNum) || (message.from === myNum && message.to === chat.id));
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
}

function writeStored(current: AppState, messages: AppState["messages"], logs: AppState["logs"], cells: AppState["cells"]): void {
  localStorage.setItem("mesh.messages", JSON.stringify(messages));
  localStorage.setItem("mesh.logs", JSON.stringify(logs));
  localStorage.setItem("mesh.cells", JSON.stringify(cells));
  localStorage.setItem("mesh.nodes", JSON.stringify(current.nodes));
  localStorage.setItem("mesh.channels", JSON.stringify(current.channels));
  localStorage.setItem(
    "mesh.meta",
    JSON.stringify({
      myNodeNum: current.myNodeNum,
      radio: current.radio,
      readAt: current.readAt,
      browserFix: current.browserFix,
    }),
  );
}

/** Null when everything fit. Otherwise the copies with the oldest records removed. */
function saveState(current: AppState): Pick<AppState, "messages" | "logs" | "cells"> | null {
  let messages = current.messages;
  let logs = current.logs;
  let cells = current.cells;
  let trimmed = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      writeStored(current, messages, logs, cells);
      return trimmed ? { messages, logs, cells } : null;
    } catch (error) {
      if (!isQuotaError(error)) return null;
      trimmed = true;
      if (logs.length > 40) {
        logs = logs.slice(0, Math.ceil(logs.length / 2));
        continue;
      }
      if (messages.length > 40) {
        messages = messages.slice(Math.floor(messages.length / 2));
        continue;
      }
      const next = dropOldestCoverage(cells);
      if (next === cells) {
        if (logs.length > 0) logs = [];
        else if (messages.length > 0) messages = [];
        else break;
        continue;
      }
      cells = next;
    }
  }
  return trimmed ? { messages, logs, cells } : null;
}

function dropOldestCoverage(cells: AppState["cells"]): AppState["cells"] {
  const values = Object.values(cells);
  if (values.length === 0) return cells;
  const bulky = values.filter((cell) => (cell.history?.length ?? 0) > 4);
  if (bulky.length > 0) {
    const next = { ...cells };
    const oldest = bulky.sort((a, b) => a.updated - b.updated).slice(0, Math.max(1, Math.ceil(bulky.length / 2)));
    for (const cell of oldest) {
      const history = cell.history ?? [];
      next[cell.key] = { ...cell, history: history.slice(Math.ceil(history.length / 2)) };
    }
    return next;
  }
  if (values.length === 1) {
    const only = values[0];
    if (!only || (only.history?.length ?? 0) === 0) return {};
    return { [only.key]: { ...only, history: undefined } };
  }
  const kept = values.sort((a, b) => b.updated - a.updated).slice(0, Math.ceil(values.length / 2));
  const next: AppState["cells"] = {};
  for (const cell of kept) next[cell.key] = cell;
  return next;
}

function applyDelivery(
  current: AppState,
  packetId: number,
  delivery: DeliveryState,
  extra?: Partial<ChatMessage>,
): AppState {
  let acknowledged = false;
  const messages = current.messages.map((message) => {
    if (message.packetId !== packetId) return message;
    if (message.delivery === "failed") return message;
    if (message.delivery === "hit-mesh" && delivery === "hit-node") return message;
    if (message.delivery !== "hit-node" && message.delivery !== "hit-mesh" && (delivery === "hit-node" || delivery === "hit-mesh")) {
      acknowledged = true;
    }
    return { ...message, ...extra, delivery };
  });
  let cells = current.cells;
  if (acknowledged) {
    const here = selfPoint(current);
    if (here) {
      cells = paintCells(cells, {
        points: [here],
        hops: extra?.hops ?? null,
        snr: extra?.snr,
        rssi: extra?.rssi,
        dir: "tx",
        contact: true,
        note: extra?.detail || "Message sent",
        time: Date.now(),
      });
    }
  }
  return { ...current, messages, cells };
}

export function useMesh(): MeshApi {
  const value = useContext(MeshContext);
  if (!value) throw new Error("useMesh must be used inside MeshProvider");
  return value;
}
