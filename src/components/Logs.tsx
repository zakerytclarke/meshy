import { useMemo, useState } from "react";
import { formatClock } from "../lib/format";
import { useMesh } from "../state/MeshProvider";
import type { LogEntry } from "../types";

type DirFilter = "all" | LogEntry["dir"];

const NOISE = new Set(["Radio", "Node", "Config", "Channel", "Device log", "Queue", "Notice", "Connect", "Name", "Reboot"]);

function isPacket(entry: LogEntry): boolean {
  if (entry.dir === "sys" || NOISE.has(entry.kind)) return false;
  if (entry.kind === "Position" && entry.summary.startsWith("Asked ")) return false;
  if (entry.kind === "Traceroute" && entry.summary.startsWith("Tracing ")) return false;
  return true;
}

export function Logs() {
  const mesh = useMesh();
  const [query, setQuery] = useState("");
  const [dir, setDir] = useState<DirFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [armed, setArmed] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mesh.logs.filter((entry) => {
      if (!isPacket(entry)) return false;
      if (dir !== "all" && entry.dir !== dir) return false;
      if (!needle) return true;
      return `${entry.kind} ${entry.summary}`.toLowerCase().includes(needle);
    });
  }, [mesh.logs, query, dir]);

  const shown = filtered.slice(0, limit);

  return (
    <section className="logs">
      <header className="page-head">
        <div>
          <h2>Log</h2>
          <p>Every packet this browser receives or sends. Saved on this device.</p>
        </div>
        <button
          className={armed ? "danger" : "ghost"}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              window.setTimeout(() => setArmed(false), 3000);
              return;
            }
            mesh.clearLogs();
            setArmed(false);
          }}
        >
          {armed ? "Confirm clear" : "Clear log"}
        </button>
      </header>
      <div className="log-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the log" />
        <div className="filters" role="tablist">
          {(["all", "rx", "tx"] as const).map((item) => (
            <button key={item} className={dir === item ? "chip current" : "chip"} onClick={() => setDir(item)}>
              {item === "all" ? "All" : item === "rx" ? "Received" : "Sent"}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="empty-block">Nothing recorded yet. Connect the radio and this list fills with live traffic.</p>
      ) : (
        <ol className="log-list">
          {shown.map((entry) => {
            const open = openId === entry.id;
            return (
              <li key={entry.id}>
                <button className="log-row" onClick={() => setOpenId(open ? null : entry.id)}>
                  <time>{formatClock(entry.time)}</time>
                  <span className={`dir ${entry.dir}`}>{entry.dir}</span>
                  <span className="kind">{entry.kind}</span>
                  <span className="summary">{entry.summary}</span>
                </button>
                {open ? <pre>{JSON.stringify(entry.detail, null, 2)}</pre> : null}
              </li>
            );
          })}
        </ol>
      )}
      {filtered.length > shown.length ? (
        <button className="ghost more" onClick={() => setLimit((value) => value + 200)}>
          Show older events
        </button>
      ) : null}
    </section>
  );
}
