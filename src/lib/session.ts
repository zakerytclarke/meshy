import { create, fromBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf } from "@meshtastic/core";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import {
  base64ToBytes,
  bytesToBase64,
  enumLabel,
  nodeName,
  positionDegrees,
  toDetail,
} from "./format";
import type { Observation } from "./signal";
import {
  type ChannelRecord,
  type ChatMessage,
  type ConnectionStatus,
  type DeliveryState,
  type LogEntry,
  type NodeRecord,
  type RadioSnapshot,
} from "../types";

export interface SessionHooks {
  getNodes: () => NodeRecord[];
  getChannels: () => ChannelRecord[];
  getMyNum: () => number;
  /** Where this radio is. Browser location is the fallback when the radio has no GPS fix. */
  getSelfPoint: () => { lat: number; lng: number } | null;
  onStatus: (status: ConnectionStatus, detail: string) => void;
  onBanner: (tone: "error" | "ok", text: string) => void;
  onMyNode: (num: number) => void;
  onNode: (patch: Partial<NodeRecord> & { num: number }) => void;
  onChannel: (channel: ChannelRecord) => void;
  onRadio: (patch: Partial<RadioSnapshot>) => void;
  onMessage: (message: ChatMessage) => void;
  onDelivery: (packetId: number, delivery: DeliveryState, extra?: Partial<ChatMessage>) => void;
  onLog: (entry: Omit<LogEntry, "id" | "time">) => void;
  onObservation: (observation: Observation) => void;
  onSavedRadio: (name: string) => void;
}

const PORT = Protobuf.Portnums.PortNum;

