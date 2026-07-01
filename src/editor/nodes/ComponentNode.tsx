import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
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
import { symbolForType } from "@sym/asyParser.js";
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
  [key: string]: unknown;
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
function SubcircuitBox({ data, selected }: { data: ComponentNodeData; selected?: boolean }) {
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
      <div
        style={{
          position: "absolute",
          top: -14,
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 11,
          whiteSpace: "nowrap",
          userSelect: "none",
          fontFamily: "monospace",
          color: selected ? "#2563eb" : "#374151",
          fontWeight: selected ? 600 : 500,
        }}
      >
        {data.label}
      </div>
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

      <div
        style={{
          position: "absolute", top: -16, left: "50%", transform: "translateX(-50%)",
          fontSize: 11, whiteSpace: "nowrap", userSelect: "none", fontFamily: "monospace",
          color: selected ? "#2563eb" : "#374151", fontWeight: selected ? 600 : 500,
        }}
      >
        {data.label}
      </div>
      {data.valueLabel && (
        <div
          style={{
            position: "absolute", bottom: -18, left: "50%", transform: "translateX(-50%)",
            fontSize: 10, whiteSpace: "nowrap", userSelect: "none", fontFamily: "monospace",
            color: selected ? "#1d4ed8" : "#6b7280",
          }}
        >
          {data.valueLabel}
        </div>
      )}
    </div>
  );
}

export const ComponentNode = memo(({ id, data, selected }: NodeProps) => {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const nodeData = data as ComponentNodeData;
  if (nodeData.componentType === "subcircuit") {
    return <SubcircuitBox data={nodeData} selected={selected} />;
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

      {/* Reference label (R1, C1, …) – above for ground, below for others */}
      {!isGround && (
        <div
          style={{
            position: "absolute",
            top: -16,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            whiteSpace: "nowrap",
            userSelect: "none",
            fontFamily: "monospace",
            color: selected ? "#2563eb" : "#374151",
            fontWeight: selected ? 600 : 500,
          }}
        >
          {nodeData.label}
        </div>
      )}

      {/* Value label (1kΩ, 100nF, 5V …) – below the symbol */}
      {nodeData.valueLabel && !isGround && (
        <div
          style={{
            position: "absolute",
            bottom: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10,
            whiteSpace: "nowrap",
            userSelect: "none",
            fontFamily: "monospace",
            color: selected ? "#1d4ed8" : "#6b7280",
          }}
        >
          {nodeData.valueLabel}
        </div>
      )}
    </div>
  );
});

ComponentNode.displayName = "ComponentNode";
