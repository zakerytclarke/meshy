import { useState } from "react";
import { MapPane } from "./components/MapPane";
import { Logs } from "./components/Logs";
import { Messages } from "./components/Messages";
import { Radio } from "./components/Radio";
import { TabBar } from "./components/TabBar";
import { useMesh } from "./state/MeshProvider";

export function App() {
  const mesh = useMesh();
  const [mapSeen, setMapSeen] = useState(false);
  if (mesh.tab === "map" && !mapSeen) setMapSeen(true);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`dot ${mesh.status}`} />
          <strong>Meshy</strong>
        </div>
        {mesh.status === "connected" ? (
          <button className="status-pill live" onClick={() => mesh.setTab("radio")}>
            Live
          </button>
        ) : (
          <button className="status-pill" onClick={() => mesh.connect()} disabled={mesh.status === "connecting" || mesh.status === "configuring"}>
            {mesh.status === "disconnected" ? "Connect radio" : mesh.statusDetail}
          </button>
        )}
      </header>
      {mesh.banner ? (
        <div className={`banner ${mesh.banner.tone}`}>
          <p>{mesh.banner.text}</p>
          <button onClick={mesh.dismissBanner}>Dismiss</button>
        </div>
      ) : null}
      <div className="stage">
        <div className="pane" hidden={mesh.tab !== "messages"}>
          <Messages />
        </div>
        <div className="pane" hidden={mesh.tab !== "map"}>
          {mapSeen ? <MapPane active={mesh.tab === "map"} /> : null}
        </div>
        <div className="pane" hidden={mesh.tab !== "logs"}>
          <Logs />
        </div>
        <div className="pane" hidden={mesh.tab !== "radio"}>
          <Radio />
        </div>
      </div>
      <TabBar />
    </div>
  );
}
