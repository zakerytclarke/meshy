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
const ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

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
  return /in progress|GATT operation/i.test(message);
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
  private reading = false;
  private needsRead = false;
  private dead = false;
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
          await this.fromNumCharacteristic.startNotifications();
          this.fromNumCharacteristic.addEventListener("characteristicvaluechanged", this.onFromNumChanged);
          this.emitStatus(Status.DeviceConnected);
          void this.readFromRadio();
        } catch {
          this.emitStatus(Status.DeviceDisconnected, "notify-failed");
          this.gattServer.device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
        }
      },
    });
    this.toDevice = new WritableStream({
      write: async (chunk) => {
        try {
          await this.runTurn(async () => {
            await this.toRadioCharacteristic.writeValue(toArrayBuffer(chunk));
          });
          this.needsRead = true;
          void this.readFromRadio();
        } catch (error) {
          if (!this.closingByUser) {
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
    this.dead = true;
    this.emitStatus(Status.DeviceDisconnected, "gatt-disconnected");
  };

  private onFromNumChanged = (): void => {
    this.needsRead = true;
    void this.readFromRadio();
  };

  private runTurn<T>(op: () => Promise<T>): Promise<T> {
    const run = this.turn.then(op, op);
    this.turn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFromRadio(): Promise<void> {
    if (this.reading || this.closingByUser || this.dead) return;
    this.reading = true;
    try {
      while (!this.closingByUser) {
        this.needsRead = false;
        try {
          await this.runTurn(() => this.drain());
        } catch (error) {
          if (this.closingByUser) return;
          if (gattBusy(error)) {
            await wait(40);
            this.needsRead = true;
            continue;
          }
          this.dead = true;
          this.emitStatus(Status.DeviceDisconnected, "read-error");
          return;
        }
        if (!this.needsRead) return;
      }
    } finally {
      this.reading = false;
      if (this.needsRead && !this.closingByUser && !this.dead) void this.readFromRadio();
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const value = await this.fromRadioCharacteristic.readValue();
      if (value.byteLength === 0) return;
      this.enqueue({ type: "packet", data: copyView(value) });
      await wait(ANDROID ? 12 : 0);
    }
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
