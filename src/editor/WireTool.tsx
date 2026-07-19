import { useMemo, useRef, useState, type RefObject } from "react";
import {
  BaseEdge,
  useReactFlow,
  type EdgeProps,
  type Connection,
  type Node,
  type Edge,
} from "@xyflow/react";
import { getNodePins, GRID, PX_PER_CM, type NodePin } from "./pinGeometry.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { DRAG_TOUCH_ACTION, isDragPointer } from "./pointerDrag.js";
import { wireNameTag } from "./wireLabelShape.js";

export interface FlowPoint {
  x: number;
  y: number;
}

/** Payload stored on a wire edge. */
export interface WireData {
  waypoints: FlowPoint[];
  /** Visual start point when the wire taps onto an existing wire (not a pin). */
  sourceTap?: FlowPoint;
  /** Visual end point when the wire taps onto an existing wire (not a pin). */
  targetTap?: FlowPoint;
  /** Show the net-name label permanently (not only while the wire is selected). */
  showLabel?: boolean;
  /** Position of the label / dock point along the wire, 0..1 of its length. */
  labelT?: number;
  /** Label offset from the dock point (flow px), clamped to ~1 cm. */
  labelOffset?: FlowPoint;
  /** Allows assignment to React Flow's `Edge["data"]` (Record<string, unknown>). */
  [key: string]: unknown;
}


/** Total length of a polyline. */
function polylineLength(verts: FlowPoint[]): number {
  let len = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    len += Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
  }
  return len;
}

/** Point at parametric position `t` (0..1 of total length) along a polyline. */
export function pointAtT(verts: FlowPoint[], t: number): FlowPoint {
  if (verts.length === 0) return { x: 0, y: 0 };
  if (verts.length === 1) return verts[0];
  const total = polylineLength(verts);
  if (total === 0) return verts[0];
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < verts.length - 1; i++) {
    const segLen = Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
    if (target <= segLen || i === verts.length - 2) {
      const f = segLen === 0 ? 0 : target / segLen;
      return { x: verts[i].x + (verts[i + 1].x - verts[i].x) * f, y: verts[i].y + (verts[i + 1].y - verts[i].y) * f };
    }
    target -= segLen;
  }
  return verts[verts.length - 1];
}

/** Nearest parametric position (0..1) on a polyline to point `p`. */
export function projectToPolyline(verts: FlowPoint[], p: FlowPoint): number {
  if (verts.length < 2) return 0;
  const total = polylineLength(verts);
  if (total === 0) return 0;
  let acc = 0, bestD2 = Infinity, bestGlobal = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const { point, d2 } = projectToSegment(p, verts[i], verts[i + 1]);
    const segLen = Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
    if (d2 < bestD2) {
      bestD2 = d2;
      const along = Math.hypot(point.x - verts[i].x, point.y - verts[i].y);
      bestGlobal = acc + along;
    }
    acc += segLen;
  }
  return bestGlobal / total;
}

/** Snap distance to a pin, in flow units. */
const PIN_SNAP = 16;
/** Snap distance to an existing wire segment, in flow units. */
const WIRE_SNAP = 10;
/** How far the pen may stray perpendicular to the current segment before it
 *  turns a corner — measured in *screen* pixels (≈0.5 cm), using the raw pen
 *  position rather than the grid-snapped one. Screen-space so zoom doesn't
 *  change the feel; raw so a single grid cell can't jump the threshold and trip
 *  a turn on the slightest drift (which made straight lines nearly impossible). */
const TURN_DEVIATION_PX = 0.5 * PX_PER_CM;

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

/**
 * Expands a list of vertices into an orthogonal (right-angle) vertex list. The
 * lead axis of each corner follows the dominant delta, so a segment can start in
 * any of the four directions depending on cursor movement.
 */
export function orthoVertices(points: FlowPoint[]): FlowPoint[] {
  if (points.length === 0) return [];
  const out: FlowPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    if (a.x !== b.x && a.y !== b.y) {
      const corner = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
        ? { x: b.x, y: a.y } // horizontal lead
        : { x: a.x, y: b.y }; // vertical lead
      out.push(corner);
    }
    out.push(b);
  }
  return out;
}

export function orthoPath(points: FlowPoint[]): string {
  const v = orthoVertices(points);
  if (v.length === 0) return "";
  return "M " + v.map((p) => `${p.x} ${p.y}`).join(" L ");
}

/** Max distance (flow px) a dragged label may sit from the wire (~1 cm). */
const LABEL_MAX_OFFSET = PX_PER_CM;