interface Meta<T> {
  id: number;
  rxTime: Date;
  type: "broadcast" | "direct";
  from: number;
  to: number;
  channel: number;
  data: T;
}

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export class RadioSession {
  private device: MeshDevice | null = null;
  private ble: BluetoothDevice | null = null;
  private unsubs: Array<() => void> = [];
  private owner: Protobuf.Mesh.User | null = null;
  private lastMesh: Protobuf.Mesh.MeshPacket | null = null;
  private connecting = false;
  private restoring = false;
  private userPaused = false;
  private attempt = 0;
  private retryDelay = 1000;
  private retryTimer = 0;
  private pickerPending = false;
  private handledFailures = new Set<number>();

  constructor(private readonly hooks: SessionHooks) {}

  async connect(forcePicker = false): Promise<void> {
    if (!bluetoothSupported()) {
      this.hooks.onBanner("error", "This browser can't use Bluetooth. Open the page in Chrome or Edge.");
      return;
    }
    this.userPaused = false;
    window.clearTimeout(this.retryTimer);
    // requestDevice has to be the first await in this click. A saved radio that
    // this page cannot reopen used to take that path through getDevices and the
    // chooser never appeared.
    if (forcePicker || !this.ble) {
      if (this.pickerPending) return;
      this.attempt += 1;
      const previous = this.device;
      this.drop();
      void previous?.disconnect();
      await this.pick();
      return;
    }
    if (this.device || this.connecting) return;
    await this.open(this.ble);
  }

  /** Reopen the last radio without a picker. Safe to call on page load. */
  async restore(): Promise<void> {
    if (this.userPaused || this.device || this.connecting || this.restoring) return;
    if (!bluetoothSupported() || !navigator.bluetooth?.getDevices) return;
    const saved = readSavedRadio();
    if (!saved) return;
    const attempt = this.attempt;
    this.restoring = true;
    this.hooks.onStatus("connecting", `Reconnecting to ${saved.name}`);
    try {
      const devices = await navigator.bluetooth.getDevices();
      if (attempt !== this.attempt || this.userPaused || this.device) return;
      const match = devices.find((device) => device.id === saved.id);
      if (!match) {
        this.hooks.onStatus("disconnected", "Not connected");
        return;
      }
      this.ble = match;
      await this.open(match);
    } catch (error) {
      if (attempt === this.attempt && !this.userPaused) this.scheduleRetry(bleMessage(error));
    } finally {
      this.restoring = false;
    }
  }

  async disconnect(): Promise<void> {
    this.userPaused = true;
    this.attempt += 1;
    window.clearTimeout(this.retryTimer);
    const device = this.device;
    this.drop();
    this.hooks.onStatus("disconnected", "Not connected");
    if (!device) return;
    try {
      await device.disconnect();
    } catch {
      /* The link may already be gone. */
    }
  }

  private async pick(): Promise<void> {
    if (this.pickerPending) return;
    this.pickerPending = true;
    this.hooks.onStatus("connecting", "Choose your radio");
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [TransportWebBluetooth.ServiceUuid] }],
      });
      this.remember(device);
      await this.open(device);
    } catch (error) {
      this.hooks.onStatus("disconnected", "Not connected");
      const message = bleMessage(error);
      if (!/cancel/i.test(message)) this.hooks.onBanner("error", message);
    } finally {
      this.pickerPending = false;
    }
  }

  private remember(device: BluetoothDevice): void {
    this.ble = device;
    const name = device.name || "Radio";
    try {
      localStorage.setItem("mesh.radioDevice", JSON.stringify({ id: device.id, name }));
    } catch {
      /* The live link still works if storage is full. */
    }
    this.hooks.onSavedRadio(name);
  }

  private async open(device: BluetoothDevice): Promise<void> {
    const attempt = ++this.attempt;
    window.clearTimeout(this.retryTimer);
    this.connecting = true;
    this.userPaused = false;
    this.hooks.onStatus("connecting", `Reconnecting to ${device.name || readSavedRadio()?.name || "radio"}`);
    try {
      const transport = await TransportWebBluetooth.createFromDevice(device);
      if (attempt !== this.attempt || this.userPaused) {
        transport.disconnect();
        return;
      }
      const mesh = new MeshDevice(transport);
      this.device = mesh;
      this.ble = device;
      this.bind(mesh);
      this.hooks.onStatus("configuring", "Loading nodes and channels");
      this.hooks.onLog({
        dir: "sys",
        kind: "Connect",
        summary: "Bluetooth connected. Asking the radio for nodes, channels, and settings.",
        detail: {},
      });
      void mesh.configure().catch((error: unknown) => {
        if (this.device !== mesh) return;
        this.hooks.onBanner("error", error instanceof Error ? error.message : "The radio did not finish starting.");
      });
    } catch (error) {
      if (attempt !== this.attempt || this.userPaused) return;
      this.device = null;
      this.scheduleRetry(bleMessage(error));
    } finally {
      if (attempt === this.attempt) this.connecting = false;
    }
  }

  private scheduleRetry(detail: string): void {
    if (this.userPaused) return;
    window.clearTimeout(this.retryTimer);
    this.hooks.onStatus("connecting", "Reconnecting");
    this.hooks.onLog({ dir: "sys", kind: "Connect", summary: `Radio link dropped. Retrying. ${detail}`, detail: {} });
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    this.retryTimer = window.setTimeout(() => {
      void this.restore();
    }, wait);
  }

  async sendText(text: string, destination: number | "broadcast", channel: number): Promise<void> {
    const device = this.requireDevice();
    try {
      await device.sendText(text, destination, true, channel as never);
    } catch (error) {
      const parsed = asPacketError(error);
      if (!parsed || this.handledFailures.has(parsed.id)) {
        if (!parsed) this.hooks.onBanner("error", error instanceof Error ? error.message : "Send failed.");
        return;
      }
      const detail = routingLabel(parsed.error);
      this.hooks.onDelivery(parsed.id, "failed", { detail });
      this.hooks.onLog({
        dir: "sys",
        kind: "Routing",
        summary: detail,
        detail: parsed,
      });
    }
  }

  async addChannels(name: string, keyOrLink: string): Promise<string> {
    const device = this.requireDevice();
    const shared = decodeShare(keyOrLink);
    const specs = shared ?? [
      {
        name: name.trim(),
        psk: keyOrLink.trim() ? base64ToBytes(keyOrLink.trim()) : crypto.getRandomValues(new Uint8Array(16)),
      },
    ];
    if (!shared && !name.trim()) throw new Error("Give the channel a name.");
    const taken = channelIndexesFrom(this.hooks.getChannels());
    const added: string[] = [];
    for (const spec of specs) {
      const index = nextIndex(taken);
      if (index == null) throw new Error("All extra channels are already in use.");
      taken.add(index);
      const label = (spec.name || name || `Channel ${index}`).slice(0, 11);
      const channel = create(Protobuf.Channel.ChannelSchema, {
        index,
        role: Protobuf.Channel.Channel_Role.SECONDARY,
        settings: {
          name: label,
          psk: spec.psk,
          uplinkEnabled: true,
          downlinkEnabled: true,
        },
      });
      await device.setChannel(channel);
      const record: ChannelRecord = {
        index,
        role: "secondary",
        name: label,
        pskBase64: bytesToBase64(spec.psk),
      };
      this.hooks.onChannel(record);
      this.hooks.onLog({
        dir: "tx",
        kind: "Channel",
        summary: `Added channel ${label}.`,
        detail: { index, name: label, pskBase64: record.pskBase64 },
      });
      added.push(`${label} (${record.pskBase64})`);
    }
    return added.join(", ");
  }

  async removeChannel(index: number): Promise<void> {
    const device = this.requireDevice();
    if (index === 0) throw new Error("The primary channel stays on the radio.");
    await device.clearChannel(index);
    this.hooks.onChannel({ index, role: "disabled", name: "", pskBase64: "" });
    this.hooks.onLog({
      dir: "tx",
      kind: "Channel",
      summary: `Removed channel ${index}.`,
      detail: { index },
    });
  }

  async saveName(longName: string, shortName: string): Promise<void> {
    const device = this.requireDevice();
    const myNum = this.hooks.getMyNum();
    const previous = this.owner;
    const user = create(Protobuf.Mesh.UserSchema, {
      id: previous?.id || nodeIdFrom(myNum),
      longName: longName.trim(),
      shortName: shortName.trim().slice(0, 4),
      hwModel: previous?.hwModel ?? Protobuf.Mesh.HardwareModel.UNSET,
      isLicensed: previous?.isLicensed ?? false,
      role: previous?.role ?? Protobuf.Config.Config_DeviceConfig_Role.CLIENT,
      publicKey: previous?.publicKey ?? new Uint8Array(),
    });
    await device.setOwner(user);
    this.owner = user;
    this.hooks.onNode({
      num: myNum,
      longName: user.longName,
      shortName: user.shortName,
    });
    this.hooks.onLog({
      dir: "tx",
      kind: "Name",
      summary: `Set radio name to ${user.longName} (${user.shortName}).`,
      detail: { longName: user.longName, shortName: user.shortName },
    });
  }

  async reboot(): Promise<void> {
    const device = this.requireDevice();
    this.hooks.onLog({ dir: "tx", kind: "Reboot", summary: "Rebooting the radio.", detail: {} });
    await device.reboot(3);
  }

  requestPosition(num: number): void {
    const device = this.requireDevice();
    const who = nodeName(this.hooks.getNodes(), num, this.hooks.getMyNum());
    this.hooks.onLog({ dir: "tx", kind: "Position", summary: `Asked ${who} for a location.`, detail: { num } });
    void device.requestPosition(num).catch((error: unknown) => {
      this.hooks.onBanner("error", error instanceof Error ? error.message : `${who} did not answer the location request.`);
    });
  }

  traceRoute(num: number): void {
    const device = this.requireDevice();
    const who = nodeName(this.hooks.getNodes(), num, this.hooks.getMyNum());
    this.hooks.onLog({
      dir: "tx",
      kind: "Traceroute",
      summary: `Tracing the path to ${who}.`,
      detail: { num },
    });
    void device.traceRoute(num).catch((error: unknown) => {
      this.hooks.onBanner("error", error instanceof Error ? error.message : `No path to ${who}.`);
    });
  }

  private requireDevice(): MeshDevice {
    if (!this.device) throw new Error("Connect the radio first.");
    return this.device;
  }

  private bind(device: MeshDevice): void {
    const { events } = device;
    this.listen(events.onDeviceStatus, (status) => this.onStatus(status));
    this.listen(events.onMyNodeInfo, (info) => this.hooks.onMyNode(info.myNodeNum));
    this.listen(events.onFromRadio, (message) => this.onFromRadio(message));
    this.listen(events.onMeshPacket, (packet) => this.onMeshPacket(packet));
    this.listen(events.onMessagePacket, (packet) => this.onText(packet));
    this.listen(events.onNodeInfoPacket, (info) => this.onNodeInfo(info));
    this.listen(events.onUserPacket, (packet) => this.onUser(packet));
    this.listen(events.onPositionPacket, (packet) => this.onPosition(packet));
    this.listen(events.onChannelPacket, (channel) => this.onChannel(channel));
    this.listen(events.onConfigPacket, (config) => this.onConfig(config));
    this.listen(events.onRoutingPacket, (packet) => this.onRouting(packet));
    this.listen(events.onTraceRoutePacket, (packet) => this.onTrace(packet));
    this.listen(events.onTelemetryPacket, (packet) => this.onTelemetry(packet));
    this.listen(events.onDeviceMetadataPacket, (packet) => {
      this.hooks.onRadio({ firmware: packet.data.firmwareVersion });
    });
  }

  private listen(dispatcher: { subscribe: (fn: (value: any) => void) => () => void }, handler: (value: any) => void): void {
    this.unsubs.push(
      dispatcher.subscribe((value) => {
        try {
          handler(value);
        } catch (error) {
          console.error(error);
        }
      }),
    );
  }

  private drop(): void {
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.device = null;
    this.owner = null;
    this.lastMesh = null;
  }

  private onStatus(status: number): void {
    if (status === 6 || status === 5) {
      this.hooks.onStatus("configuring", "Loading nodes and channels");
      return;
    }
    if (status === 7) {
      this.retryDelay = 1000;
      this.hooks.onStatus("connected", "Radio live");
      return;
    }
    if (status === 4 || status === 3) {
      this.hooks.onStatus("connecting", "Reconnecting");
      return;
    }
    if (status === 2) {
      const paused = this.userPaused;
      this.drop();
      if (paused) {
        this.hooks.onStatus("disconnected", "Not connected");
        return;
      }
      this.scheduleRetry("The Bluetooth link closed.");
    }
  }

  private onFromRadio(message: Protobuf.Mesh.FromRadio): void {
    const described = describeFromRadio(message, this.hooks.getNodes(), this.hooks.getMyNum());
    this.hooks.onLog({
      dir: "rx",
      kind: described.kind,
      summary: described.summary,
      detail: toDetail(message),
    });
  }

  private onMeshPacket(packet: Protobuf.Mesh.MeshPacket): void {
    this.lastMesh = packet;
    if (packet.from === this.hooks.getMyNum() || packet.from === 0 || packet.viaMqtt) return;
    const port = packet.payloadVariant.case === "decoded" ? packet.payloadVariant.value.portnum : undefined;
    if (port === PORT.POSITION_APP || port === PORT.ROUTING_APP || port === PORT.TRACEROUTE_APP) return;
    this.paintHeard(packet, portLabel(port));
  }

  private onText(packet: Meta<string>): void {
    const mine = packet.from === this.hooks.getMyNum();
    const rf = this.lastMesh && this.lastMesh.id === packet.id ? readRf(this.lastMesh) : { hops: null };
    this.hooks.onMessage({
      id: crypto.randomUUID(),
      packetId: packet.id,
      from: packet.from,
      to: packet.to,
      channel: packet.channel,
      direct: packet.type === "direct",
      text: packet.data,
      time: packet.rxTime.getTime() > 0 ? packet.rxTime.getTime() : Date.now(),
      outgoing: mine,
      delivery: mine ? "pending" : "received",
      snr: mine ? undefined : rf.snr,
      rssi: mine ? undefined : rf.rssi,
      hops: mine ? null : (rf.hops ?? null),
    });
    if (mine) {
      this.hooks.onLog({
        dir: "tx",
        kind: "Text",
        summary: `You sent: ${clip(packet.data)}`,
        detail: toDetail(packet),
      });
    }
  }

  private onNodeInfo(info: Protobuf.Mesh.NodeInfo): void {
    const user = info.user;
    this.hooks.onNode({
      num: info.num,
      longName: user?.longName || undefined,
      shortName: user?.shortName || undefined,
      hwModel: user ? enumLabel(Protobuf.Mesh.HardwareModel, user.hwModel) : undefined,
      snr: info.snr,
      hopsAway: info.hopsAway,
      lastHeard: info.lastHeard ? info.lastHeard * 1000 : undefined,
      battery: info.deviceMetrics?.batteryLevel,
      voltage: info.deviceMetrics?.voltage,
      channel: info.channel,
      viaMqtt: info.viaMqtt,
    });
    if (info.num === this.hooks.getMyNum() && user) this.owner = user;
  }

  private onUser(packet: Meta<Protobuf.Mesh.User>): void {
    this.hooks.onNode({
      num: packet.from,
      longName: packet.data.longName || undefined,
      shortName: packet.data.shortName || undefined,
      hwModel: enumLabel(Protobuf.Mesh.HardwareModel, packet.data.hwModel),
    });
    if (packet.from === this.hooks.getMyNum() || packet.from === 0) this.owner = packet.data;
  }

  private onPosition(packet: Meta<Protobuf.Mesh.Position>): void {
    const point = positionDegrees(packet.data.latitudeI, packet.data.longitudeI);
    if (point) {
      this.hooks.onNode({
        num: packet.from,
        lat: point.lat,
        lng: point.lng,
        altitude: packet.data.altitude,
      });
    }
    const node = this.hooks.getNodes().find((item) => item.num === packet.from);
    if (!point || node?.viaMqtt) return;
    const mesh = this.lastMesh && this.lastMesh.id === packet.id ? this.lastMesh : null;
    if (mesh?.viaMqtt) return;
    this.markVisited([point]);
  }

  private onChannel(channel: Protobuf.Channel.Channel): void {
    const role =
      channel.role === Protobuf.Channel.Channel_Role.PRIMARY
        ? "primary"
        : channel.role === Protobuf.Channel.Channel_Role.SECONDARY
          ? "secondary"
          : "disabled";
    const name = channel.settings?.name?.trim() || (role === "primary" ? "Primary" : `Channel ${channel.index}`);
    this.hooks.onChannel({
      index: channel.index,
      role,
      name,
      pskBase64: channel.settings?.psk?.length ? bytesToBase64(channel.settings.psk) : "",
    });
  }

  private onConfig(config: Protobuf.Config.Config): void {
    if (config.payloadVariant.case !== "lora") return;
    const lora = config.payloadVariant.value;
    this.hooks.onRadio({
      region: enumLabel(Protobuf.Config.Config_LoRaConfig_RegionCode, lora.region),
      modemPreset: enumLabel(Protobuf.Config.Config_LoRaConfig_ModemPreset, lora.modemPreset),
      hopLimit: lora.hopLimit,
      txPower: lora.txPower,
      channelNum: lora.channelNum,
    });
  }

  private onRouting(packet: Meta<Protobuf.Mesh.Routing>): void {
    const mesh = this.lastMesh;
    const requestId =
      mesh?.payloadVariant.case === "decoded" && mesh.payloadVariant.value.requestId
        ? mesh.payloadVariant.value.requestId
        : (mesh?.id ?? packet.id);
    if (packet.data.variant.case !== "errorReason") return;
    const reason = packet.data.variant.value;
    if (reason !== Protobuf.Mesh.Routing_Error.NONE) {
      this.handledFailures.add(requestId);
      this.hooks.onDelivery(requestId, "failed", { detail: routingLabel(reason) });
      return;
    }
    const hops = mesh ? hopsFromPacket(mesh) : null;
    const delivery: DeliveryState = hops != null && hops >= 1 ? "hit-mesh" : "hit-node";
    const detail =
      hops != null && hops >= 2
        ? `Traveled the mesh, ${hops} hops`
        : hops === 1
          ? "A node relayed this"
          : "Reached a node";
    this.hooks.onDelivery(requestId, delivery, {
      detail,
      hops,
      snr: mesh?.rxSnr,
      rssi: mesh && mesh.rxRssi !== 0 ? mesh.rxRssi : undefined,
    });
  }

  private onTrace(packet: Meta<Protobuf.Mesh.RouteDiscovery>): void {
    const route = [...packet.data.route, ...packet.data.routeBack];
    const points = route
      .map((num) => this.pointFor(num))
      .filter((point): point is { lat: number; lng: number } => point != null);
    const self = this.selfPoint();
    if (self) points.push(self);
    this.markVisited(points);
  }

  private onTelemetry(packet: Meta<Protobuf.Telemetry.Telemetry>): void {
    if (packet.data.variant.case !== "deviceMetrics") return;
    this.hooks.onNode({
      num: packet.from,
      battery: packet.data.variant.value.batteryLevel,
      voltage: packet.data.variant.value.voltage,
    });
  }

  private paintHeard(packet: Protobuf.Mesh.MeshPacket, label: string): void {
    const hops = hopsFromPacket(packet);
    this.hooks.onNode({
      num: packet.from,
      hopsAway: hops != null ? hops : undefined,
      snr: packet.rxSnr,
      rssi: packet.rxRssi !== 0 ? packet.rxRssi : undefined,
      lastHeard: Date.now(),
    });
    this.observe(
      packet.from,
      "rx",
      hops,
      packet.rxSnr,
      packet.rxRssi !== 0 ? packet.rxRssi : undefined,
      heardNote(this.who(packet.from), hops, label),
      true,
      label,
      messageText(packet),
    );
  }

  private markVisited(points: { lat: number; lng: number }[]): void {
    if (points.length === 0) return;
    this.hooks.onObservation({
      points,
      hops: null,
      dir: "rx",
      visit: true,
      note: "Been here",
      time: Date.now(),
    });
  }

  private observe(
    remote: number | null,
    dir: "rx" | "tx",
    hops: number | null,
    snr: number | undefined,
    rssi: number | undefined,
    note: string,
    includeSelf = true,
    label = "Packet",
    text?: string,
  ): void {
    const message = Boolean(text) || label === "Text";
    if (remote != null) {
      const point = this.pointFor(remote);
      if (point) this.markVisited([point]);
    }
    if (!includeSelf) return;
    const self = this.selfPoint();
    if (!self) return;
    if (!message) {
      this.markVisited([self]);
      return;
    }
    const event =
      remote != null && remote !== this.hooks.getMyNum()
        ? { time: Date.now(), num: remote, hops, label, text: text ? clip(text) : undefined }
        : undefined;
    const heard = remote != null && remote !== this.hooks.getMyNum() ? [remote] : undefined;
    this.hooks.onObservation({
      points: [{ ...self, heard, event }],
      snr,
      rssi,
      hops,
      dir,
      contact: true,
      note,
      time: Date.now(),
    });
  }

  private pointFor(num: number): { lat: number; lng: number } | null {
    const node = this.hooks.getNodes().find((item) => item.num === num);
    if (node?.lat == null || node.lng == null) return null;
    return { lat: node.lat, lng: node.lng };
  }

  private selfPoint(): { lat: number; lng: number } | null {
    return this.hooks.getSelfPoint() ?? this.pointFor(this.hooks.getMyNum());
  }

  private who(num: number): string {
    return nodeName(this.hooks.getNodes(), num, this.hooks.getMyNum());
  }
}

