import { useState } from "react";
import { formatAgo, nodeId } from "../lib/format";
import { useMesh } from "../state/MeshProvider";

export function Radio() {
  const mesh = useMesh();
  const me = mesh.nodes.find((node) => node.num === mesh.myNodeNum);
  const [armed, setArmed] = useState<"coverage" | "chats" | "reboot" | null>(null);

  function arm(kind: "coverage" | "chats" | "reboot") {
    if (armed === kind) {
      if (kind === "coverage") mesh.clearCoverage();
      if (kind === "chats") mesh.clearChats();
      if (kind === "reboot") void mesh.reboot();
      setArmed(null);
      return;
    }
    setArmed(kind);
    window.setTimeout(() => setArmed((current) => (current === kind ? null : current)), 3000);
  }

  return (
    <section className="radio-page">
      <header className="page-head">
        <div>
          <h2>Radio</h2>
          <p>Connection and settings for the LoRa radio.</p>
        </div>
      </header>

      <article className="card connect-card">
        <div>
          <span className={`live ${mesh.status}`}>{statusLabel(mesh.status)}</span>
          <h3>{mesh.status === "connected" ? me?.longName || "Radio connected" : "Connect your radio"}</h3>
          <p>
            {mesh.bluetoothAvailable
              ? mesh.radioName
                ? `Stays paired with ${mesh.radioName}. It reconnects when you reopen the page or the link drops.`
                : "Uses Bluetooth. Keep the radio on and nearby, then pick it from the browser list."
              : "This browser can't open Bluetooth. Use Chrome or Edge on this computer."}
          </p>
        </div>
        {mesh.status === "connected" ? (
          <button className="ghost" onClick={() => void mesh.disconnect()}>
            Disconnect
          </button>
        ) : (
          <div className="row-actions">
            <button className="primary large" onClick={() => mesh.connect()} disabled={mesh.status === "configuring" || !mesh.bluetoothAvailable}>
              {mesh.status === "connecting" || mesh.status === "configuring"
                ? mesh.statusDetail
                : mesh.radioName
                  ? `Reconnect ${mesh.radioName}`
                  : "Connect radio"}
            </button>
            {mesh.radioName ? (
              <button className="ghost" onClick={() => mesh.connect(true)} disabled={mesh.status === "connecting" || mesh.status === "configuring"}>
                Different radio
              </button>
            ) : null}
          </div>
        )}
      </article>

      <article className="card">
        <h3>This radio</h3>
        {me ? (
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{me.longName}</dd>
            </div>
            <div>
              <dt>Short name</dt>
              <dd>{me.shortName}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{nodeId(me.num)}</dd>
            </div>
            <div>
              <dt>Last heard</dt>
              <dd>{formatAgo(me.lastHeard)}</dd>
            </div>
            {me.battery != null ? (
              <div>
                <dt>Battery</dt>
                <dd>{me.battery > 100 ? "Powered" : `${me.battery}%`}</dd>
              </div>
            ) : null}
            {mesh.radio.firmware ? (
              <div>
                <dt>Firmware</dt>
                <dd>{mesh.radio.firmware}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="empty-inline">Name, battery, and firmware show up after the radio connects.</p>
        )}
        <NameForm />
      </article>

      <article className="card">
        <h3>LoRa</h3>
        <dl className="facts">
          <Fact label="Region" value={mesh.radio.region} />
          <Fact label="Speed" value={mesh.radio.modemPreset} />
          <Fact label="Hop limit" value={mesh.radio.hopLimit != null ? String(mesh.radio.hopLimit) : undefined} />
          <Fact label="Power" value={mesh.radio.txPower != null ? `${mesh.radio.txPower} dBm` : undefined} />
          <Fact label="Frequency slot" value={mesh.radio.channelNum != null ? String(mesh.radio.channelNum) : undefined} />
        </dl>
      </article>

      <article className="card">
        <h3>Channels</h3>
        {mesh.channels.length === 0 ? <p className="empty-inline">The radio sends its channel list when it connects.</p> : null}
        <ul className="channel-list">
          {mesh.channels.map((channel) => (
            <li key={channel.index}>
              <div>
                <strong>{channel.name}</strong>
                <small>{channel.role === "primary" ? "Main channel" : `Extra · ${channel.index}`}</small>
                <code>{channel.pskBase64 || "No key"}</code>
              </div>
              <div className="row-actions">
                {channel.pskBase64 ? (
                  <button
                    className="text-button"
                    onClick={() => void navigator.clipboard.writeText(channel.pskBase64)}
                  >
                    Copy key
                  </button>
                ) : null}
                {channel.role !== "primary" ? (
                  <button className="text-button" onClick={() => void mesh.removeChannel(channel.index)} disabled={mesh.busy != null}>
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </article>

      <article className="card">
        <h3>Saved in this browser</h3>
        <p className="empty-inline">Messages, the signal map, and the full log stay on this device until you clear them.</p>
        <div className="row-actions wrap">
          <button className={armed === "chats" ? "danger" : "ghost"} onClick={() => arm("chats")}>
            {armed === "chats" ? "Confirm clear messages" : "Clear messages"}
          </button>
          <button className={armed === "coverage" ? "danger" : "ghost"} onClick={() => arm("coverage")}>
            {armed === "coverage" ? "Confirm clear map" : "Clear map squares"}
          </button>
          <button className={armed === "reboot" ? "danger" : "ghost"} onClick={() => arm("reboot")} disabled={mesh.status !== "connected"}>
            {armed === "reboot" ? "Confirm reboot" : "Reboot radio"}
          </button>
        </div>
      </article>
    </section>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function NameForm() {
  const mesh = useMesh();
  const me = mesh.nodes.find((node) => node.num === mesh.myNodeNum);
  const [longName, setLongName] = useState(me?.longName ?? "");
  const [shortName, setShortName] = useState(me?.shortName ?? "");
  const [seen, setSeen] = useState(me?.num ?? 0);
  if (me && seen !== me.num) {
    setSeen(me.num);
    setLongName(me.longName);
    setShortName(me.shortName);
  }
  return (
    <form
      className="name-form"
      onSubmit={(event) => {
        event.preventDefault();
        void mesh.saveName(longName, shortName);
      }}
    >
      <label>
        Long name
        <input value={longName} maxLength={36} onChange={(event) => setLongName(event.target.value)} />
      </label>
      <label>
        Short name
        <input value={shortName} maxLength={4} onChange={(event) => setShortName(event.target.value)} />
      </label>
      <button className="primary" type="submit" disabled={mesh.status !== "connected" || !longName.trim() || !shortName.trim() || mesh.busy != null}>
        {mesh.busy === "Saving name…" ? mesh.busy : "Save name"}
      </button>
    </form>
  );
}

function statusLabel(status: string): string {
  if (status === "connected") return "Live";
  if (status === "connecting") return "Connecting";
  if (status === "configuring") return "Starting";
  return "Off";
}
