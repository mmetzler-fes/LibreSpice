import { memo, useState } from "react";
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
  GroundSymbol,
} from "./symbols/Symbols.js";
import { symbolForType, symbolByName, symbolBounds } from "@sym/asyParser.js";
import { mapSymbol, AsyGeometry } from "@sym/AsySymbol.js";
import { NODE_SIZE, GRID, rotatePoint, handleForOrder, getLocalPins } from "../pinGeometry.js";
import { netLabelShape } from "../netLabelShape.js";
import { captionLayout, CAPTION_LINE_HEIGHT, DEFAULT_HALF, LABEL_FONT_SIZE, VALUE_FONT_SIZE } from "../captionLayout.js";
import { DRAG_TOUCH_ACTION, NO_NATIVE_DRAG, isDragPointer, trackPointerDrag } from "../pointerDrag.js";

export type ComponentType =
  | "resistor"
  | "capacitor"
  | "capacitor_polarized"
  | "inductor"
  | "diode"
  | "led"
  | "zener"
  | "schottky"
  | "opamp"
  | "bjt_npn"
  | "bjt_pnp"
  | "mosfet_n"
  | "mosfet_p"
  | "vsource"
  | "isource"
  | "sinesource"
  | "pulsesource"
  | "ground"
  | "netlabel"
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
  /** Net-label variant: `true` draws a direction arrow (connector to a distant
   *  same-named net); default/`false` is a plain wire name tag. */
  connector?: boolean;
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
  nodeId, kind, base, offset, color, fontSize, fontWeight = 500, transform = "translate(-100%, -50%)", children,
}: {
  nodeId: string;
  kind: "label" | "value";
  base: { left: number; top: number };
  offset?: { x: number; y: number };
  color: string;
  fontSize: number;
  fontWeight?: number;
  transform?: string;
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
    const at = (ev: PointerEvent) => ({ x: b.x + (ev.clientX - sx) / zoom, y: b.y + (ev.clientY - sy) / zoom });
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
      }}
    >
      {children}
    </div>
  );
}

const SYMBOL_MAP: Record<ComponentType, React.FC> = {
  resistor: ResistorSymbol,
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
  netlabel: GroundSymbol, // unused: net-label nodes render their own tag
  subcircuit: ResistorSymbol, // unused: subcircuit nodes render their own box
};

const HANDLE_STYLE = {
  width: 10,
  height: 10,
  background: "#fff",
  border: "2px solid #2563eb",
  borderRadius: "50%",
  zIndex: 10,
};

/** Props spread onto a connector (Handle) for the tap-to-rotate gesture. */
type TapProps = { onClick?: (e: React.MouseEvent) => void };

/**
 * Connector tap-to-rotate: in *select* mode, a plain tap/click on a component's
 * connector rotates it 90° left — a touch/pen-friendly alternative to Ctrl+R,
 * since the component body is used for dragging. A drag from a connector (to draw
 * a wire) fires no click, so wiring is unaffected. Outside select mode it returns
 * empty props, leaving the connector's normal behavior intact.
 */
function useRotateTapProps(nodeId: string): TapProps {
  const editorMode = useUIStore((s) => s.editorMode);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const rotateComponent = useCircuitStore((s) => s.rotateComponent);
  // A locked canvas pins the parts: rotating one by tapping its connector would
  // be a move the lock is supposed to prevent.
  if (editorMode !== "select" || canvasLocked) return {};
  return { onClick: (e) => { e.stopPropagation(); rotateComponent(nodeId); } };
}

const TWO_PORT_TYPES: ComponentType[] = [
  "resistor", "capacitor", "capacitor_polarized", "inductor", "diode", "led",
  "vsource", "isource", "sinesource", "pulsesource",
];
const THREE_PORT_TYPES: ComponentType[] = ["bjt_npn", "bjt_pnp", "mosfet_n", "mosfet_p"];
const SOURCE_TYPES: ComponentType[] = ["vsource", "sinesource", "pulsesource"];