function messageText(packet: Protobuf.Mesh.MeshPacket): string | undefined {
  if (packet.payloadVariant.case !== "decoded") return undefined;
  const data = packet.payloadVariant.value;
  if (data.portnum !== PORT.TEXT_MESSAGE_APP || data.payload.length === 0) return undefined;
  return new TextDecoder().decode(data.payload);
}

function heardNote(name: string, hops: number | null, label = "Packet"): string {
  if (hops != null && hops >= 2) return `${label} from ${name} traveled ${hops} hops.`;
  if (hops === 1) return `${label} from ${name} was relayed once.`;
  if (hops === 0) return `${label} from ${name} was direct.`;
  return `${label} from ${name}. Hop count was not reported.`;
}

function nodeIdFrom(num: number): string {
  return "!" + (num >>> 0).toString(16).padStart(8, "0");
}

function hopsFromPacket(packet: Protobuf.Mesh.MeshPacket): number | null {
  if (packet.hopStart > 0) return Math.max(0, packet.hopStart - packet.hopLimit);
  return null;
}

function readRf(packet: Protobuf.Mesh.MeshPacket): { snr?: number; rssi?: number; hops: number | null } {
  return {
    snr: packet.rxSnr,
    rssi: packet.rxRssi !== 0 ? packet.rxRssi : undefined,
    hops: hopsFromPacket(packet),
  };
}

