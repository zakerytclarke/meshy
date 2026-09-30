import { useMemo, useRef, useState } from "react";
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
  const fileRef = useRef<HTMLInputElement>(null);

  function exportLogs() {
    const file = mesh.exportCoverage();
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "meshy-coverage.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importLogs(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      mesh.importCoverage(parsed);
    } catch {
      mesh.importCoverage(null);
    }
  }

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
          <p>Packets this browser sends and receives. Export leaves out message text, and an import adds to the map.</p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={exportLogs}>
            Export
          </button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importLogs(file);
            }}
          />
        </div>
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