/** Custom edge that routes through stored waypoints with right angles. */
export function WireEdge({ id, source, sourceHandleId, target, targetHandleId, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }: EdgeProps) {
  const circuit = useCircuitStore((s) => s.circuit);
  const nodes = useCircuitStore((s) => s.nodes);
  const updateEdgeData = useCircuitStore((s) => s.updateEdgeData);
  // Re-render the net-id label when net assignments change.
  useCircuitStore((s) => s.netVersion);
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const { screenToFlowPosition } = useReactFlow();
  const theme = useTheme();

  // Exact pin centre for an endpoint. React Flow anchors an edge at the handle's
  // Position edge (e.g. the *top* of a Position.Top handle circle), which shows
  // as an off-centre dock on horizontal wires; route to the true pin centre.
  const pinCenter = (nodeId?: string, handleId?: string | null): FlowPoint | null => {
    if (!nodeId || !handleId) return null;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const pin = getNodePins(node, symbolNorm).find((p) => p.handleId === handleId);
    return pin ? { x: pin.x, y: pin.y } : null;
  };

  const waypoints = (data?.waypoints as FlowPoint[] | undefined) ?? [];
  // When an endpoint taps an existing wire, draw only to the junction point
  // instead of routing all the way to the (electrical) target port.
  const sourceTap = data?.sourceTap as FlowPoint | undefined;
  const targetTap = data?.targetTap as FlowPoint | undefined;
  const start = sourceTap ?? pinCenter(source, sourceHandleId) ?? { x: sourceX, y: sourceY };
  const end = targetTap ?? pinCenter(target, targetHandleId) ?? { x: targetX, y: targetY };
  const verts = orthoVertices([start, ...waypoints, end]);
  const path = "M " + verts.map((p) => `${p.x} ${p.y}`).join(" L ");

  const showLabel = !!data?.showLabel;

  // Net id/name of this wire (from its source port). Needed whenever the label
  // is shown permanently (`showLabel`) or transiently (while selected).
  let netLabel: string | null = null;
  if (selected || showLabel) {
    const port = circuit.components.get(source)?.ports.find((p) => p.id === `${source}-${sourceHandleId}`);
    const netId = port?.netId ?? null;
    netLabel = netId ? (circuit.nets.get(netId)?.nodeLabel ?? netId) : null;
  }
  // The dock point rides along the wire at `labelT`; the label floats from it by
  // `labelOffset` (up to ~1 cm). Both default to the wire's midpoint.
  const labelT = typeof data?.labelT === "number" ? (data.labelT as number) : 0.5;
  const labelOffset = (data?.labelOffset as FlowPoint | undefined) ?? { x: 0, y: 0 };
  const dock = pointAtT(verts, labelT);
  const anchor = { x: dock.x + labelOffset.x, y: dock.y + labelOffset.y };

  // Drag the label to slide it along the wire and up to ~1 cm away. The pointer's
  // projection onto the wire sets the dock (`labelT`); the residual is the offset.
  const onLabelPointerDown = (e: React.PointerEvent) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const flow = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const t = projectToPolyline(verts, flow);
      const d = pointAtT(verts, t);
      let ox = flow.x - d.x, oy = flow.y - d.y;
      const mag = Math.hypot(ox, oy);
      if (mag > LABEL_MAX_OFFSET) { ox = (ox / mag) * LABEL_MAX_OFFSET; oy = (oy / mag) * LABEL_MAX_OFFSET; }
      updateEdgeData(id, { labelT: t, labelOffset: { x: ox, y: oy } });
    };
    const up = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The wire's own name tag (always the net name): shown when `visible` or while
  // selected. Ports are not wire attributes — a net connector is its own node
  // (see NetTerminalNode), so a wire only ever carries its net's name.
  const showBox = !!netLabel && (showLabel || selected);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: selected ? theme.accent : theme.wireStroke, strokeWidth: 2 }}
      />
      {showBox && netLabel && (() => {
        // The tag is drawn relative to the anchor so the whole group can carry
        // the drag handler; the shared shape is anchor-absolute, hence the shift.
        const t = wireNameTag({ x: 0, y: 0 }, netLabel);
        return (
          <g
            transform={`translate(${anchor.x}, ${anchor.y})`}
            onPointerDown={onLabelPointerDown}
            style={{ ...DRAG_TOUCH_ACTION, cursor: canvasLocked ? "default" : "move", pointerEvents: "all" }}
          >
            <rect x={t.x} y={t.y} width={t.width} height={t.height} rx={3} fill="#2563eb" />
            <text x={t.textX} y={t.textY} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#fff" style={{ userSelect: "none" }}>{netLabel}</text>
          </g>
        );
      })()}
    </>
  );
}