function portLabel(port: number | undefined): string {
  if (port == null) return "Encrypted packet";
  if (port === PORT.TEXT_MESSAGE_APP) return "Text";
  if (port === PORT.POSITION_APP) return "Position";
  if (port === PORT.NODEINFO_APP) return "Node info";
  if (port === PORT.TELEMETRY_APP) return "Telemetry";
  if (port === PORT.NEIGHBORINFO_APP) return "Neighbors";
  if (port === PORT.ADMIN_APP) return "Admin";
  return enumLabel(PORT, port) ?? "Packet";
}

function describeFromRadio(
  message: Protobuf.Mesh.FromRadio,
  nodes: NodeRecord[],
  myNum: number,
): { kind: string; summary: string } {
  const variant = message.payloadVariant;
  switch (variant.case) {
    case "packet":
      return describeMesh(variant.value, nodes, myNum);
    case "myInfo":
      return { kind: "Radio", summary: `This radio is ${nodeIdFrom(variant.value.myNodeNum)}.` };
    case "nodeInfo": {
      const who = variant.value.user?.longName || nodeName(nodes, variant.value.num, myNum);
      return { kind: "Node", summary: `Node record for ${who}.` };
    }
    case "config":
      return { kind: "Config", summary: `Config: ${variant.value.payloadVariant.case ?? "unknown"}.` };
    case "moduleConfig":
      return { kind: "Config", summary: `Module: ${variant.value.payloadVariant.case ?? "unknown"}.` };
    case "channel": {
      const name = variant.value.settings?.name || `Channel ${variant.value.index}`;
      return { kind: "Channel", summary: `Channel ${variant.value.index}: ${name}.` };
    }
    case "logRecord":
      return { kind: "Device log", summary: variant.value.message || "Device log." };
    case "configCompleteId":
      return { kind: "Radio", summary: "Radio finished sending its setup." };
    case "metadata":
      return { kind: "Radio", summary: `Firmware ${variant.value.firmwareVersion}.` };
    case "clientNotification":
      return { kind: "Notice", summary: variant.value.message || "Notice from the radio." };
    case "queueStatus":
      return { kind: "Queue", summary: "Transmit queue updated." };
    case "rebooted":
      return { kind: "Radio", summary: "Radio rebooted." };
    default:
      return { kind: variant.case ?? "Event", summary: variant.case ?? "Radio event." };
  }
}

