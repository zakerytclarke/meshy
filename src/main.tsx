import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import { App } from "./App";
import { MeshProvider } from "./state/MeshProvider";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");

createRoot(container).render(
  <StrictMode>
    <MeshProvider>
      <App />
    </MeshProvider>
  </StrictMode>,
);
