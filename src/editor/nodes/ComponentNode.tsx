import { memo, useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useUIStore } from "@store/uiStore.js";
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
import { symbolForType, symbolBounds } from "@sym/asyParser.js";
import { mapSymbol, AsyGeometry } from "@sym/AsySymbol.js";
import { NODE_SIZE, NODE_MARGIN, rotatePoint, handleForOrder, getLocalPins } from "../pinGeometry.js";

export type ComponentType =
  | "resistor"
  | "capacitor"
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
  | "subcircuit";

export interface ComponentNodeData {
  componentType: ComponentType;
  label: string;
  valueLabel?: string;
  rotation?: number;
  /** For the generalized voltage source: "DC" | "Sine" | "Pulse". */
  sourceType?: string;
  hasProbe?: boolean;
  /** External pin names for `subcircuit` nodes (drives generated handles). */
  pins?: string[];
  /** Subcircuit/model name shown inside a generic symbol. */
  subName?: string;
  /** User-dragged label offsets (px, in flow coords) from their default spot. */
  labelOffset?: { x: number; y: number };
  valueOffset?: { x: number; y: number };
  [key: string]: unknown;
}

/** Gap (px) between a caption and the symbol's drawn bounding box. */
const CAPTION_GAP = 5;
/** Fallback half-extents for symbols we can't measure (hand-drawn fallbacks). */
const DEFAULT_HALF = { w: 18, h: 26 };

/**
 * Readable caption placement that hugs the symbol's actual shape: captions sit
 * just left of a narrow part (e.g. resistor) or further out for a wide one
 * (e.g. voltage source), and move above/below when the part lies horizontal.
 * Text always stays upright. `halfW`/`halfH` are the drawn symbol's pixel
 * half-extents (before rotation).
 */