function describeMesh(
  packet: Protobuf.Mesh.MeshPacket,
  nodes: NodeRecord[],
  myNum: number,
): { kind: string; summary: string } {
  const who = nodeName(nodes, packet.from, myNum);
  const dest = nodeName(nodes, packet.to, myNum);
  const hops = hopsFromPacket(packet);
  const hopText = hops == null ? "" : hops <= 0 ? " · direct" : ` · ${hops} hop${hops === 1 ? "" : "s"}`;
  const snrText = packet.rxSnr ? ` · SNR ${packet.rxSnr.toFixed(1)} dB` : "";
  if (packet.payloadVariant.case === "encrypted") {
    return { kind: "Encrypted", summary: `Encrypted packet from ${who} to ${dest}${hopText}${snrText}.` };
  }
  if (packet.payloadVariant.case !== "decoded") {
    return { kind: "Packet", summary: `Packet from ${who} to ${dest}${hopText}${snrText}.` };
  }
  const decoded = packet.payloadVariant.value;
  const kind = portLabel(decoded.portnum);
  if (decoded.portnum === PORT.TEXT_MESSAGE_APP) {
    const text = new TextDecoder().decode(decoded.payload);
    return { kind: "Text", summary: `${who} → ${dest}: ${clip(text)}${hopText}${snrText}` };
  }
  return { kind, summary: `${kind} from ${who} to ${dest}${hopText}${snrText}.` };
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}

