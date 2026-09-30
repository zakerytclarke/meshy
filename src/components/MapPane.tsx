import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { formatAgo, hopCount, nodeName, shortName, escapeHtml } from "../lib/format";
import { blockIndex, cellEdges, colorForScore, displayOrigin, displayStep, spanCorners } from "../lib/signal";
import { BROADCAST_NUM, type NodeRecord, type SignalCell } from "../types";
import { useMesh } from "../state/MeshProvider";

type ReachFilter = "all" | "node" | "mesh";

export function MapPane({ active }: { active: boolean }) {
  const mesh = useMesh();
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const gridRef = useRef<SignalGrid | null>(null);
  const cellsRef = useRef(mesh.cells);
  const filterRef = useRef<ReachFilter>("all");
  const selectedRef = useRef<{ lat: number; lng: number } | null>(null);
  const skipClick = useRef(false);
  const userMoved = useRef(false);
  const placedOn = useRef<{ map: L.Map | null; radio: boolean; browser: boolean }>({ map: null, radio: false, browser: false });
  const [selectedAt, setSelectedAt] = useState<{ lat: number; lng: number } | null>(null);
  const [zoom, setZoom] = useState(3);
  const [mapReady, setMapReady] = useState(false);
  cellsRef.current = mesh.cells;
  selectedRef.current = selectedAt;

  useEffect(() => {
    const element = host.current;
    if (!element || mapRef.current) return;
    const map = L.map(element, { zoomControl: false, attributionControl: true }).setView([20, 0], 3);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri, HERE, Garmin, OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    const grid = new SignalGrid(
      () => cellsRef.current,
      () => filterRef.current,
      () => selectedRef.current,
    );
    grid.addTo(map);
    map.on("zoomend", () => setZoom(map.getZoom()));
    map.on("dragstart", () => {
      userMoved.current = true;
    });
    map.on("click", (event) => {
      if (skipClick.current) {
        skipClick.current = false;
        return;
      }
      setSelectedAt({ lat: event.latlng.lat, lng: event.latlng.lng });
    });
    mapRef.current = map;
    gridRef.current = grid;
    setMapReady(true);
    return () => {
      map.remove();
      mapRef.current = null;
      gridRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const map = mapRef.current;
    if (!map) return;
    const refresh = () => map.invalidateSize();
    refresh();
    const frame = window.requestAnimationFrame(refresh);
    const timer = window.setTimeout(refresh, 250);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [active]);

  useEffect(() => {
    gridRef.current?.redraw();
  }, [mesh.cells, active, selectedAt, zoom]);

  const radioFix = mesh.nodes.find((node) => node.num === mesh.myNodeNum && node.lat != null && node.lng != null);
  const browserFix = mesh.browserFix;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || userMoved.current) return;
    if (placedOn.current.map !== map) placedOn.current = { map, radio: false, browser: false };
    if (radioFix?.lat != null && radioFix.lng != null && !placedOn.current.radio) {
      placedOn.current.radio = true;
      if (browserFix && movedMeters({ lat: radioFix.lat, lng: radioFix.lng }, browserFix) > 40) {
        map.fitBounds(L.latLngBounds([radioFix.lat, radioFix.lng], [browserFix.lat, browserFix.lng]), {
          padding: [72, 72],
          maxZoom: 17,
        });
      } else {
        map.setView([radioFix.lat, radioFix.lng], 16);
      }
      return;
    }
    if (!radioFix && browserFix && !placedOn.current.browser) {
      placedOn.current.browser = true;
      map.setView([browserFix.lat, browserFix.lng], 16);
    }
  }, [radioFix, browserFix, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const group = L.layerGroup().addTo(map);
    for (const node of mesh.nodes) {
      if (node.lat == null || node.lng == null) continue;
      const mine = node.num === mesh.myNodeNum;
      const icon = L.divIcon({
        className: "pin-wrap",
        html: `<span class="pin ${mine ? "mine" : ""} ${node.viaMqtt ? "mqtt" : ""}"><b>${escapeHtml(shortName(mesh.nodes, node.num, mesh.myNodeNum))}</b><small>${escapeHtml(hopCount(node.hopsAway, mine))}</small></span>`,
        iconSize: [64, 40],
        iconAnchor: [32, 20],
      });
      L.marker([node.lat, node.lng], { icon, interactive: false, keyboard: false }).addTo(group);
    }
    const radio = mesh.nodes.find((node) => node.num === mesh.myNodeNum && node.lat != null && node.lng != null);
    const browser = mesh.browserFix;
    const sameSpot =
      radio?.lat != null &&
      radio.lng != null &&
      browser != null &&
      movedMeters({ lat: radio.lat, lng: radio.lng }, browser) < 40;
    if (browser && !sameSpot) {
      const dot = L.circleMarker([browser.lat, browser.lng], {
        radius: 8,
        color: "#101410",
        weight: 2,
        fillColor: "#c6f54e",
        fillOpacity: 1,
        interactive: false,
      });
      if (browser.accuracy && browser.accuracy < 400) {
        L.circle([browser.lat, browser.lng], {
          radius: browser.accuracy,
          color: "#c6f54e",
          weight: 1,
          fillColor: "#c6f54e",
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(group);
      }
      dot.addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [mesh.nodes, mesh.myNodeNum, mesh.browserFix]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getPane("links")) {
      const pane = map.createPane("links");
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }
    const group = L.layerGroup().addTo(map);
    const here = herePoint(mesh.nodes, mesh.myNodeNum, mesh.browserFix);
    for (const link of recentLinks(mesh.messages, mesh.nodes, mesh.myNodeNum, here)) {
      L.polyline([link.from, link.to], {
        pane: "links",
        color: "#d6ff4a",
        weight: 3,
        opacity: 1,
        dashArray: "1.5 12",
        lineCap: "round",
        interactive: false,
        className: "link-flow",
      }).addTo(group);
      const head = pointAlong(link.from, link.to, 0.86);
      L.marker(head, {
        interactive: false,
        keyboard: false,
        pane: "links",
        icon: L.divIcon({
          className: "arrow-wrap",
          html: `<span class="arrow-head" style="transform:rotate(${bearing(link.from, link.to)}deg)"></span>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [mesh.messages, mesh.nodes, mesh.myNodeNum, mesh.browserFix, mapReady]);

  function centerOnMe() {
    const map = mapRef.current;
    if (!map) return;
    userMoved.current = false;
    if (radioFix?.lat != null && radioFix.lng != null) {
      if (browserFix && movedMeters({ lat: radioFix.lat, lng: radioFix.lng }, browserFix) > 40) {
        map.fitBounds(L.latLngBounds([radioFix.lat, radioFix.lng], [browserFix.lat, browserFix.lng]), {
          padding: [72, 72],
          maxZoom: 16,
        });
      } else {
        map.setView([radioFix.lat, radioFix.lng], Math.max(map.getZoom(), 16));
      }
      return;
    }
    if (browserFix) map.setView([browserFix.lat, browserFix.lng], Math.max(map.getZoom(), 16));
  }

  const square =
    selectedAt && mapRef.current
      ? describeSquare(selectedAt, mesh.cells, mesh.nodes, mesh.myNodeNum, mapRef.current.getZoom())
      : null;

  return (
    <div className="map-wrap">
      <div ref={host} className="map-canvas" />
      <div className="map-ui">
        <div className="map-actions">
          <button className="map-btn primary" onClick={centerOnMe}>
            Center on me
          </button>
        </div>
        {square ? <CellCard square={square} onClose={() => setSelectedAt(null)} /> : null}
      </div>
    </div>
  );
}

function CellCard({ square, onClose }: { square: SquareInfo; onClose: () => void }) {
  return (
    <article className="map-card">
      <header>
        <h3>{square.nodes.length > 0 ? "Nodes in this square" : "Nothing heard here"}</h3>
        <button className="text-button" onClick={onClose}>
          Close
        </button>
      </header>
      <p>{square.across}</p>
      {square.nodes.length === 0 ? <p>No GPS node is in this square, and no message was heard from here.</p> : null}
      {square.nodes.length > 0 ? (
        <div className="heard-list">
          {square.nodes.map((node) => (
            <div key={node.num}>
              <b>{node.mark}</b>
              <span>
                {node.name}
                <small>
                  {hopCount(node.hops, node.mine)}
                  {node.lastHeard ? ` · ${formatAgo(node.lastHeard)}` : ""}
                </small>
              </span>
              <i className={node.gps ? "fix gps" : "fix heard"}>{node.gps ? "GPS" : "Heard"}</i>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

class SignalGrid extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private mapRef: L.Map | null = null;

  constructor(
    private readonly getCells: () => Record<string, SignalCell>,
    private readonly getFilter: () => ReachFilter,
    private readonly getSelected: () => { lat: number; lng: number } | null,
  ) {
    super();
  }

  override onAdd(map: L.Map): this {
    this.mapRef = map;
    this.canvas = L.DomUtil.create("canvas", "signal-grid") as HTMLCanvasElement;
    this.canvas.style.pointerEvents = "none";
    map.getPanes().overlayPane?.appendChild(this.canvas);
    map.on("moveend zoomend viewreset resize", this.reset, this);
    this.reset();
    return this;
  }

  override onRemove(map: L.Map): this {
    map.off("moveend zoomend viewreset resize", this.reset, this);
    this.canvas?.remove();
    this.canvas = null;
    this.mapRef = null;
    return this;
  }

  redraw(): void {
    this.reset();
  }

  private reset = (): void => {
    const map = this.mapRef;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const bounds = map.getBounds().pad(0.35);
    const step = displayStep(map.getZoom());
    const northWest = blockIndex(bounds.getNorth(), bounds.getWest());
    const southEast = blockIndex(bounds.getSouth(), bounds.getEast());
    const x0 = displayOrigin(Math.min(northWest.x, southEast.x), 0, step).x;
    const x1 = displayOrigin(Math.max(northWest.x, southEast.x), 0, step).x;
    const y0 = displayOrigin(0, Math.min(northWest.y, southEast.y), step).y;
    const y1 = displayOrigin(0, Math.max(northWest.y, southEast.y), step).y;
    const cols = (x1 - x0) / step + 1;
    const rows = (y1 - y0) / step + 1;
    const sample = spanCorners(x0, y0, step);
    const sampleNw = map.latLngToLayerPoint([sample.north, sample.west]);
    const sampleSe = map.latLngToLayerPoint([sample.south, sample.east]);
    const side = Math.max(1, Math.abs(sampleSe.x - sampleNw.x));
    const drawGrid = side >= 14 && cols > 0 && rows > 0 && cols * rows <= 8000;
    const origin = map.latLngToLayerPoint([sample.north, sample.west]);
    L.DomUtil.setPosition(canvas, L.point(Math.round(origin.x), Math.round(origin.y)));
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, cols * side);
    const height = Math.max(1, rows * side);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (drawGrid) {
      context.strokeStyle = "rgba(28, 40, 34, 0.28)";
      context.lineWidth = 1;
      for (let iy = y0; iy <= y1; iy += step) {
        for (let ix = x0; ix <= x1; ix += step) {
          const left = ((ix - x0) / step) * side;
          const top = ((iy - y0) / step) * side;
          context.strokeRect(left + 0.5, top + 0.5, side - 1, side - 1);
        }
      }
    }
    const best = new Map<string, SignalCell>();
    for (const cell of Object.values(this.getCells())) {
      const block = cellBlock(cell);
      if (!block) continue;
      const parent = displayOrigin(block.x, block.y, step);
      if (parent.x < x0 || parent.x > x1 || parent.y < y0 || parent.y > y1) continue;
      const key = `${parent.x}:${parent.y}`;
      const current = best.get(key);
      if (!current || preferCell(cell, current)) best.set(key, cell);
    }
    const filter = this.getFilter();
    for (const [key, cell] of best) {
      const [ix, iy] = key.split(":").map(Number);
      const left = (((ix || 0) - x0) / step) * side;
      const top = (((iy || 0) - y0) / step) * side;
      const dim = (filter === "node" && cell.reach !== "node") || (filter === "mesh" && cell.reach !== "mesh");
      context.globalAlpha = dim ? 0.12 : cell.contact ? 0.38 : 0.72;
      context.fillStyle = cell.contact ? colorForScore(cell.score) : "rgb(138, 144, 140)";
      context.fillRect(left, top, side, side);
      context.globalAlpha = 1;
    }
    const selected = this.getSelected();
    if (selected) {
      const hit = displayOrigin(blockIndex(selected.lat, selected.lng).x, blockIndex(selected.lat, selected.lng).y, step);
      if (hit.x >= x0 && hit.x <= x1 && hit.y >= y0 && hit.y <= y1) {
        context.strokeStyle = "#d6ff4a";
        context.lineWidth = 2;
        context.strokeRect(((hit.x - x0) / step) * side + 1.5, ((hit.y - y0) / step) * side + 1.5, Math.max(side - 3, 4), Math.max(side - 3, 4));
      }
    }
  };
}

interface SquareNode {
  num: number;
  name: string;
  mark: string;
  hops: number | null;
  lastHeard?: number;
  gps: boolean;
  mine: boolean;
}

interface SquareInfo {
  nodes: SquareNode[];
  across: string;
}

function describeSquare(
  point: { lat: number; lng: number },
  cells: Record<string, SignalCell>,
  nodes: NodeRecord[],
  myNodeNum: number,
  zoom: number,
): SquareInfo {
  const step = displayStep(zoom);
  const fine = blockIndex(point.lat, point.lng);
  const hit = displayOrigin(fine.x, fine.y, step);
  const box = spanCorners(hit.x, hit.y, step);
  const listed = new Map<number, SquareNode>();
  for (const node of nodes) {
    if (node.lat == null || node.lng == null) continue;
    if (node.lat > box.north || node.lat < box.south || node.lng < box.west || node.lng > box.east) continue;
    listed.set(node.num, {
      num: node.num,
      name: nodeName(nodes, node.num, myNodeNum),
      mark: shortName(nodes, node.num, myNodeNum),
      hops: node.hopsAway ?? null,
      lastHeard: node.lastHeard,
      gps: true,
      mine: node.num === myNodeNum,
    });
  }
  for (const cell of Object.values(cells)) {
    const block = cellBlock(cell);
    if (!block) continue;
    const parent = displayOrigin(block.x, block.y, step);
    if (parent.x !== hit.x || parent.y !== hit.y) continue;
    const heard = new Map<number, number>();
    for (const event of cell.history ?? []) heard.set(event.num, Math.max(heard.get(event.num) ?? 0, event.time));
    for (const num of cell.heard ?? []) if (!heard.has(num)) heard.set(num, cell.updated);
    for (const [num, time] of heard) {
      if (listed.has(num) || num === myNodeNum) continue;
      const node = nodes.find((item) => item.num === num);
      listed.set(num, {
        num,
        name: nodeName(nodes, num, myNodeNum),
        mark: shortName(nodes, num, myNodeNum),
        hops: node?.hopsAway ?? cell.hops,
        lastHeard: Math.max(time, node?.lastHeard ?? 0) || undefined,
        gps: false,
        mine: false,
      });
    }
  }
  const list = [...listed.values()].sort((a, b) => {
    if (a.gps !== b.gps) return a.gps ? -1 : 1;
    const hopA = a.hops == null ? 999 : a.hops;
    const hopB = b.hops == null ? 999 : b.hops;
    if (hopA !== hopB) return hopA - hopB;
    return (b.lastHeard ?? 0) - (a.lastHeard ?? 0);
  });
  const meters = Math.round(movedMeters({ lat: box.south, lng: box.west }, { lat: box.south, lng: box.east }));
  const across =
    meters >= 1000
      ? `About ${meters >= 10000 ? Math.round(meters / 1000) : (meters / 1000).toFixed(1)} km across.`
      : `About ${meters} m across.`;
  return { nodes: list, across };
}

function preferCell(next: SignalCell, current: SignalCell): boolean {
  if (Boolean(next.contact) !== Boolean(current.contact)) return Boolean(next.contact);
  return next.score > current.score;
}

function cellBlock(cell: SignalCell): { x: number; y: number } | null {
  if (cell.key.startsWith("b:")) {
    const [, x, y] = cell.key.split(":");
    const bx = Number(x);
    const by = Number(y);
    if (Number.isFinite(bx) && Number.isFinite(by)) return { x: bx, y: by };
  }
  const edges = cellEdges(cell.latIndex, cell.lngIndex);
  return blockIndex((edges.south + edges.north) / 2, (edges.west + edges.east) / 2);
}

const LINK_WINDOW_MS = 5 * 60 * 1000;

function recentLinks(
  messages: { direct: boolean; time: number; from: number; to: number }[],
  nodes: NodeRecord[],
  myNodeNum: number,
  here: { lat: number; lng: number } | null,
): { from: { lat: number; lng: number }; to: { lat: number; lng: number } }[] {
  const now = Date.now();
  const latest = new Map<string, { from: number; to: number }>();
  for (const message of messages) {
    if (!message.direct || now - message.time > LINK_WINDOW_MS) continue;
    if (message.from === message.to || message.to === BROADCAST_NUM || message.from === BROADCAST_NUM) continue;
    latest.set(`${message.from}>${message.to}`, { from: message.from, to: message.to });
  }
  const links: { from: { lat: number; lng: number }; to: { lat: number; lng: number } }[] = [];
  for (const pair of latest.values()) {
    const from = locate(pair.from, nodes, myNodeNum, here);
    const to = locate(pair.to, nodes, myNodeNum, here);
    if (!from || !to || movedMeters(from, to) < 15) continue;
    links.push({ from, to });
  }
  return links;
}

function locate(
  num: number,
  nodes: NodeRecord[],
  myNodeNum: number,
  here: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (num === myNodeNum) return here;
  const node = nodes.find((item) => item.num === num);
  if (node?.lat == null || node.lng == null) return null;
  return { lat: node.lat, lng: node.lng };
}

function herePoint(
  nodes: NodeRecord[],
  myNodeNum: number,
  browser: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (browser) return { lat: browser.lat, lng: browser.lng };
  const mine = nodes.find((node) => node.num === myNodeNum && node.lat != null && node.lng != null);
  if (mine?.lat == null || mine.lng == null) return null;
  return { lat: mine.lat, lng: mine.lng };
}

function pointAlong(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  t: number,
): { lat: number; lng: number } {
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
}

function bearing(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function movedMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}
