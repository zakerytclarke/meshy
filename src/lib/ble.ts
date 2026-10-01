import { Types } from "@meshtastic/core";

/**
 * Web Bluetooth link for a Meshtastic radio.
 *
 * Android Chrome drops the connection when a read and a write overlap, and
 * when the node database is pulled in one tight loop. Reads and writes take
 * turns, each packet is copied off the radio's buffer, and a busy radio is
 * retried instead of treated as a dead link.
 */

const Status = Types.DeviceStatusEnum;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function copyView(view: DataView): Uint8Array {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return bytes;
}

function gattBusy(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /already in progress/i.test(message);
}

export class RadioBluetooth {
  static readonly ToRadioUuid = "f75c76d2-129e-4dad-a1dd-7866124401e7";
  static readonly FromRadioUuid = "2c55e69e-4993-11ed-b878-0242ac120002";
  static readonly FromNumUuid = "ed9da18c-a800-4f66-a670-aa7547e34453";
  static readonly ServiceUuid = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

  private readonly fromDevice: ReadableStream<Types.DeviceOutput>;
  private readonly toDevice: WritableStream<Uint8Array>;
  private fromDeviceController?: ReadableStreamDefaultController<Types.DeviceOutput>;
  private lastStatus = Status.DeviceDisconnected;
  private closingByUser = false;
  /** Last FromNum we have already caught up with. An extra FromRadio read blocks the radio for ~20s. */
  private lastFromNum: number | null = null;
  private pumping = false;
  private wakePump: (() => void) | null = null;
  private dead = false;
  private busyRetries = 0;
  /** Why the link closed, when this side noticed it. */
  dropReason = "";
  private turn: Promise<void> = Promise.resolve();

  static async createFromDevice(device: BluetoothDevice): Promise<RadioBluetooth> {
    const server = await device.gatt?.connect();
    if (!server) throw new Error("The radio did not open a Bluetooth connection.");
    const service = await server.getPrimaryService(RadioBluetooth.ServiceUuid);
    const toRadio = await service.getCharacteristic(RadioBluetooth.ToRadioUuid);
    const fromRadio = await service.getCharacteristic(RadioBluetooth.FromRadioUuid);
    const fromNum = await service.getCharacteristic(RadioBluetooth.FromNumUuid);
    return new RadioBluetooth(toRadio, fromRadio, fromNum, server);
  }

  constructor(
    private readonly toRadioCharacteristic: BluetoothRemoteGATTCharacteristic,
    private readonly fromRadioCharacteristic: BluetoothRemoteGATTCharacteristic,
    private readonly fromNumCharacteristic: BluetoothRemoteGATTCharacteristic,
    private readonly gattServer: BluetoothRemoteGATTServer,
  ) {
    this.fromDevice = new ReadableStream({
      start: async (controller) => {
        this.fromDeviceController = controller;
        this.emitStatus(Status.DeviceConnecting);
        this.gattServer.device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
        try {
          this.fromNumCharacteristic.addEventListener("characteristicvaluechanged", this.onFromNumChanged);
          await this.fromNumCharacteristic.startNotifications();
          this.emitStatus(Status.DeviceConnected);
          void this.pump();
        } catch {
          this.noteDrop("notify-failed");
          this.dead = true;
          this.emitStatus(Status.DeviceDisconnected, "notify-failed");
          this.gattServer.device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
          try {
            this.gattServer.disconnect();
          } catch {
            /* Already closed. */
          }
        }
      },
    });
    this.toDevice = new WritableStream({
      write: async (chunk) => {
        try {
          await this.runTurn(() => this.writeRadio(chunk));
          this.wakePump?.();
        } catch (error) {
          // A failed write is not a reason to disconnect. Android drops the
          // next connect for minutes if we close the link while a call is still running.
          if (!this.gattServer.connected && !this.closingByUser) {
            this.noteDrop("write-error");
            this.dead = true;
            this.emitStatus(Status.DeviceDisconnected, "write-error");
          }
          throw error;
        }
      },
    });
  }

  get toDeviceStream(): WritableStream<Uint8Array> {
    return this.toDevice;
  }

  get fromDeviceStream(): ReadableStream<Types.DeviceOutput> {
    return this.fromDevice;
  }