function routingLabel(error: number): string {
  switch (error) {
    case Protobuf.Mesh.Routing_Error.NONE:
      return "Acknowledged";
    case Protobuf.Mesh.Routing_Error.TIMEOUT:
    case Protobuf.Mesh.Routing_Error.NO_RESPONSE:
      return "No node answered";
    case Protobuf.Mesh.Routing_Error.NO_ROUTE:
      return "No route to that node";
    case Protobuf.Mesh.Routing_Error.DUTY_CYCLE_LIMIT:
      return "Radio paused to stay within airtime limits";
    case Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT:
      return "Gave up after several tries";
    case Protobuf.Mesh.Routing_Error.NO_CHANNEL:
      return "That channel is not set up";
    case Protobuf.Mesh.Routing_Error.TOO_LARGE:
      return "Message is too big for the radio";
    default:
      return enumLabel(Protobuf.Mesh.Routing_Error, error) ?? "The radio rejected the packet";
  }
}

function asPacketError(error: unknown): { id: number; error: number } | null {
  if (!error || typeof error !== "object" || !("id" in error) || !("error" in error)) return null;
  const id = error.id;
  const reason = error.error;
  if (typeof id !== "number" || typeof reason !== "number") return null;
  return { id, error: reason };
}

function readSavedRadio(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem("mesh.radioDevice");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { id?: unknown; name?: unknown };
    if (typeof record.id !== "string" || !record.id) return null;
    return { id: record.id, name: typeof record.name === "string" && record.name ? record.name : "Radio" };
  } catch {
    return null;
  }
}

function bleMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotFoundError") return "No radio was selected.";
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Bluetooth permission was blocked.";
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "Bluetooth needs Chrome or Edge on this computer.";
  }
  return error instanceof Error ? error.message : "Could not connect to the radio.";
}

function decodeShare(input: string): { name: string; psk: Uint8Array }[] | null {
  const trimmed = input.trim();
  if (!trimmed || !/meshtastic\.org|#|https?:/i.test(trimmed)) return null;
  const hash = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
  try {
    const decoded = fromBinary(Protobuf.AppOnly.ChannelSetSchema, base64ToBytes(hash));
    if (decoded.settings.length === 0) throw new Error("empty");
    return decoded.settings.map((settings: { name?: string; psk: Uint8Array }, index: number) => ({
      name: settings.name || (index === 0 ? "Shared" : `Shared ${index}`),
      psk: settings.psk,
    }));
  } catch {
    throw new Error("That share link could not be read. Paste the channel key instead.");
  }
}

function nextIndex(taken: Set<number>): number | null {
  for (let index = 1; index <= 7; index += 1) {
    if (!taken.has(index)) return index;
  }
  return null;
}

function channelIndexesFrom(channels: ChannelRecord[]): Set<number> {
  return new Set(channels.filter((channel) => channel.role !== "disabled").map((channel) => channel.index));
}
