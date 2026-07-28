import { useMemo, useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { LEADER_MIN, tagOffset, type NetAnchor } from "@core/circuit/netAnchor.js";
import type { PortType } from "@core/components/special/Special.js";
import { netLabelShape, tagTransform, tagBoxOrigin, type NetLabelShape } from "./netLabelShape.js";
import { terminalDirection, terminalTagSide, sampleWire } from "./netTerminalOrientation.js";
import { netRoutes, anchorsByPort } from "./anchorNets.js";
import { isLooseAnchor, nearestRoute, SNAP_REACH } from "./anchorMagnet.js";
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
 *
 * A name has *two* grips, and that is the one thing about it worth learning:
 *
 *   - the **anchor**, a small dot on the wire, which decides what is named;
 *   - the **tag**, the readable box, which decides only where it is read.
 *
 * Dragging the tag moves the tag. It keeps its net whatever happens, and a
 * leader line appears once it has gone far enough that the pairing is no longer
 * obvious. Dragging the anchor re-aims the name: the wire it would bind to
 * lights up as it passes, and it snaps onto that wire on release. Without the
 * split, "move the label out of the way" and "point the label at something else"
 * were the same gesture, and the second one won — a name nudged clear of a
 * crowded corner silently stopped naming anything.
 *
 * With one exception, and it is the exception that makes the split usable: a
 * name that is on no wire at all is dragged whole, tag and anchor together, and
 * reaches for wires as it goes (see anchorMagnet). Such a name has nothing to
 * protect — no net to lose — and the only thing anyone wants to do with it is
 * put it on a wire. Without this, the two grips said "move me" and "connect me"
 * while a freshly dropped label showed only the first: the label followed the
 * pointer onto the wire and stayed unconnected, which read as net labels no
 * longer connecting to anything at all.
 */
export function NetAnchorLayer({ onMenu }: { onMenu?: (a: NetAnchor, clientX: number, clientY: number) => void } = {}) {
  const vp = useViewport();
  const anchors = useCircuitStore((s) => s.netAnchors);
  const busTaps = useCircuitStore((s) => s.busTaps);
  const nodes = useCircuitStore((s) => s.nodes);
  const edges = useCircuitStore((s) => s.edges);
  const move = useCircuitStore((s) => s.moveNetAnchor);
  const moveTag = useCircuitStore((s) => s.moveNetAnchorTag);
  const update = useCircuitStore((s) => s.updateNetAnchor);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const selectedIds = useUIStore((s) => s.selectedAnchorIds);
  const setSelected = useUIStore((s) => s.setSelectedAnchorId);
  const toggleSelected = useUIStore((s) => s.toggleSelectedAnchorId);
  const selectedComponentId = useCircuitStore((s) => s.selectedComponentId);
  const circuit = useCircuitStore((s) => s.circuit);
  const theme = useTheme();
  const [editing, setEditing] = useState<string | null>(null);
  const netVersion = useCircuitStore((s) => s.netVersion);

  /**
   * The names on the nets of the part that is selected.
   *
   * Highlighted, not selected — a distinct, quieter mark. Clicking an input of
   * the decoder should *show* which name it answers to without also taking hold
   * of that name: the next Delete has to remove the part the user clicked, not
   * the label the app decided to point out. The properties panel lists the same
   * set (see PropertiesPanel.NetNamesForPart), so the panel and the canvas agree
   * on what "belongs to this part".
   */
  const related = useMemo(() => {
    // The circuit's nets are rebuilt *in place*, so a rewired sheet changes none
    // of the values below by identity — `circuit` is the same object it was.
    // This counter is the only signal that they mean something different now, so
    // it is read here as well as listed below; dropped from the dependencies,
    // this memo would keep handing back the highlighting of the previous wiring.
    void netVersion;
    if (!selectedComponentId) return new Set<string>();
    const byPort = anchorsByPort({ nodes, edges, netAnchors: anchors, circuit }, selectedComponentId, symbolNorm);
    return new Set(byPort.flatMap((p) => p.anchorIds));
  }, [selectedComponentId, nodes, edges, anchors, circuit, symbolNorm, netVersion]);

  /**
   * The name being dragged, with the layout it had when the drag began.
   *
   * Freezing that layout is the whole reason this is state and not a ref: the
   * tag's side and the symbol's direction are recomputed from the surroundings
   * on every render (see terminalTagSide), and *while dragging* the surroundings
   * change under the cursor. Every wire within 48 px counts as a neighbour, so
   * crossing one flipped the tag to the other side of its anchor — a jump of
   * twice its offset plus its own width, straight out from under the pointer —
   * and at the tipping point it oscillated, which is what made whole bands of
   * the sheet feel like they refused to accept a label. The layout is settled
   * once, at pointer-down, and only re-derived when the drag ends.
   */
  const [drag, setDrag] = useState<{ id: string; kind: "anchor" | "tag"; dir: FlowPoint; side: 1 | -1 } | null>(null);
  /** The net the dragged anchor would bind to, for the live preview. */
  const [preview, setPreview] = useState<{ verts: FlowPoint[]; netId: string } | null>(null);

  const grab = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // The wires, once per render rather than once per name: every anchor needs
  // them to work out which way to face, and re-routing the whole sheet for each
  // one made a schematic with a dozen names measurably slow to pan.
  const routes = useMemo(
    () => netRoutes(nodes, edges, { netOf: (id) => id }, symbolNorm),
    [nodes, edges, symbolNorm],
  );

  /** Where a name lays itself out, unless a drag has frozen it. */
  const layoutOf = (a: NetAnchor): { dir: FlowPoint; side: 1 | -1 } => {
    if (drag?.id === a.id) return { dir: drag.dir, side: drag.side };
    const dock = { x: a.x, y: a.y };
    const dir = terminalDirection(dock, nearestSegment(dock, routes));
    return { dir, side: terminalTagSide(dock, dir, neighbourhood(dock, nodes, routes)) };
  };

  const startAnchorMove = (e: React.PointerEvent, a: NetAnchor) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) toggleSelected(a.id); else setSelected(a.id);
    grab.current = { sx: e.clientX, sy: e.clientY, ox: a.x, oy: a.y };
    setDrag({ id: a.id, kind: "anchor", ...layoutOf(a) });
    trackPointerDrag(
      e,
      (ev) => {
        const g = grab.current;
        if (!g) return;
        const raw = { x: g.ox + (ev.clientX - g.sx) / vp.zoom, y: g.oy + (ev.clientY - g.sy) / vp.zoom };
        // Magnetic, and the magnet is what makes the binding legible: the
        // tolerance that decides the net is 8 units, which is a third of a grid
        // step and invisible while dragging. Reaching further than that and then
        // snapping *onto* the wire means the release lands exactly where the
        // preview said it would, instead of being a coin toss at the boundary.
        const near = nearestRoute(raw, routes, SNAP_REACH);
        setPreview(near);
        const at = near ? near.point : raw;
        move(a.id, at.x, at.y);
      },
      () => { grab.current = null; setDrag(null); setPreview(null); },
    );
  };

  /** Does this name lie on a wire? If not, it names nothing and may be re-aimed freely. */
  const isLoose = (a: NetAnchor) => isLooseAnchor({ x: a.x, y: a.y }, routes);

  /**
   * Start dragging the readable tag.
   *
   * `tagAnchor` is where the automatic layout had pinned the box, and it is
   * needed for the *first* drag of a given name: until then the tag has no
   * offset of its own, and it is pinned by a corner (`anchor`/`baseline`) rather
   * than by its centre — a long name hangs to the left of its point, a short one
   * barely at all. A dragged tag is centred instead, because that is the only
   * thing a pointer can sensibly carry.
   *
   * Converting between the two is what this does, and it has to be exact: taken
   * as "the corner is the centre", the box would jump by half its own width the
   * instant it was picked up — which is the very complaint this whole change is
   * about, reintroduced one gesture later. The size comes from the element, so
   * it is the box actually on screen and not an estimate of it.
   */
  const startTagMove = (
    e: React.PointerEvent, a: NetAnchor,
    off: { dx: number; dy: number } | null, tagAnchor: NetLabelShape["tag"],
  ) => {
    if (canvasLocked || !isDragPointer(e)) return;
    // A loose name is carried whole. `off` guards it: once the tag has been
    // deliberately pulled aside it is its own thing and stays one, or the first
    // drag after that would yank the anchor across the sheet to meet it.
    if (!off && isLoose(a)) { startAnchorMove(e, a); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) toggleSelected(a.id); else setSelected(a.id);
    const el = e.currentTarget as HTMLElement;
    const origin = tagBoxOrigin(tagAnchor, el.offsetWidth, el.offsetHeight);
    const base = off ?? {
      dx: origin.x + el.offsetWidth / 2 - NODE_SIZE / 2,
      dy: origin.y + el.offsetHeight / 2 - NODE_SIZE / 2,
    };
    grab.current = { sx: e.clientX, sy: e.clientY, ox: base.dx, oy: base.dy };
    setDrag({ id: a.id, kind: "tag", ...layoutOf(a) });
    trackPointerDrag(
      e,
      (ev) => {
        const g = grab.current;
        if (!g) return;
        moveTag(a.id, {
          dx: g.ox + (ev.clientX - g.sx) / vp.zoom,
          dy: g.oy + (ev.clientY - g.sy) / vp.zoom,
        });
      },
      () => { grab.current = null; setDrag(null); },
    );
  };

  if (anchors.length === 0 && busTaps.length === 0) return null;

  /** Flow coordinates → screen, for the overlay's own SVG. */
  const sx = (x: number) => vp.x + x * vp.zoom;
  const sy = (y: number) => vp.y + y * vp.zoom;

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
        ].map(([px, py]) => `${sx(px)},${sy(py)}`).join(" ");
        return (
          <svg key={t.id} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
            <polygon points={pts} fill={theme.wireStroke} opacity={0.85} />
          </svg>
        );
      })}

      {/* The wire the dragged anchor would bind to. Drawn under the names, over
          the canvas: it has to read as "this one", which a thin highlight on the
          wire itself does and a badge floating beside the cursor does not. */}
      {preview && (
        <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
          <polyline
            points={preview.verts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
            fill="none" stroke="#2563eb" strokeWidth={6} strokeOpacity={0.35}
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )}

      {anchors.map((a) => {
        const { dir, side } = layoutOf(a);
        const portType: PortType = a.portType ?? "None";
        const shape = netLabelShape(portType, dir, side);
        const isSelected = selectedIds.includes(a.id);
        // Selected wins over related: a name can be both, and "I am holding
        // this" is the stronger statement.
        const isRelated = !isSelected && related.has(a.id);
        const color = isSelected ? "#2563eb" : theme.netLabelStroke;
        const isConnector = portType !== "None";

        // Where the tag sits: the offset the user dragged it to, or the place the
        // automatic layout picked. Both are expressed in the old node's local
        // frame, whose centre is the dock, so the two are interchangeable.
        const off = tagOffset(a);
        const tagLocal = off
          ? { x: NODE_SIZE / 2 + off.dx, y: NODE_SIZE / 2 + off.dy }
          : { x: shape.tag.x, y: shape.tag.y };
        const tagBox = off
          // A dragged tag is centred on the point that was dragged. Keeping the
          // automatic layout's corner anchoring would make the box lurch by its
          // own width the first time a drag crossed an axis.
          ? { ...shape.tag, x: tagLocal.x, y: tagLocal.y, anchor: "middle" as const, baseline: "middle" as const }
          : shape.tag;
        const reach = off ? Math.hypot(off.dx, off.dy) : 0;
        const showLeader = reach >= LEADER_MIN;
        // A name on no wire shows its anchor unasked. It is the one state where
        // the dot answers a question the user actually has — "why is this not
        // naming anything?" — and it is also the grip that fixes it.
        const loose = isLoose(a);

        return (
          <div
            key={a.id}
            style={{
              position: "absolute",
              // The shape is drawn in the old node's local frame, whose centre is
              // the dock — so the box is placed by its centre, not its corner.
              left: sx(a.x - NODE_SIZE / 2),
              top: sy(a.y - NODE_SIZE / 2),
              width: NODE_SIZE,
              height: NODE_SIZE,
              transform: `scale(${vp.zoom})`,
              transformOrigin: "top left",
              pointerEvents: "none",
            }}
          >
            <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", color, position: "absolute", inset: 0 }}>
              {/* The leader line, drawn first so everything else sits on it.
                  Dashed and thin: it is a pointer, not a wire, and on a schematic
                  a solid line between two points means one thing only. */}
              {showLeader && (
                <line
                  x1={shape.circle.cx} y1={shape.circle.cy} x2={tagLocal.x} y2={tagLocal.y}
                  stroke={color} strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.75}
                />
              )}
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

            {/* The anchor grip: the point that decides what is named.
                A plain label draws no circle of its own, so until now it had no
                visible attachment point at all — and once the tag can be dragged
                away from it, "where is this name actually attached?" becomes a
                question the drawing has to answer. Shown while it matters: when
                the name is selected, or when its tag has been moved off. */}
            {(isSelected || showLeader || loose) && (
              <div
                onPointerDown={(e) => startAnchorMove(e, a)}
                title="Anschlusspunkt – ziehen, um den Namen auf eine andere Leitung zu setzen"
                style={{
                  ...DRAG_TOUCH_ACTION,
                  position: "absolute",
                  left: shape.circle.cx - ANCHOR_HIT, top: shape.circle.cy - ANCHOR_HIT,
                  width: ANCHOR_HIT * 2, height: ANCHOR_HIT * 2,
                  borderRadius: "50%",
                  // The grab area is transparent and larger than the mark; the
                  // dot below is what is seen.
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: canvasLocked ? "default" : "move",
                  pointerEvents: "auto",
                }}
              >
                <span
                  style={{
                    width: ANCHOR_GRIP * 2, height: ANCHOR_GRIP * 2,
                    borderRadius: "50%",
                    background: isSelected ? "#2563eb" : theme.netLabelStroke,
                    border: `2px solid ${theme.panelBg}`,
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}

            {/* The tag is the name *and* the second grip. */}
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
                  left: tagBox.x, top: tagBox.y, transform: tagTransform(tagBox),
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
                onPointerDown={(e) => startTagMove(e, a, off, shape.tag)}
                onDoubleClick={(e) => { e.stopPropagation(); if (!canvasLocked) setEditing(a.id); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(a.id); onMenu?.(a, e.clientX, e.clientY); }}
                title={
                  loose
                    ? "Liegt auf keiner Leitung – ziehen, um ihn auf eine Leitung zu setzen"
                    : isConnector
                      ? `Net Connector (${portType}) – ziehen verschiebt nur die Beschriftung, Doppelklick zum Umbenennen`
                      : "Netzname – ziehen verschiebt nur die Beschriftung, Doppelklick zum Umbenennen"
                }
                style={{
                  ...DRAG_TOUCH_ACTION,
                  position: "absolute",
                  left: tagBox.x, top: tagBox.y, transform: tagTransform(tagBox),
                  padding: "1px 6px", borderRadius: 4,
                  fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap",
                  color: theme.netTagText,
                  background: isConnector
                    ? (isSelected ? theme.portTagBgSel : theme.portTagBg)
                    : (isSelected ? theme.netTagBgSel : theme.netTagBg),
                  border: `1px solid ${isSelected ? "#2563eb" : isRelated ? RELATED_COLOR : theme.netTagBorder}`,
                  // A ring rather than a fill: the tag keeps its own colour, so
                  // "belongs to the selected part" reads as an annotation on the
                  // name instead of as a second kind of selection.
                  boxShadow: isRelated ? `0 0 0 2px ${RELATED_RING}` : undefined,
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

/** How a name on the selected part's nets is marked: a ring, not a selection. */
const RELATED_COLOR = "#f59e0b";
const RELATED_RING = "rgba(245, 158, 11, 0.45)";

/** Radius of the drawn anchor dot, in symbol-local units. */
const ANCHOR_GRIP = 4;
/**
 * Radius of the *hit* area around it.
 *
 * Twice the dot, because the dot is 8 units across and sits on a wire it is
 * drawn the same colour as. Missing it by a pixel does not do nothing — it
 * reaches the canvas underneath, which pans, so the whole schematic slides away
 * while the pointer is down. That reads as "the anchor cannot be moved", which
 * is how it was reported.
 */
const ANCHOR_HIT = 9;

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
