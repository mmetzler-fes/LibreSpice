import { useMemo, useState, type RefObject } from "react";
import {
  BaseEdge,
  useReactFlow,
  type EdgeProps,
  type Connection,
  type Node,
  type Edge,
} from "@xyflow/react";
import { getNodePins, type NodePin } from "./pinGeometry.js";
import { useUIStore } from "@store/uiStore.js";
import { useCircuitStore } from "@store/circuitStore.js";

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
  /** Allows assignment to React Flow's `Edge["data"]` (Record<string, unknown>). */
  [key: string]: unknown;
}

const GRID = 20;
/** Snap distance to a pin, in flow units. */
const PIN_SNAP = 16;
/** Snap distance to an existing wire segment, in flow units. */
const WIRE_SNAP = 10;

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

/** Custom edge that routes through stored waypoints with right angles. */
export function WireEdge({ id, source, sourceHandleId, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }: EdgeProps) {
  const circuit = useCircuitStore((s) => s.circuit);
  // Re-render the net-id label when net assignments change.
  useCircuitStore((s) => s.netVersion);

  const waypoints = (data?.waypoints as FlowPoint[] | undefined) ?? [];
  // When an endpoint taps an existing wire, draw only to the junction point
  // instead of routing all the way to the (electrical) target port.
  const sourceTap = data?.sourceTap as FlowPoint | undefined;
  const targetTap = data?.targetTap as FlowPoint | undefined;
  const start = sourceTap ?? { x: sourceX, y: sourceY };
  const end = targetTap ?? { x: targetX, y: targetY };
  const verts = orthoVertices([start, ...waypoints, end]);
  const path = "M " + verts.map((p) => `${p.x} ${p.y}`).join(" L ");

  // Net id of this wire (from its source port), shown when selected.
  let netLabel: string | null = null;
  if (selected) {
    const port = circuit.components.get(source)?.ports.find((p) => p.id === `${source}-${sourceHandleId}`);
    const netId = port?.netId ?? null;
    netLabel = netId ? (circuit.nets.get(netId)?.nodeLabel ?? netId) : null;
  }
  const mid = verts[Math.floor(verts.length / 2)] ?? verts[0];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: selected ? "#2563eb" : "#1e293b", strokeWidth: 2 }}
      />
      {selected && netLabel && mid && (
        <g transform={`translate(${mid.x}, ${mid.y})`} style={{ pointerEvents: "none" }}>
          <rect x={-netLabel.length * 3.4 - 4} y={-19} width={netLabel.length * 6.8 + 8} height={15} rx={3} fill="#2563eb" />
          <text x={0} y={-8} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#fff">{netLabel}</text>
        </g>
      )}
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
function projectToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): { point: FlowPoint; d2: number } {
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

  const symbolNorm = useUIStore((s) => s.symbolNorm);
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

  const reset = () => { setPoints([]); setStartTarget(null); };

  const handleMove = (e: React.MouseEvent) => {
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pin = findPin(flow);
    if (pin) {
      setHoverTarget({ kind: "pin", nodeId: pin.nodeId, handleId: pin.handleId, point: { x: pin.x, y: pin.y } });
      setCursor({ x: pin.x, y: pin.y });
      return;
    }
    const wire = findWire(flow);
    if (wire) {
      setHoverTarget(wire);
      setCursor(wire.point);
      return;
    }
    setHoverTarget(null);
    setCursor({ x: snap(flow.x), y: snap(flow.y) });
  };

  const sameTarget = (a: WireTarget, b: WireTarget) => a.nodeId === b.nodeId && a.handleId === b.handleId;

  const handleClick = () => {
    if (!cursor) return;
    if (!startTarget) {
      // First click must dock onto a pin or an existing wire.
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
  const previewPts = cursor ? [...points, cursor] : points;
  const previewPath = previewPts.length >= 2 ? orthoPath(previewPts.map(toLocal)) : "";

  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;

  return (
    <div
      onMouseMove={handleMove}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseLeave={() => { setCursor(null); setHoverTarget(null); }}
      style={{ position: "absolute", inset: 0, zIndex: 5, cursor: "none" }}
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
          <path d={previewPath} fill="none" stroke="#1e293b" strokeWidth={2} strokeDasharray="6 3" />
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
