import { useMemo, useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import type { NetAnchor } from "@core/circuit/netAnchor.js";
import type { PortType } from "@core/components/special/Special.js";
import { netLabelShape, tagTransform } from "./netLabelShape.js";
import { terminalDirection, terminalTagSide, sampleWire } from "./netTerminalOrientation.js";
import { netRoutes } from "./anchorNets.js";
import { NODE_SIZE } from "./pinGeometry.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "./pointerDrag.js";
import type { FlowPoint } from "./WireTool.js";

/**
 * The names on the sheet: net labels and net connectors (LTSpice `FLAG`, plus
 * `IOPIN` for a connector's direction).
 *
 * An overlay, like the data flags, the text boxes and the sheet shapes — the
 * three annotations that already lived beside the circuit rather than inside it.
 * A name is the fourth, and drawing it here rather than as a React Flow node is
 * the visible half of that: it has no pin to wire to, so it cannot be dragged
 * into the topology by accident, and moving it moves nothing but itself.
 *
 * Which way it faces is not stored. LTSpice keeps no orientation for a flag
 * either — `FLAG x y name` is the whole line — and recomputes it from the wiring
 * every time it draws. So do we (see terminalDirection), which is why a file
 * saved here reopens there looking the same.
 */
export function NetAnchorLayer({ onMenu }: { onMenu?: (a: NetAnchor, clientX: number, clientY: number) => void } = {}) {
  const vp = useViewport();
  const anchors = useCircuitStore((s) => s.netAnchors);
  const busTaps = useCircuitStore((s) => s.busTaps);
  const nodes = useCircuitStore((s) => s.nodes);
  const edges = useCircuitStore((s) => s.edges);
  const move = useCircuitStore((s) => s.moveNetAnchor);
  const update = useCircuitStore((s) => s.updateNetAnchor);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const selected = useUIStore((s) => s.selectedAnchorId);
  const setSelected = useUIStore((s) => s.setSelectedAnchorId);
  const theme = useTheme();
  const [editing, setEditing] = useState<string | null>(null);
  useCircuitStore((s) => s.netVersion);

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // The wires, once per render rather than once per name: every anchor needs
  // them to work out which way to face, and re-routing the whole sheet for each
  // one made a schematic with a dozen names measurably slow to pan.
  const routes = useMemo(
    () => netRoutes(nodes, edges, { netOf: (id) => id }, symbolNorm),
    [nodes, edges, symbolNorm],
  );

  const startMove = (e: React.PointerEvent, a: NetAnchor) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(a.id);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: a.x, oy: a.y, moved: false };
    trackPointerDrag(
      e,
      (ev) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        move(a.id, d.ox + (ev.clientX - d.sx) / vp.zoom, d.oy + (ev.clientY - d.sy) / vp.zoom);
      },
      () => { drag.current = null; },
    );
  };

  if (anchors.length === 0 && busTaps.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {busTaps.map((t) => {
        // Always pointing right, never rotated or mirrored — that is how LTSpice
        // draws a bus tap, and it offers no way to turn one. The two coordinates
        // say where the tap sits, not which way it faces.
        const x = Math.min(t.x, t.x2), y = t.y;
        const pts = [
          [x, y - BUSTAP_HALF],
          [x, y + BUSTAP_HALF],
          [x + BUSTAP_LEN, y],
        ].map(([px, py]) => `${vp.x + px * vp.zoom},${vp.y + py * vp.zoom}`).join(" ");
        return (
          <svg key={t.id} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
            <polygon points={pts} fill={theme.wireStroke} opacity={0.85} />
          </svg>
        );
      })}

      {anchors.map((a) => {
        const dock = { x: a.x, y: a.y };
        // The wire the name lies on decides which way it faces: the symbol points
        // away from it so the name never runs back over its own net.
        const near = nearestSegment(dock, routes);
        const dir = terminalDirection(dock, near);
        const side = terminalTagSide(dock, dir, neighbourhood(dock, nodes, routes));
        const portType: PortType = a.portType ?? "None";
        const shape = netLabelShape(portType, dir, side);
        const isSelected = selected === a.id;
        const color = isSelected ? "#2563eb" : theme.netLabelStroke;
        const isConnector = portType !== "None";

        return (
          <div
            key={a.id}
            style={{
              position: "absolute",
              // The shape is drawn in the old node's local frame, whose centre is
              // the dock — so the box is placed by its centre, not its corner.
              left: vp.x + (a.x - NODE_SIZE / 2) * vp.zoom,
              top: vp.y + (a.y - NODE_SIZE / 2) * vp.zoom,
              width: NODE_SIZE,
              height: NODE_SIZE,
              transform: `scale(${vp.zoom})`,
              transformOrigin: "top left",
              pointerEvents: "none",
            }}
          >
            <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", color, position: "absolute", inset: 0 }}>
              {isConnector && (
                <circle
                  cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r}
                  fill={theme.panelBg} stroke={color} strokeWidth={2}
                />
              )}
              {shape.stem && (
                <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2}
                  stroke={color} strokeWidth={1.6} strokeLinecap="round" />
              )}
              {shape.heads.map((points, i) => <polygon key={i} points={points} fill={color} />)}
            </svg>

            {/* The tag is the name *and* the grip. There is nothing else to grab:
                a plain label draws no circle, exactly as it did as a node. */}
            {editing === a.id ? (
              <input
                autoFocus
                defaultValue={a.name}
                onBlur={(e) => { update(a.id, { name: e.target.value }); setEditing(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                  e.stopPropagation();
                }}
                style={{
                  position: "absolute",
                  left: shape.tag.x, top: shape.tag.y, transform: tagTransform(shape.tag),
                  width: Math.max(56, a.name.length * 8 + 20),
                  padding: "1px 5px", borderRadius: 4,
                  fontSize: 11, fontFamily: "monospace",
                  color: theme.text, background: theme.inputBg,
                  border: "1px solid #2563eb", outline: "none",
                  pointerEvents: "auto",
                }}
              />
            ) : (
              <div
                onPointerDown={(e) => startMove(e, a)}
                onDoubleClick={(e) => { e.stopPropagation(); if (!canvasLocked) setEditing(a.id); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(a.id); onMenu?.(a, e.clientX, e.clientY); }}
                title={isConnector ? `Net Connector (${portType}) – ziehen, Doppelklick zum Umbenennen` : "Netzname – ziehen, Doppelklick zum Umbenennen"}
                style={{
                  ...DRAG_TOUCH_ACTION,
                  position: "absolute",
                  left: shape.tag.x, top: shape.tag.y, transform: tagTransform(shape.tag),
                  padding: "1px 6px", borderRadius: 4,
                  fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap",
                  color: theme.netTagText,
                  background: isConnector
                    ? (isSelected ? theme.portTagBgSel : theme.portTagBg)
                    : (isSelected ? theme.netTagBgSel : theme.netTagBg),
                  border: `1px solid ${isSelected ? "#2563eb" : theme.netTagBorder}`,
                  userSelect: "none", cursor: canvasLocked ? "default" : "move",
                  pointerEvents: "auto",
                }}
              >
                {a.name}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A bus tap's triangle: half its base, and how far the tip reaches right. */
const BUSTAP_HALF = 6;
const BUSTAP_LEN = 12;

/**
 * The two ends of the wire segment nearest `p`, as far-end points.
 *
 * This is what a name has instead of the edges its node used to hang off:
 * nothing is attached to it, so the direction has to be read off the wire it is
 * lying on. Both ends are handed over because `terminalDirection` wants the far
 * ends of everything meeting at the dock, and the segment straddles it.
 */
function nearestSegment(p: FlowPoint, routes: { verts: FlowPoint[] }[]): FlowPoint[] {
  let best = 24, ends: FlowPoint[] = [];
  for (const r of routes) {
    for (let i = 0; i < r.verts.length - 1; i++) {
      const a = r.verts[i], b = r.verts[i + 1];
      const d = distToSegment(p, a, b);
      if (d < best) { best = d; ends = [a, b]; }
    }
  }
  return ends;
}

/** Points near the dock that a name has to dodge: parts, and the wires. */
function neighbourhood(dock: FlowPoint, nodes: { position: { x: number; y: number } }[], routes: { verts: FlowPoint[] }[]): FlowPoint[] {
  const out: FlowPoint[] = nodes.map((n) => ({ x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 }));
  for (const r of routes) out.push(...sampleWire(r.verts, dock));
  return out;
}

/** Distance from a point to a segment. */
function distToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