function captionLayout(
  kind: "label" | "value",
  rotation: number,
  halfW: number,
  halfH: number,
): { left: number; top: number; transform: string } {
  const c = NODE_SIZE / 2;
  const horizontal = rotation === 90 || rotation === 270;
  const extentX = horizontal ? halfH : halfW; // horizontal reach after rotation
  const extentY = horizontal ? halfW : halfH; // vertical reach after rotation
  if (horizontal) {
    // Above / below the part, centered.
    return kind === "label"
      ? { left: c, top: c - extentY - CAPTION_GAP, transform: "translate(-50%, -100%)" }
      : { left: c, top: c + extentY + CAPTION_GAP, transform: "translate(-50%, 0)" };
  }
  // Left of the part, stacked near the vertical centre.
  const rightEdge = c - extentX - CAPTION_GAP;
  return kind === "label"
    ? { left: rightEdge, top: c - 8, transform: "translate(-100%, -50%)" }
    : { left: rightEdge, top: c + 9, transform: "translate(-100%, -50%)" };
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
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const off = live ?? offset ?? { x: 0, y: 0 };

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const b = offset ?? { x: 0, y: 0 };
    const zoom = rf.getViewport().zoom || 1;
    const at = (ev: MouseEvent) => ({ x: b.x + (ev.clientX - sx) / zoom, y: b.y + (ev.clientY - sy) / zoom });
    const move = (ev: MouseEvent) => setLive(at(ev));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setLive(null);
      setLabelOffset(nodeId, kind, at(ev));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="nodrag"
      onMouseDown={onMouseDown}
      title="Drag to move label"
      style={{
        position: "absolute",
        left: base.left + off.x,
        top: base.top + off.y,
        transform,
        fontSize, fontWeight, color,
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

const TWO_PORT_TYPES: ComponentType[] = [
  "resistor", "capacitor", "inductor", "diode", "led",
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

function getHandles(type: ComponentType) {
  // Ground: one source handle at the top (ConnectionMode.Loose allows source↔source)
  if (type === "ground") {
    // Dock at the top of the vertical line (symbol y=-20 → local 20 in the 80px box).
    return (
      <Handle
        type="source"
        position={Position.Top}
        id="gnd"
        style={{ ...HANDLE_STYLE, left: 40, top: 20, transform: "translate(-50%, -50%)" }}
      />
    );
  }
  if (SOURCE_TYPES.includes(type)) {
    // Dock at the terminal tips (symbol terminals at y -30/+30 → local 10/70).
    return (
      <>
        <Handle type="source" position={Position.Top} id="p" style={{ ...HANDLE_STYLE, left: 40, top: 10, transform: "translate(-50%, -50%)" }} />
        <Handle type="source" position={Position.Bottom} id="n" style={{ ...HANDLE_STYLE, left: 40, top: 70, transform: "translate(-50%, -50%)" }} />
      </>
    );
  }
  if (TWO_PORT_TYPES.includes(type)) {
    return (
      <>
        <Handle type="source" position={Position.Top} id="p" style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Bottom} id="n" style={HANDLE_STYLE} />
      </>
    );
  }
  if (THREE_PORT_TYPES.includes(type)) {
    // ids must match the SpiceComponent port suffixes: drain/collector, gate/base, source/emitter
    const isMos = type === "mosfet_n" || type === "mosfet_p";
    const top = isMos ? "d" : "c";
    const left = isMos ? "g" : "b";
    const bottom = isMos ? "s" : "e";
    return (
      <>
        <Handle type="source" position={Position.Top} id={top} style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Left} id={left} style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Bottom} id={bottom} style={HANDLE_STYLE} />
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
  const color = selected ? "#2563eb" : "#475569";

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
        />
      ))}
      {right.map((name, i) => (
        <Handle
          key={`r-${name}-${i}`}
          type="source"
          position={Position.Right}
          id={name}
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
          fill={selected ? "#eff6ff" : "#f8fafc"}
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
        color={selected ? "#2563eb" : "#374151"} fontSize={11} fontWeight={selected ? 600 : 500}
      >
        {data.label}
      </MovableLabel>
    </div>
  );
}

/** Net-id badges shown at each pin of the selected component (e.g. "1: net2"). */
function PinNetLabels({ nodeId, data }: { nodeId: string; data: ComponentNodeData }) {
  const circuit = useCircuitStore((s) => s.circuit);
  // Re-render when net assignments change (bumped on connect/rebuild).
  useCircuitStore((s) => s.netVersion);
  const symbolNorm = useUIStore((s) => s.symbolNorm);

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
              color: "#1d4ed8",
              background: "rgba(255,255,255,0.85)",
              border: "1px solid #bfdbfe",
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
  const mapping = mapSymbol(sym, NODE_SIZE, NODE_MARGIN);
  const center = NODE_SIZE / 2;
  // Drawn symbol half-extents in px, to place captions right against the shape.
  const bounds = symbolBounds(sym);
  const halfW = (bounds.width / 2) * mapping.scale;
  const halfH = (bounds.height / 2) * mapping.scale;

  return (
    <div style={{ position: "relative", width: NODE_SIZE, height: NODE_SIZE, cursor: "pointer" }}>
      {selected && <PinNetLabels nodeId={nodeId} data={data} />}
      {mapping.pins.map((pin) => {
        const [hx, hy] = rotatePoint(pin.px, pin.py, center, center, rotation);
        return (
          <Handle
            key={pin.order}
            type="source"
            position={Position.Top}
            id={handleForOrder(data.componentType, pin.order)}
            style={{ ...HANDLE_STYLE, left: hx, top: hy, transform: "translate(-50%, -50%)" }}
          />
        );
      })}
      <svg
        width={NODE_SIZE}
        height={NODE_SIZE}
        style={{
          color: selected ? "#2563eb" : "#0f172a",
          overflow: "visible",
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
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
          color={selected ? "#2563eb" : "#374151"} fontSize={11} fontWeight={selected ? 600 : 500}
        >
          {data.label}
        </MovableLabel>
      ); })()}
      {data.valueLabel && (() => { const l = captionLayout("value", rotation, halfW, halfH); return (
        <MovableLabel
          nodeId={nodeId} kind="value" base={l} transform={l.transform} offset={data.valueOffset}
          color={selected ? "#1d4ed8" : "#6b7280"} fontSize={10}
        >
          {data.valueLabel}
        </MovableLabel>
      ); })()}
    </div>
  );
}

export const ComponentNode = memo(({ id, data, selected }: NodeProps) => {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const nodeData = data as ComponentNodeData;
  if (nodeData.componentType === "subcircuit") {
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
      {getHandles(nodeData.componentType)}
      <svg
        width="80"
        height="80"
        viewBox="-40 -40 80 80"
        style={{
          color: selected ? "#2563eb" : "currentColor",
          overflow: "visible",
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
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
          color={selected ? "#2563eb" : "#374151"} fontSize={11} fontWeight={selected ? 600 : 500}
        >
          {nodeData.label}
        </MovableLabel>
      ); })()}

      {/* Value label (1kΩ, 100nF, 5V …) */}
      {nodeData.valueLabel && !isGround && (() => { const l = captionLayout("value", rotation, DEFAULT_HALF.w, DEFAULT_HALF.h); return (
        <MovableLabel
          nodeId={id} kind="value" base={l} transform={l.transform} offset={nodeData.valueOffset}
          color={selected ? "#1d4ed8" : "#6b7280"} fontSize={10}
        >
          {nodeData.valueLabel}
        </MovableLabel>
      ); })()}
    </div>
  );
});

ComponentNode.displayName = "ComponentNode";