/** Hand-drawn symbol for the generalized voltage source, chosen by sourceType. */
const SOURCE_SYMBOLS: Record<string, React.FC> = {
  DC: VoltageSourceSymbol,
  Sine: SineSourceSymbol,
  Pulse: PulseSourceSymbol,
};

function getHandles(type: ComponentType, mirrored = false, tap: TapProps = {}) {
  // Ground: one source handle at the top (ConnectionMode.Loose allows source↔source)
  if (type === "ground") {
    // Dock at the top of the vertical line (symbol y=-20 → local 20 in the 80px box).
    return (
      <Handle
        type="source"
        position={Position.Top}
        id="gnd"
        style={{ ...HANDLE_STYLE, left: 40, top: 20, transform: "translate(-50%, -50%)" }}
        {...tap}
      />
    );
  }
  if (SOURCE_TYPES.includes(type)) {
    // Dock at the terminal tips (symbol terminals at y -30/+30 → local 10/70).
    return (
      <>
        <Handle type="source" position={Position.Top} id="p" style={{ ...HANDLE_STYLE, left: 40, top: 10, transform: "translate(-50%, -50%)" }} {...tap} />
        <Handle type="source" position={Position.Bottom} id="n" style={{ ...HANDLE_STYLE, left: 40, top: 70, transform: "translate(-50%, -50%)" }} {...tap} />
      </>
    );
  }
  if (TWO_PORT_TYPES.includes(type)) {
    return (
      <>
        <Handle type="source" position={Position.Top} id="p" style={HANDLE_STYLE} {...tap} />
        <Handle type="source" position={Position.Bottom} id="n" style={HANDLE_STYLE} {...tap} />
      </>
    );
  }
  if (THREE_PORT_TYPES.includes(type)) {
    // ids must match the SpiceComponent port suffixes: drain/collector, gate/base, source/emitter
    const isMos = type === "mosfet_n" || type === "mosfet_p";
    const top = isMos ? "d" : "c";
    const left = isMos ? "g" : "b";
    const bottom = isMos ? "s" : "e";
    // Horizontal mirror moves the side (gate/base) pin to the opposite edge so
    // the handle tracks the flipped symbol.
    return (
      <>
        <Handle type="source" position={Position.Top} id={top} style={HANDLE_STYLE} {...tap} />
        <Handle type="source" position={mirrored ? Position.Right : Position.Left} id={left} style={HANDLE_STYLE} {...tap} />
        <Handle type="source" position={Position.Bottom} id={bottom} style={HANDLE_STYLE} {...tap} />
      </>
    );
  }
  return null;
}

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
  const tap = useRotateTapProps(nodeId);
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
          style={{ ...HANDLE_STYLE, top: rowTop(i) }}
          {...tap}
        />
      ))}
      {right.map((name, i) => (
        <Handle
          key={`r-${name}-${i}`}
          type="source"
          position={Position.Right}
          id={name}
          style={{ ...HANDLE_STYLE, top: rowTop(i) }}
          {...tap}
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
  const tap = useRotateTapProps(nodeId);
  const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
  const center = NODE_SIZE / 2;
  const bounds = symbolBounds(sym);
  const halfW = (bounds.width / 2) * mapping.scale;
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
            style={{ ...HANDLE_STYLE, left: hx, top: hy, transform: "translate(-50%, -50%)" }}
            {...tap}
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
      {(() => { const l = captionLayout("label", rotation, halfW, halfH); return (
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
  const tap = useRotateTapProps(nodeId);
  const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
  const center = NODE_SIZE / 2;
  // Drawn symbol half-extents in px, to place captions right against the shape.
  const bounds = symbolBounds(sym);
  const halfW = (bounds.width / 2) * mapping.scale;
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
            style={{ ...HANDLE_STYLE, left: hx, top: hy, transform: "translate(-50%, -50%)" }}
            {...tap}
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

      {(() => { const l = captionLayout("label", rotation, halfW, halfH); return (
        <MovableLabel
          nodeId={nodeId} kind="label" base={l} transform={l.transform} offset={data.labelOffset}
          color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
        >
          {data.label}
        </MovableLabel>
      ); })()}
      {data.valueLabel && (() => { const l = captionLayout("value", rotation, halfW, halfH); return (
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
 * Net-label terminal (LTSpice `FLAG name`): a single connection point with the
 * net name in a tag. Placing two with the same name connects those nets.
 */
function NetLabelNode({ nodeId, data, selected }: { nodeId: string; data: ComponentNodeData; selected?: boolean }) {
  const c = NODE_SIZE / 2;
  const name = data.label || "NET";
  const pal = useTheme();
  const tap = useRotateTapProps(nodeId);
  const color = selected ? "#2563eb" : pal.netLabelStroke;
  // "connector" = draw the direction arrow (joins distant parts on one net
  // without a wire); default = a plain net label that just names a wire.
  const isConnector = !!data.connector;
  const shape = netLabelShape(data.rotation ?? 0);
  // Tag position mirrors netLabelShape's anchor/baseline (the Handle itself is
  // the hollow terminal circle, so we only draw the arrow + tag here).
  const tagStyle: React.CSSProperties = shape.tag.baseline === "middle"
    ? { left: shape.tag.x, top: shape.tag.y, transform: "translate(0, -50%)" }
    : { left: shape.tag.x, top: shape.tag.y, transform: "translate(-50%, -100%)" };
  return (
    <div
      draggable={false}
      style={{ ...NO_NATIVE_DRAG, position: "relative", width: NODE_SIZE, height: NODE_SIZE, cursor: "pointer" }}
    >
      <Handle type="source" position={Position.Top} id="t" style={{ ...HANDLE_STYLE, left: c, top: c, transform: "translate(-50%, -50%)" }} {...tap} />
      <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", color }}>
        {isConnector && (
          <>
            <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
            <polygon points={shape.head} fill={color} />
          </>
        )}
      </svg>
      <div
        draggable={false}
        style={{
          ...NO_NATIVE_DRAG,
          position: "absolute", ...tagStyle,
          padding: "1px 6px", borderRadius: 4, fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap",
          background: selected ? pal.netTagBgSel : pal.netTagBg, color: pal.netTagText,
          border: `1px solid ${selected ? "#2563eb" : pal.netTagBorder}`,
        }}
      >
        {name}
      </div>
    </div>
  );
}

export const ComponentNode = memo(({ id, data, selected }: NodeProps) => {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const pal = useTheme();
  const tap = useRotateTapProps(id);
  const nodeData = data as ComponentNodeData;
  if (nodeData.componentType === "netlabel") {
    return <NetLabelNode nodeId={id} data={nodeData} selected={selected} />;
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
  const SymbolComponent =
    nodeData.componentType === "vsource"
      ? SOURCE_SYMBOLS[nodeData.sourceType ?? "DC"] ?? VoltageSourceSymbol
      : SYMBOL_MAP[nodeData.componentType] ?? ResistorSymbol;
  const rotation = nodeData.rotation ?? 0;
  const mirrored = !!nodeData.mirrored;
  const isGround = nodeData.componentType === "ground";

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
      {getHandles(nodeData.componentType, mirrored, tap)}
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
        <SymbolComponent />
      </svg>

      {/* Reference label (R1, C1, …); ground has no label */}
      {!isGround && (() => { const l = captionLayout("label", rotation, DEFAULT_HALF.w, DEFAULT_HALF.h); return (
        <MovableLabel
          nodeId={id} kind="label" base={l} transform={l.transform} offset={nodeData.labelOffset}
          color={selected ? "#2563eb" : pal.label} fontSize={LABEL_FONT_SIZE} fontWeight={selected ? 600 : 500}
        >
          {nodeData.label}
        </MovableLabel>
      ); })()}

      {/* Value label (1kΩ, 100nF, 5V …) */}
      {nodeData.valueLabel && !isGround && (() => { const l = captionLayout("value", rotation, DEFAULT_HALF.w, DEFAULT_HALF.h); return (
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