  disconnect(): Promise<void> {
    try {
      this.closingByUser = true;
      this.dead = true;
      this.emitStatus(Status.DeviceDisconnected, "user");
      try {
        void this.fromNumCharacteristic.stopNotifications?.();
      } catch {
        /* The radio may already be gone. */
      }
      this.fromNumCharacteristic.removeEventListener("characteristicvaluechanged", this.onFromNumChanged);
      this.gattServer.device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
      this.gattServer.disconnect();
    } finally {
      this.closingByUser = false;
    }
    return Promise.resolve();
  }

  private onGattDisconnected = (): void => {
    if (this.closingByUser) return;
    this.noteDrop("gatt-disconnected");
    this.dead = true;
    this.emitStatus(Status.DeviceDisconnected, "gatt-disconnected");
  };

  private onFromNumChanged = (): void => {
    this.wakePump?.();
  };

  private runTurn<T>(op: () => Promise<T>): Promise<T> {
    const run = this.turn.then(op, op);
    this.turn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * FromNum is a counter, not a queue length. The radio only keeps 3 unread
   * packets, and reading when none are waiting blocks that radio for ~20s,
   * which also blocks the next send. Read only the new count, and never past it.
   */
  private async pump(): Promise<void> {
    if (this.pumping || this.closingByUser || this.dead) return;
    this.pumping = true;
    try {
      while (!this.closingByUser && !this.dead && this.gattServer.connected) {
        let num: number;
        try {
          const view = await this.runTurn(() => this.fromNumCharacteristic.readValue());
          this.busyRetries = 0;
          num = view.byteLength >= 4 ? view.getUint32(0, true) : (this.lastFromNum ?? 0);
        } catch (error) {
          if (this.closingByUser || this.dead) return;
          if (!this.gattServer.connected) {
            this.noteDrop("read-error");
            this.dead = true;
            this.emitStatus(Status.DeviceDisconnected, this.dropReason);
            return;
          }
          this.busyRetries += 1;
          await this.pause(Math.min(1000, gattBusy(error) ? 80 : 200 * this.busyRetries));
          continue;
        }
        if (this.lastFromNum === null) {
          this.lastFromNum = num;
          await this.pause(120);
          continue;
        }
        const gap = (num - this.lastFromNum) >>> 0;
        if (gap === 0) {
          await this.pause(120);
          continue;
        }
        const reads = Math.min(gap, 3);
        this.lastFromNum = num;
        for (let index = 0; index < reads && !this.closingByUser && !this.dead; index += 1) {
          try {
            const more = await this.pull();
            this.busyRetries = 0;
            if (!more) break;
          } catch (error) {
            if (this.closingByUser || this.dead) return;
            if (this.gattServer.connected) {
              this.busyRetries += 1;
              await this.pause(Math.min(1000, gattBusy(error) ? 80 : 200 * this.busyRetries));
              break;
            }
            this.noteDrop(error instanceof Error && error.message ? error.message : "read-error");
            this.dead = true;
            this.emitStatus(Status.DeviceDisconnected, this.dropReason);
            return;
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.wakePump = null;
        resolve();
      }, ms);
      this.wakePump = () => {
        window.clearTimeout(timer);
        this.wakePump = null;
        resolve();
      };
    });
  }

  /** Read one queued packet, then let a waiting write take a turn. */
  private async pull(): Promise<boolean> {
    const value = await this.runTurn(() => this.fromRadioCharacteristic.readValue());
    if (value.byteLength === 0) return false;
    this.enqueue({ type: "packet", data: copyView(value) });
    await wait(0);
    return true;
  }

  private async writeRadio(chunk: Uint8Array): Promise<void> {
    const bytes = toArrayBuffer(chunk);
    if (this.toRadioCharacteristic.properties.writeWithoutResponse) {
      await this.toRadioCharacteristic.writeValueWithoutResponse(bytes);
      return;
    }
    await this.toRadioCharacteristic.writeValue(bytes);
  }

  private noteDrop(reason: string): void {
    if (!this.dropReason) this.dropReason = reason;
  }

  private emitStatus(next: Types.DeviceStatusEnum, reason?: string): void {
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    this.fromDeviceController?.enqueue({ type: "status", data: { status: next, reason } });
  }

  private enqueue(output: Types.DeviceOutput): void {
    this.fromDeviceController?.enqueue(output);
  }
}

/** What MeshDevice reads off a transport. */
export function asMeshTransport(link: RadioBluetooth): {
  toDevice: WritableStream<Uint8Array>;
  fromDevice: ReadableStream<Types.DeviceOutput>;
  disconnect: () => Promise<void>;
} {
  return {
    toDevice: link.toDeviceStream,
    fromDevice: link.fromDeviceStream,
    disconnect: () => link.disconnect(),
  };
}