/** A wire endpoint target: either a component pin or a tap onto an existing wire. */
interface WireTarget {
  kind: "pin" | "wire";
  nodeId: string;
  handleId: string;
  point: FlowPoint;
}

/** Nearest point on segment AB to P, with squared distance. */
export function projectToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): { point: FlowPoint; d2: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  const dx = p.x - point.x;
  const dy = p.y - point.y;
  return { point, d2: dx * dx + dy * dy };
}

interface WireOverlayProps {
  wrapperRef: RefObject<HTMLDivElement | null>;
  nodes: Node[];
  edges: Edge[];
  onCreateWire: (connection: Connection, data: WireData) => void;
}

/**
 * LTSpice-style wire drawing overlay. Shows a crosshair cursor, docks the first
 * click to a component pin (or onto an existing wire), lets each further click
 * add a 90° bend, and closes the connection when a second pin/wire is clicked.
 */
export function WireOverlay({ wrapperRef, nodes, edges, onCreateWire }: WireOverlayProps) {
  const { screenToFlowPosition, flowToScreenPosition } = useReactFlow();
  const [points, setPoints] = useState<FlowPoint[]>([]);
  const [startTarget, setStartTarget] = useState<WireTarget | null>(null);
  const [cursor, setCursor] = useState<FlowPoint | null>(null);
  const [hoverTarget, setHoverTarget] = useState<WireTarget | null>(null);

  // A touch/pen wire is drawn as one continuous drag (no per-tap clicks). These
  // hold the live gesture: whether a drag is in flight, the axis of the segment
  // currently being drawn, and the committed vertices (mirrored from `points`
  // so a rapid pointermove reads the latest without a stale closure).
  const draggingRef = useRef(false);
  const segDirRef = useRef<"h" | "v" | null>(null);
  const pointsRef = useRef<FlowPoint[]>([]);

  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const theme = useTheme();
  const pins = useMemo(() => nodes.flatMap((n) => getNodePins(n, symbolNorm)), [nodes, symbolNorm]);

  const rect = wrapperRef.current?.getBoundingClientRect();

  const findPin = (flow: FlowPoint): NodePin | null => {
    let best: NodePin | null = null;
    let bestD = PIN_SNAP * PIN_SNAP;
    for (const p of pins) {
      const dx = p.x - flow.x;
      const dy = p.y - flow.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  const pinPos = (nodeId: string, handleId: string | null | undefined): FlowPoint | null => {
    if (!handleId) return null;
    const p = pins.find((q) => q.nodeId === nodeId && q.handleId === handleId);
    return p ? { x: p.x, y: p.y } : null;
  };

  /** Find the nearest existing wire under the cursor and the tap point on it. */
  const findWire = (flow: FlowPoint): WireTarget | null => {
    let best: WireTarget | null = null;
    let bestD = WIRE_SNAP * WIRE_SNAP;
    for (const e of edges) {
      const s = (e.data?.sourceTap as FlowPoint | undefined) ?? pinPos(e.source, e.sourceHandle);
      const t = (e.data?.targetTap as FlowPoint | undefined) ?? pinPos(e.target, e.targetHandle);
      if (!s || !t) continue;
      const wp = (e.data?.waypoints as FlowPoint[] | undefined) ?? [];
      const verts = orthoVertices([s, ...wp, t]);
      for (let i = 0; i < verts.length - 1; i++) {
        const { point, d2 } = projectToSegment(flow, verts[i], verts[i + 1]);
        if (d2 < bestD) {
          bestD = d2;
          best = { kind: "wire", nodeId: e.source, handleId: e.sourceHandle!, point };
        }
      }
    }
    return best;
  };

  const reset = () => {
    setPoints([]); setStartTarget(null);
    draggingRef.current = false; segDirRef.current = null; pointsRef.current = [];
  };

  /** Dominant axis of a delta: the direction an orthogonal segment would lead. */
  const dirOf = (dx: number, dy: number): "h" | "v" => (Math.abs(dx) >= Math.abs(dy) ? "h" : "v");

  /**
   * Where a screen position lands: snapped to a pin, to a point on an existing
   * wire, or to the grid. Pure, so a tap can resolve its own position instead of
   * relying on a hover that a stylus never produced.
   */
  const resolve = (clientX: number, clientY: number): { cursor: FlowPoint; target: WireTarget | null } => {
    const flow = screenToFlowPosition({ x: clientX, y: clientY });
    const pin = findPin(flow);
    if (pin) {
      return {
        cursor: { x: pin.x, y: pin.y },
        target: { kind: "pin", nodeId: pin.nodeId, handleId: pin.handleId, point: { x: pin.x, y: pin.y } },
      };
    }
    const wire = findWire(flow);
    if (wire) return { cursor: wire.point, target: wire };
    return { cursor: { x: snap(flow.x), y: snap(flow.y) }, target: null };
  };

  const sameTarget = (a: WireTarget, b: WireTarget) => a.nodeId === b.nodeId && a.handleId === b.handleId;

  // ── Mouse: click to dock, click for each 90° bend, click to close. ──────────
  const commit = (cursor: FlowPoint, hoverTarget: WireTarget | null) => {
    if (!startTarget) {
      // First tap must dock onto a pin or an existing wire.
      if (hoverTarget) { setStartTarget(hoverTarget); setPoints([hoverTarget.point]); }
      return;
    }
    if (hoverTarget && !sameTarget(hoverTarget, startTarget)) {
      // Closing the connection on a second pin/wire.
      // Interior bend points only (start point is provided by the port/tap).
      const waypoints = points.slice(1);
      onCreateWire(
        {
          source: startTarget.nodeId,
          sourceHandle: startTarget.handleId,
          target: hoverTarget.nodeId,
          targetHandle: hoverTarget.handleId,
        },
        {
          waypoints,
          sourceTap: startTarget.kind === "wire" ? startTarget.point : undefined,
          targetTap: hoverTarget.kind === "wire" ? hoverTarget.point : undefined,
        },
      );
      reset();
      return;
    }
    // Add a 90° bend at the current cursor position.
    setPoints((prev) => [...prev, { x: cursor.x, y: cursor.y }]);
  };

  // ── Touch/pen (iPad, Surface, …): one continuous drag. ──────────────────────
  // A stylus/finger has no hover-then-click, so wiring is a single gesture:
  // press on a pin/wire to start, and every time the drag turns a corner that
  // bend is *frozen* (it no longer re-routes), then release on a second pin/wire
  // to close the wire with exactly those bends.
  const touchDown = (e: React.PointerEvent) => {
    const { cursor: c, target } = resolve(e.clientX, e.clientY);
    if (!target) return; // a wire must start on a pin or an existing wire
    setStartTarget(target);
    setPoints([target.point]);
    pointsRef.current = [target.point];
    segDirRef.current = null;
    draggingRef.current = true;
    setHoverTarget(target);
    setCursor(c);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const touchMove = (e: React.PointerEvent) => {
    const { cursor: c, target } = resolve(e.clientX, e.clientY);
    setHoverTarget(target);
    const pts = pointsRef.current;
    const L = pts[pts.length - 1];
    // Deviation from the segment's anchor in screen px, from the *raw* pen
    // position (not the snapped cursor): the segment holds its direction until
    // the pen strays TURN_DEVIATION_PX perpendicular to it.
    const Ls = flowToScreenPosition(L);
    const devX = e.clientX - Ls.x, devY = e.clientY - Ls.y;
    if (segDirRef.current === null) {
      // Adopt a lead axis only once the drag has clearly committed to one.
      if (Math.hypot(devX, devY) >= TURN_DEVIATION_PX) segDirRef.current = dirOf(devX, devY);
    } else if ((segDirRef.current === "h" ? Math.abs(devY) : Math.abs(devX)) >= TURN_DEVIATION_PX) {
      // Turned off the current axis: freeze the elbow, back-computed from the
      // pen's current position (the segment runs out to where the pen now is),
      // and continue along the other axis.
      const corner = segDirRef.current === "h" ? { x: c.x, y: L.y } : { x: L.x, y: c.y };
      pointsRef.current = [...pts, corner];
      setPoints(pointsRef.current);
      segDirRef.current = segDirRef.current === "h" ? "v" : "h";
    }
    setCursor(c);
  };

  const touchUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    const { target } = resolve(e.clientX, e.clientY);
    if (startTarget && target && !sameTarget(target, startTarget)) {
      const pts = pointsRef.current;
      const L = pts[pts.length - 1];
      const P = target.point;
      let waypoints = pts.slice(1);
      // Preserve the last drawn segment's orientation, so the finished wire
      // keeps the shape the drag showed instead of a re-derived elbow.
      if (segDirRef.current && L) {
        const elbow = segDirRef.current === "h" ? { x: P.x, y: L.y } : { x: L.x, y: P.y };
        const degenerate = (elbow.x === L.x && elbow.y === L.y) || (elbow.x === P.x && elbow.y === P.y);
        if (!degenerate) waypoints = [...waypoints, elbow];
      }
      onCreateWire(
        { source: startTarget.nodeId, sourceHandle: startTarget.handleId, target: target.nodeId, targetHandle: target.handleId },
        { waypoints, sourceTap: startTarget.kind === "wire" ? startTarget.point : undefined, targetTap: target.kind === "wire" ? target.point : undefined },
      );
    }
    reset(); // released off a target → discard the in-progress wire
  };

  const handleDown = (e: React.PointerEvent) => {
    if (!isDragPointer(e)) return;
    if (e.pointerType !== "mouse") { touchDown(e); return; }
    const { cursor: cursorNow, target: hoverNow } = resolve(e.clientX, e.clientY);
    setCursor(cursorNow);
    setHoverTarget(hoverNow);
    commit(cursorNow, hoverNow);
  };

  const handleMove = (e: React.PointerEvent) => {
    if (draggingRef.current) { touchMove(e); return; }
    const { cursor: c, target } = resolve(e.clientX, e.clientY);
    setHoverTarget(target);
    setCursor(c);
  };

  const handleUp = (e: React.PointerEvent) => {
    if (draggingRef.current) touchUp(e);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    reset();
  };

  // Convert a flow point to overlay-local pixels.
  const toLocal = (p: FlowPoint): FlowPoint => {
    const s = flowToScreenPosition(p);
    return { x: s.x - (rect?.left ?? 0), y: s.y - (rect?.top ?? 0) };
  };

  const cursorLocal = cursor ? toLocal(cursor) : null;
  // Live preview. Mid touch/pen drag the last segment is forced along the active
  // axis (segDirRef) so it can't flip while the finger moves; the mouse keeps
  // the auto-routed last segment.
  let previewChain: FlowPoint[] = points;
  if (cursor) {
    if (draggingRef.current && points.length >= 1 && segDirRef.current) {
      const L = points[points.length - 1];
      // Draw the live segment straight along its axis — the sub-threshold
      // perpendicular drift isn't shown, so a steady hand yields a straight line.
      const end = segDirRef.current === "h" ? { x: cursor.x, y: L.y } : { x: L.x, y: cursor.y };
      previewChain = [...points, end];
    } else {
      previewChain = [...points, cursor];
    }
  }
  const previewPath = previewChain.length >= 2 ? orthoPath(previewChain.map(toLocal)) : "";

  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;

  return (
    <div
      onPointerMove={handleMove}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onContextMenu={handleContextMenu}
      onPointerLeave={() => { if (!draggingRef.current) { setCursor(null); setHoverTarget(null); } }}
      style={{ ...DRAG_TOUCH_ACTION, position: "absolute", inset: 0, zIndex: 5, cursor: "none" }}
    >
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {/* Crosshair */}
        {cursorLocal && (
          <g stroke="#2563eb" strokeWidth={0.75} opacity={0.7}>
            <line x1={cursorLocal.x} y1={0} x2={cursorLocal.x} y2={height} />
            <line x1={0} y1={cursorLocal.y} x2={width} y2={cursorLocal.y} />
          </g>
        )}
        {/* Wire being drawn */}
        {previewPath && (
          <path d={previewPath} fill="none" stroke={theme.wireStroke} strokeWidth={2} strokeDasharray="6 3" />
        )}
        {/* Snap indicators */}
        {hoverTarget?.kind === "pin" && cursorLocal && (
          <circle cx={cursorLocal.x} cy={cursorLocal.y} r={6} fill="none" stroke="#16a34a" strokeWidth={2} />
        )}
        {hoverTarget?.kind === "wire" && cursorLocal && (
          <rect
            x={cursorLocal.x - 5} y={cursorLocal.y - 5} width={10} height={10}
            transform={`rotate(45 ${cursorLocal.x} ${cursorLocal.y})`}
            fill="#16a34a"
          />
        )}
        {/* Cursor dot */}
        {cursorLocal && !hoverTarget && (
          <rect x={cursorLocal.x - 3} y={cursorLocal.y - 3} width={6} height={6} fill="#2563eb" />
        )}
      </svg>
    </div>
  );
}
