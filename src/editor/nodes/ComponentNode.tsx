import { memo, useMemo, useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../../theme.js";
import { useCircuitStore } from "@store/circuitStore.js";
import type { AsySymbol } from "@sym/asyParser.js";
import {
  ResistorSymbol,
  CapacitorSymbol,
  InductorSymbol,
  DiodeSymbol,
  LEDSymbol,
  BJTNPNSymbol,
  BJTPNPSymbol,
  MOSFETNSymbol,
  VoltageSourceSymbol,
  CurrentSourceSymbol,
  SineSourceSymbol,
  PulseSourceSymbol,
  PWLSourceSymbol,
  LogicGateSymbol,
  DFlipFlopSymbol,
  GroundSymbol,
} from "./symbols/Symbols.js";
import { symbolForType, symbolByName, symbolBounds } from "@sym/asyParser.js";
import { mapSymbol, AsyGeometry } from "@sym/AsySymbol.js";
import { NODE_SIZE, GRID, rotatePoint, handleForOrder, getLocalPins, getNodePins, edgeRouteHints } from "../pinGeometry.js";
import type { PortType } from "@core/components/special/Special.js";
import { netLabelShape, tagTransform } from "../netLabelShape.js";
import { terminalDirection, terminalTagSide, sampleWire } from "../netTerminalOrientation.js";
import { orthoVertices, type FlowPoint } from "../WireTool.js";
import { captionLayout, captionSide, CAPTION_LINE_HEIGHT, DEFAULT_HALF, LABEL_FONT_SIZE, VALUE_FONT_SIZE } from "../captionLayout.js";
import { DRAG_TOUCH_ACTION, NO_NATIVE_DRAG, isDragPointer, trackPointerDrag } from "../pointerDrag.js";

export type ComponentType =
  | "resistor"
  | "jumper"
  | "capacitor"
  | "capacitor_polarized"
  | "inductor"
  | "diode"
  | "led"
  | "zener"
  | "schottky"
  | "opamp"
  | "logicgate"
  | "dff"
  | "bjt_npn"
  | "bjt_pnp"
  | "mosfet_n"
  | "mosfet_p"
  | "vsource"
  | "isource"
  | "sinesource"
  | "pulsesource"
  | "ground"
  | "junction"
  | "netlabel"
  | "netconnector"
  | "subcircuit";

export interface ComponentNodeData {
  componentType: ComponentType;
  label: string;
  valueLabel?: string;
  rotation?: number;
  /**
   * Horizontal mirror about the symbol's vertical centre line — LTSpice's `M`
   * orientation prefix. Applied *before* `rotation`, as LTSpice does. Pin
   * identity is unchanged (a mirrored NPN keeps its base), only pin *positions*
   * move, so the netlist is unaffected.
   */
  mirrored?: boolean;
  /** For the generalized voltage source: "DC" | "Sine" | "Pulse". */
  sourceType?: string;
  /** For a logic gate: "and" | "or" | "nand" | … — picks the IEC mark drawn. */
  gateType?: string;
  /** Logic-gate input count; the symbol draws one lead per input. */
  inputs?: number;
  /** For a D flip-flop: "rising" | "falling" — picks the clock wedge drawn. */
  edge?: string;
  /** For a D flip-flop: "high" | "low" — bubbles the Set/Reset pins when low. */
  asyncPolarity?: string;
  /** For a D flip-flop: "dff" | "tff" | "dlatch" — picks the data/clock pin names. */
  kind?: string;
  /** Net-connector direction (LTSpice `IOPIN`): "None" | "In" | "Out" | "BiDir". */
  portType?: PortType;
  hasProbe?: boolean;
  /** External pin names for `subcircuit` nodes (drives generated handles). */
  pins?: string[];
  /** Subcircuit/model name shown inside a generic symbol. */
  subName?: string;
  /** Custom `.asy` symbol name to render a subcircuit with (library components). */
  symbolName?: string;
  /** User-dragged label offsets (px, in flow coords) from their default spot. */
  labelOffset?: { x: number; y: number };
  valueOffset?: { x: number; y: number };
  [key: string]: unknown;
}


/**
 * A component caption (reference or value) that sits at its default spot plus a
 * persisted, user-dragged offset. Dragging uses the `nodrag` class so ReactFlow
 * doesn't move the node instead, and divides by zoom to stay 1:1 with the mouse.
 */
function MovableLabel({
  nodeId, kind, base, offset, color, fontSize, fontWeight = 500, transform = "translate(-100%, -50%)",
  maxOffset, clampAround, style, children,
}: {
  nodeId: string;
  kind: "label" | "value";
  base: { left: number; top: number };
  offset?: { x: number; y: number };
  color: string;
  fontSize: number;
  fontWeight?: number;
  transform?: string;
  /** Cap on how far the caption may be dragged (flow px). */
  maxOffset?: number;
  /**
   * Point the `maxOffset` circle is centred on, in the same node-local space as
   * `base`. For a net terminal that is the docking point, not the caption's
   * default spot: the tether belongs to the connection the name describes, so
   * the reachable area stays the same however the default tag position moves.
   * Omitted, the cap is measured from the default spot itself.
   */
  clampAround?: { x: number; y: number };
  /** Extra styling merged in (the net tags draw themselves as a boxed chip). */
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const rf = useReactFlow();
  const setLabelOffset = useCircuitStore((s) => s.setLabelOffset);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const off = live ?? offset ?? { x: 0, y: 0 };

  const onPointerDown = (e: React.PointerEvent) => {
    // The lock pins everything that belongs to a part, its captions included.
    if (canvasLocked || !isDragPointer(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const b = offset ?? { x: 0, y: 0 };
    const zoom = rf.getViewport().zoom || 1;
    const at = (ev: PointerEvent) => {
      let x = b.x + (ev.clientX - sx) / zoom;
      let y = b.y + (ev.clientY - sy) / zoom;
      // Keep the caption tethered: past the cap it slides along the circle of
      // that radius rather than stopping dead, so the drag still tracks.
      if (maxOffset !== undefined) {
        // Measure from `clampAround` when given, so the circle is centred there
        // and not on wherever the caption happens to start.
        const cx = clampAround ? base.left + x - clampAround.x : x;
        const cy = clampAround ? base.top + y - clampAround.y : y;
        const mag = Math.hypot(cx, cy);
        if (mag > maxOffset) {
          const k = maxOffset / mag;
          x += cx * (k - 1);
          y += cy * (k - 1);
        }
      }
      return { x, y };
    };
    trackPointerDrag(
      e,
      (ev) => setLive(at(ev)),
      (ev) => { setLive(null); setLabelOffset(nodeId, kind, at(ev)); },
    );
  };

  return (
    <div
      className="nodrag"
      onPointerDown={onPointerDown}
      title="Drag to move label"
      style={{
        ...DRAG_TOUCH_ACTION,
        position: "absolute",
        left: base.left + off.x,
        top: base.top + off.y,
        transform,
        fontSize, fontWeight, color,
        // Pinned, not `normal`: the CSS `translate(…%)` above resolves against
        // this box, and the SVG export has to reproduce it (see captionLayout).
        lineHeight: CAPTION_LINE_HEIGHT,
        whiteSpace: "nowrap", userSelect: "none", fontFamily: "monospace",
        cursor: "move", zIndex: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

const SYMBOL_MAP: Record<ComponentType, React.FC> = {
  resistor: ResistorSymbol,
  jumper: ResistorSymbol, // unused: the jumper always has its own .asy
  capacitor: CapacitorSymbol,
  capacitor_polarized: CapacitorSymbol, // unused: always has the polcap .asy
  inductor: InductorSymbol,
  diode: DiodeSymbol,
  led: LEDSymbol,
  zener: DiodeSymbol,
  schottky: DiodeSymbol,
  opamp: ResistorSymbol, // unused: opamp always has an .asy symbol
  bjt_npn: BJTNPNSymbol,
  bjt_pnp: BJTPNPSymbol,
  mosfet_n: MOSFETNSymbol,
  mosfet_p: MOSFETNSymbol,
  vsource: VoltageSourceSymbol,
  isource: CurrentSourceSymbol,
  sinesource: SineSourceSymbol,
  pulsesource: PulseSourceSymbol,
  ground: GroundSymbol,
  logicgate: GroundSymbol, // unused: bound with its gate props at the call site
  dff: GroundSymbol, // unused: bound with its flip-flop props at the call site
  junction: GroundSymbol, // unused: a junction is drawn by JunctionNode, which draws nothing
  netlabel: GroundSymbol, // unused: net-label nodes render their own tag
  netconnector: GroundSymbol, // unused: net-connector nodes render their own symbol
  subcircuit: ResistorSymbol, // unused: subcircuit nodes render their own box
};

/**
 * Why every `<Handle>` here passes `isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}`.
 *
 * React Flow gives every handle the `nodrag` class unconditionally, and its drag
 * filter discards any gesture whose target sits inside a `.nodrag`. A connectable
 * handle also carries `connectionindicator`, which is what gives it
 * `pointer-events: all` — so a press on a connector was swallowed by the handle
 * and then excluded from dragging: the part did not move.
 *
 * The flow-level `nodesConnectable={false}` does not reach here: `isConnectable`
 * is a prop of the handle with a default of `true`, and a custom node has to
 * forward it. Passing it explicitly drops `connectionindicator`, the handle falls
 * back to `pointer-events: none`, and the press reaches the node — which is what
 * makes a connector a grab point for its part.
 *
 * It was most visible on a net terminal, whose entire visible body *is* its
 * handle: it could be selected but never moved.
 */
const HANDLE_STYLE = {
  width: 10,
  height: 10,
  background: "#fff",
  border: "2px solid #2563eb",
  borderRadius: "50%",
  zIndex: 10,
};

/** Hand-drawn symbol for the generalized voltage source, chosen by sourceType. */
const SOURCE_SYMBOLS: Record<string, React.FC> = {
  DC: VoltageSourceSymbol,
  Sine: SineSourceSymbol,
  Pulse: PulseSourceSymbol,
  PWL: PWLSourceSymbol,
};

/**
 * Generic box rendering for an imported subcircuit, with one handle per
 * external pin distributed down the left and right edges. Used when no dedicated
 * symbol exists for a `.subckt` (Phase 3 auto symbol generation).
 */
function SubcircuitBox({ nodeId, data, selected }: { nodeId: string; data: ComponentNodeData; selected?: boolean }) {
  const pins = data.pins ?? [];
  const leftCount = Math.ceil(pins.length / 2);
  const left = pins.slice(0, leftCount);
  const right = pins.slice(leftCount);
  const rows = Math.max(left.length, right.length, 1);
  const rowGap = 22;
  const height = rows * rowGap + 24;
  const width = 96;
  const pal = useTheme();
  const color = selected ? "#2563eb" : pal.heading;

  const rowTop = (index: number) => 18 + index * rowGap;

  return (
    <div style={{ position: "relative", width, height }}>
      {left.map((name, i) => (
        <Handle
          key={`l-${name}-${i}`}
          type="source"
          position={Position.Left}
          id={name}
          isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}
          style={{ ...HANDLE_STYLE, top: rowTop(i) }}
        />
      ))}
      {right.map((name, i) => (
        <Handle
          key={`r-${name}-${i}`}
          type="source"
          position={Position.Right}
          id={name}
          isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}
          style={{ ...HANDLE_STYLE, top: rowTop(i) }}
        />
      ))}
      <svg width={width} height={height} style={{ overflow: "visible", color }}>
        <rect
          x={10}
          y={4}
          width={width - 20}
          height={height - 8}
          rx={4}
          fill={selected ? pal.boxFillSel : pal.boxFill}
          stroke={color}
          strokeWidth={1.6}
        />
        {left.map((name, i) => (
          <text key={`lt-${i}`} x={16} y={rowTop(i) + 4} fontSize={9} fill={color} stroke="none">
            {name}
          </text>
        ))}
        {right.map((name, i) => (
          <text key={`rt-${i}`} x={width - 16} y={rowTop(i) + 4} fontSize={9} fill={color} stroke="none" textAnchor="end">
            {name}
          </text>
        ))}
        <text x={width / 2} y={height / 2 + 3} fontSize={11} fontWeight={600} textAnchor="middle" fill={color} stroke="none">
          {data.subName ?? "X"}
        </text>
      </svg>
      <MovableLabel
        nodeId={nodeId} kind="label" base={{ left: -6, top: height / 2 }} offset={data.labelOffset}
        color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
      >
        {data.label}
      </MovableLabel>
    </div>
  );
}

/**
 * Renders a subcircuit-style library component using its own parsed `.asy`
 * symbol. Handles are keyed by the subcircuit's external pin names (matching the
 * netlist pin order via SpiceOrder), so wiring and net mapping stay identical to
 * {@link SubcircuitBox} – only the graphics differ.
 */
function LibrarySymbolNode({
  sym,
  data,
  nodeId,
  selected,
}: {
  sym: AsySymbol;
  data: ComponentNodeData;
  nodeId: string;
  selected?: boolean;
}) {
  const rotation = data.rotation ?? 0;
  const mirrored = !!data.mirrored;
  const pins = data.pins ?? [];
  const pal = useTheme();
  const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
  const center = NODE_SIZE / 2;
  const bounds = symbolBounds(sym);
  const halfW = (bounds.width / 2) * mapping.scale;
  // Which flank the captions hug: the one with fewer pins, so a label does not
  // sit in the wires. Taken from the *rotated* pins, so turning the part moves
  // the caption with it.
  const side = captionSide(getLocalPins(data));
  const halfH = (bounds.height / 2) * mapping.scale;

  return (
    <div style={{ position: "relative", width: NODE_SIZE, height: NODE_SIZE, cursor: "pointer" }}>
      {mapping.pins.map((pin) => {
        // Map the symbol's SpiceOrder onto the subcircuit's declared pin name.
        const handleId = pins[pin.order - 1] ?? `pin${pin.order}`;
        const [hx, hy] = rotatePoint(mirrored ? NODE_SIZE - pin.px : pin.px, pin.py, center, center, rotation);
        return (
          <Handle
            key={handleId}
            type="source"
            position={Position.Top}
            id={handleId}
            isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}
            style={{ ...HANDLE_STYLE, left: hx, top: hy, transform: "translate(-50%, -50%)" }}
          />
        );
      })}
      <svg
        width={NODE_SIZE}
        height={NODE_SIZE}
        style={{
          color: selected ? "#2563eb" : pal.symStroke,
          overflow: "visible",
          transform: `${rotation ? `rotate(${rotation}deg) ` : ""}${mirrored ? "scaleX(-1)" : ""}`.trim() || undefined,
          transition: "transform 0.15s ease",
        }}
      >
        {selected && (
          <rect
            x={4} y={4} width={NODE_SIZE - 8} height={NODE_SIZE - 8} rx={4}
            fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 2" opacity={0.5}
          />
        )}
        <AsyGeometry sym={sym} mapping={mapping} strokeWidth={1.6} />
      </svg>
      {(() => { const l = captionLayout("label", rotation, halfW, halfH, side); return (
        <MovableLabel
          nodeId={nodeId} kind="label" base={l} transform={l.transform} offset={data.labelOffset}
          color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
        >
          {data.label}
        </MovableLabel>
      ); })()}
    </div>
  );
}

/** Net-id badges shown at each pin of the selected component (e.g. "1: net2"). */
function PinNetLabels({ nodeId, data }: { nodeId: string; data: ComponentNodeData }) {
  const circuit = useCircuitStore((s) => s.circuit);
  // Re-render when net assignments change (bumped on connect/rebuild).
  useCircuitStore((s) => s.netVersion);
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const pal = useTheme();

  const comp = circuit.components.get(nodeId);
  if (!comp) return null;
  const pins = getLocalPins(data, symbolNorm);

  return (
    <>
      {pins.map((pin) => {
        const port = comp.ports.find((p) => p.id === `${nodeId}-${pin.handleId}`);
        const netId = port?.netId ?? null;
        const label = netId ? (circuit.nets.get(netId)?.nodeLabel ?? netId) : "—";
        const leftSide = pin.px <= NODE_SIZE / 2;
        return (
          <div
            key={pin.handleId}
            style={{
              position: "absolute",
              left: pin.px,
              top: pin.py,
              transform: `translate(${leftSide ? "-100%" : "0"}, -50%)`,
              [leftSide ? "marginLeft" : "marginRight"]: -4,
              padding: "0 3px",
              fontSize: 9,
              lineHeight: "13px",
              fontFamily: "monospace",
              color: pal.badgeText,
              background: pal.badgeBg,
              border: `1px solid ${pal.badgeBorder}`,
              borderRadius: 3,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              userSelect: "none",
              zIndex: 15,
            }}
          >
            {pin.order}:{label}
          </div>
        );
      })}
    </>
  );
}

/** Renders a node backed by a parsed LTSpice `.asy` symbol with pin-accurate handles. */
function AsyComponentNode({
  sym,
  data,
  nodeId,
  selected,
}: {
  sym: AsySymbol;
  data: ComponentNodeData;
  nodeId: string;
  selected?: boolean;
}) {
  const rotation = data.rotation ?? 0;
  const mirrored = !!data.mirrored;
  const pal = useTheme();
  const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
  const center = NODE_SIZE / 2;
  // Drawn symbol half-extents in px, to place captions right against the shape.
  const bounds = symbolBounds(sym);
  const halfW = (bounds.width / 2) * mapping.scale;
  // Which flank the captions hug: the one with fewer pins, so a label does not
  // sit in the wires. Taken from the *rotated* pins, so turning the part moves
  // the caption with it.
  const side = captionSide(getLocalPins(data));
  const halfH = (bounds.height / 2) * mapping.scale;

  return (
    <div style={{ position: "relative", width: NODE_SIZE, height: NODE_SIZE, cursor: "pointer" }}>
      {selected && <PinNetLabels nodeId={nodeId} data={data} />}
      {mapping.pins.map((pin) => {
        const [hx, hy] = rotatePoint(mirrored ? NODE_SIZE - pin.px : pin.px, pin.py, center, center, rotation);
        return (
          <Handle
            key={pin.order}
            type="source"
            position={Position.Top}
            id={handleForOrder(data.componentType, pin.order)}
            isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}
            style={{ ...HANDLE_STYLE, left: hx, top: hy, transform: "translate(-50%, -50%)" }}
          />
        );
      })}
      <svg
        width={NODE_SIZE}
        height={NODE_SIZE}
        style={{
          color: selected ? "#2563eb" : pal.symStroke,
          overflow: "visible",
          transform: `${rotation ? `rotate(${rotation}deg) ` : ""}${mirrored ? "scaleX(-1)" : ""}`.trim() || undefined,
          transition: "transform 0.15s ease",
        }}
      >
        {selected && (
          <rect
            x={4} y={4} width={NODE_SIZE - 8} height={NODE_SIZE - 8} rx={4}
            fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 2" opacity={0.5}
          />
        )}
        <AsyGeometry sym={sym} mapping={mapping} strokeWidth={1.6} />
      </svg>

      {(() => { const l = captionLayout("label", rotation, halfW, halfH, side); return (
        <MovableLabel
          nodeId={nodeId} kind="label" base={l} transform={l.transform} offset={data.labelOffset}
          color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
        >
          {data.label}
        </MovableLabel>
      ); })()}
      {data.valueLabel && (() => { const l = captionLayout("value", rotation, halfW, halfH, side); return (
        <MovableLabel
          nodeId={nodeId} kind="value" base={l} transform={l.transform} offset={data.valueOffset}
          color={selected ? "#1d4ed8" : pal.value} fontSize={VALUE_FONT_SIZE}
        >
          {data.valueLabel}
        </MovableLabel>
      ); })()}
    </div>
  );
}

/**
 * The axis a net terminal's symbol should extend along: away from the wire
 * attached to its dock, so the name never runs back across its own net.
 *
 * The far end of each wire is its first waypoint when it has one, otherwise the
 * pin at the other end — the waypoint is what the wire's *first segment* aims
 * at, which is the piece that actually leaves the dock.
 */
function useTerminalLayout(nodeId: string): { dir: FlowPoint; side: 1 | -1 } {
  const nodes = useCircuitStore((s) => s.nodes);
  const edges = useCircuitStore((s) => s.edges);
  const symbolNorm = useUIStore((s) => s.symbolNorm);

  return useMemo(() => {
    const self = nodes.find((n) => n.id === nodeId);
    if (!self) return { dir: { x: 0, y: -1 }, side: -1 as const };
    const dock = { x: self.position.x + NODE_SIZE / 2, y: self.position.y + NODE_SIZE / 2 };

    const pinAt = (id: string | null | undefined, handle: string | null | undefined) => {
      const n = id ? nodes.find((x) => x.id === id) : undefined;
      if (!n || !handle) return null;
      return getNodePins(n, symbolNorm).find((p) => p.handleId === handle) ?? null;
    };

    const farEnds: FlowPoint[] = [];
    for (const e of edges) {
      const atSource = e.source === nodeId;
      if (!atSource && e.target !== nodeId) continue;
      const waypoints = (e.data?.waypoints as FlowPoint[] | undefined) ?? [];
      // Waypoints are stored source → target, so walk them from our own end.
      const first = atSource ? waypoints[0] : waypoints[waypoints.length - 1];
      if (first) { farEnds.push(first); continue; }
      const far = atSource ? pinAt(e.target, e.targetHandle) : pinAt(e.source, e.sourceHandle);
      if (far) farEnds.push({ x: far.x, y: far.y });
    }

    // Tapped onto an existing wire: our own edge ends at the tap point, which is
    // the dock — zero length, so it says nothing about direction. The wire we sit
    // on does: take *its* two ends, which straddle the dock and so read as a wire
    // running through it (see terminalDirection).
    for (const e of edges) {
      if (e.source !== nodeId && e.target !== nodeId) continue;
      const hostId = (e.data as { hostEdgeId?: string } | undefined)?.hostEdgeId;
      const host = hostId ? edges.find((h) => h.id === hostId) : undefined;
      if (!host) continue;
      for (const end of [pinAt(host.source, host.sourceHandle), pinAt(host.target, host.targetHandle)]) {
        if (end) farEnds.push({ x: end.x, y: end.y });
      }
    }
    const dir = terminalDirection(dock, farEnds);
    // Which side across the wire is free: the centres of everything else on the
    // sheet are enough to tell — a part or another terminal sitting there is
    // what the name has to dodge.
    const neighbours = nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => ({ x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 }));
    // The wires count too: a run passing above the terminal is as much in the
    // way as a part, and it is what the name most often collided with.
    for (const e of edges) {
      if (e.source === nodeId || e.target === nodeId) continue;   // our own lead
      const a = (e.data?.sourceTap as FlowPoint | undefined) ?? pinAt(e.source, e.sourceHandle);
      const b = (e.data?.targetTap as FlowPoint | undefined) ?? pinAt(e.target, e.targetHandle);
      if (!a || !b) continue;
      const wp = (e.data?.waypoints as FlowPoint[] | undefined) ?? [];
      neighbours.push(...sampleWire(orthoVertices([a, ...wp, b], edgeRouteHints(nodes, e, symbolNorm)), dock));
    }
    return { dir, side: terminalTagSide(dock, dir, neighbours) };
  }, [nodes, edges, nodeId, symbolNorm]);
}

/**
 * Net-label terminal (LTSpice `FLAG name`) and net connector (`FLAG` + `IOPIN`):
 * a single connection point with the net name in a tag. Placing two with the
 * same name connects those nets.
 *
 * The two share this renderer because they *are* the same picture — a docking
 * circle plus a name tag — differing only in the connector's direction arrow and
 * the tag tint that tells them apart at a glance. The port type drives the
 * arrow: `None` draws none, so a connector set to `None` looks like a label.
 *
 * Which way the symbol faces is recomputed from the wiring on every render
 * rather than stored, the way LTSpice does it (see terminalDirection).
 */
function NetTerminalNode({ nodeId, data, selected }: { nodeId: string; data: ComponentNodeData; selected?: boolean }) {
  const c = NODE_SIZE / 2;
  const isConnector = data.componentType === "netconnector";
  const name = data.label || (isConnector ? "PORT" : "NET");
  const pal = useTheme();
  const color = selected ? "#2563eb" : pal.netLabelStroke;
  const { dir, side } = useTerminalLayout(nodeId);
  // A plain net label has no direction, so it always renders the `None` shape.
  const portType: PortType = isConnector ? (data.portType as PortType) ?? "BiDir" : "None";
  const shape = netLabelShape(portType, dir, side);
  // Tag position mirrors netLabelShape's anchor/baseline.
  const tagBase = { left: shape.tag.x, top: shape.tag.y, transform: tagTransform(shape.tag) };
  return (
    <div
      draggable={false}
      style={{ ...NO_NATIVE_DRAG, position: "relative", width: NODE_SIZE, height: NODE_SIZE, cursor: "pointer" }}
    >
      {/* No tap-to-rotate here, unlike a component: the symbol has one fixed
          orientation, so the gesture would be a silent no-op. */}
      {/* The handle is the connection anchor and is never drawn — `opacity`
          hides it without taking it out of the layout the wiring measures
          against. What is drawn sits in the svg below: a connector shows the
          port circle, a plain label does not. A label only gives the net a
          name, and its tag already marks the spot; a connector is an interface
          point, and the circle is what says so. */}
      <Handle
        type="source" position={Position.Top} id="t"
        isConnectable={false} isConnectableStart={false} isConnectableEnd={false}
        style={{ ...HANDLE_STYLE, left: c, top: c, transform: "translate(-50%, -50%)", opacity: 0 }}
      />
      <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", color }}>
        {portType !== "None" && (
          <circle
            cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r}
            fill={pal.panelBg} stroke={color} strokeWidth={2}
          />
        )}
        {shape.stem && (
          <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
        )}
        {shape.heads.map((points, i) => <polygon key={i} points={points} fill={color} />)}
      </svg>
      {/* The name is the terminal's body: fixed at its computed spot, and with
          it the surface you grab to move the terminal. It used to float free of
          the dock, but that position was never written to the `.asc` — it
          survived only in a share link, so the same schematic looked different
          depending on how it was opened. Nothing is stored now, and the side is
          chosen from what is around it (see terminalTagSide). */}
      <div
        style={{
          position: "absolute",
          left: tagBase.left, top: tagBase.top, transform: tagBase.transform,
          padding: "1px 6px", borderRadius: 4,
          fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap",
          color: pal.netTagText,
          background: isConnector
            ? (selected ? pal.portTagBgSel : pal.portTagBg)
            : (selected ? pal.netTagBgSel : pal.netTagBg),
          border: `1px solid ${selected ? "#2563eb" : pal.netTagBorder}`,
          userSelect: "none", pointerEvents: "none",
        }}
      >
        {name}
      </div>
    </div>
  );
}

/**
 * A point where wires meet that is not a part's pin (see Junction).
 *
 * It draws nothing. The wires running into it already show the connection, and
 * that is exactly how the same spot looked before junctions existed — the
 * segments were plain lines with no node behind them. Only its handle is here,
 * because that is what the wires attach to; it is transparent rather than
 * absent, so React Flow still measures it where the wiring expects.
 *
 * Selected, it shows a small ring — otherwise a junction picked with the pointer
 * would give no sign of having been picked.
 */
function JunctionNode({ selected }: { selected?: boolean }) {
  const c = NODE_SIZE / 2;
  return (
    <div style={{ ...NO_NATIVE_DRAG, position: "relative", width: NODE_SIZE, height: NODE_SIZE }}>
      <Handle
        type="source" position={Position.Top} id="j"
        isConnectable={false} isConnectableStart={false} isConnectableEnd={false}
        style={{ ...HANDLE_STYLE, left: c, top: c, transform: "translate(-50%, -50%)", opacity: 0 }}
      />
      {selected && (
        <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", position: "absolute", inset: 0 }}>
          <circle cx={c} cy={c} r={4} fill="none" stroke="#2563eb" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

export const ComponentNode = memo(({ id, data, selected }: NodeProps) => {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const pal = useTheme();
  const nodeData = data as ComponentNodeData;
  if (nodeData.componentType === "junction") {
    return <JunctionNode selected={selected} />;
  }
  if (nodeData.componentType === "netlabel" || nodeData.componentType === "netconnector") {
    return <NetTerminalNode nodeId={id} data={nodeData} selected={selected} />;
  }
  if (nodeData.componentType === "subcircuit") {
    const libSym = nodeData.symbolName ? symbolByName(nodeData.symbolName, symbolNorm) : undefined;
    if (libSym) {
      return <LibrarySymbolNode sym={libSym} data={nodeData} nodeId={id} selected={selected} />;
    }
    return <SubcircuitBox nodeId={id} data={nodeData} selected={selected} />;
  }
  const asySym = symbolForType(nodeData.componentType, symbolNorm);
  if (asySym) {
    return <AsyComponentNode sym={asySym} data={nodeData} nodeId={id} selected={selected} />;
  }
  // Everything else is looked up from the tables, whose entries keep the same
  // identity across renders.
  const TableSymbol =
    nodeData.componentType === "vsource"
      ? SOURCE_SYMBOLS[nodeData.sourceType ?? "DC"] ?? VoltageSourceSymbol
      : SYMBOL_MAP[nodeData.componentType] ?? ResistorSymbol;
  // The digital parts are the symbols whose drawing depends on their properties
  // (gate mark and lead count; clock edge and Set/Reset polarity), so they are
  // bound with those props here rather than looked up bare.
  //
  // Bound as an *element*, not by wrapping them in a component. A wrapper
  // declared here would be a fresh function — and so, to React, a different
  // component type — on every render, which tore down and rebuilt the whole
  // symbol subtree each time. Harmless in effect, since these symbols are pure
  // SVG with no state or effects to lose, but pointless DOM churn on every
  // flip-flop and gate on the sheet.
  const symbolElement =
    nodeData.componentType === "dff"
      ? <DFlipFlopSymbol edge={nodeData.edge} asyncPolarity={nodeData.asyncPolarity} kind={nodeData.kind} />
      : nodeData.componentType === "logicgate"
      ? <LogicGateSymbol gate={nodeData.gateType} inputs={nodeData.inputs} />
      : <TableSymbol />;
  const rotation = nodeData.rotation ?? 0;
  const mirrored = !!nodeData.mirrored;
  const isGround = nodeData.componentType === "ground";
  // Only parts without an .asy reach here (the symbol path returns above), so
  // this is the whole hand-drawn set: sources, ground and the digital parts.
  const pins = getLocalPins(nodeData, symbolNorm);
  // See LibrarySymbolNode: captions hug the flank with fewer pins.
  const side = captionSide(pins);

  return (
    <div
      style={{
        position: "relative",
        width: 80,
        height: 80,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      {selected && <PinNetLabels nodeId={id} data={nodeData} />}
      {/* Every part drawn by hand rather than from an .asy places its connectors
          from the same pin table the wiring uses. Keeping a second, hand-written
          handle layout beside it drifted: the terminals of a source sat 2 px off
          its pins and ground's a full grid step, the digital parts had no
          terminals at all, and none of them followed the symbol when it turned —
          a rotated voltage source drew upside down with its connectors still at
          top and bottom. */}
      {pins.map((pin) => (
        <Handle
          key={pin.handleId}
          type="source"
          position={Position.Top}
          id={pin.handleId}
          isConnectable={false}
            isConnectableStart={false}
            isConnectableEnd={false}
          style={{ ...HANDLE_STYLE, left: pin.px, top: pin.py, transform: "translate(-50%, -50%)" }}
        />
      ))}
      <svg
        width="80"
        height="80"
        viewBox="-40 -40 80 80"
        style={{
          color: selected ? "#2563eb" : "currentColor",
          overflow: "visible",
          transform: `${rotation ? `rotate(${rotation}deg) ` : ""}${mirrored ? "scaleX(-1)" : ""}`.trim() || undefined,
          transition: "transform 0.15s ease",
        }}
      >
        {selected && (
          <rect
            x="-36" y="-36" width="72" height="72" rx="4"
            fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 2" opacity={0.6}
          />
        )}
        {symbolElement}
      </svg>

      {/* Reference label (R1, C1, …); ground has no label */}
      {!isGround && (() => { const l = captionLayout("label", rotation, DEFAULT_HALF.w, DEFAULT_HALF.h, side); return (
        <MovableLabel
          nodeId={id} kind="label" base={l} transform={l.transform} offset={nodeData.labelOffset}
          color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
        >
          {nodeData.label}
        </MovableLabel>
      ); })()}

      {/* Value label (1kΩ, 100nF, 5V …) */}
      {nodeData.valueLabel && !isGround && (() => { const l = captionLayout("value", rotation, DEFAULT_HALF.w, DEFAULT_HALF.h, side); return (
        <MovableLabel
          nodeId={id} kind="value" base={l} transform={l.transform} offset={nodeData.valueOffset}
          color={selected ? "#1d4ed8" : pal.value} fontSize={VALUE_FONT_SIZE}
        >
          {nodeData.valueLabel}
        </MovableLabel>
      ); })()}
    </div>
  );
});

ComponentNode.displayName = "ComponentNode";
