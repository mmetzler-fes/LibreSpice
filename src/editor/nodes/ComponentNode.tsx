import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
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

export type ComponentType =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "diode"
  | "led"
  | "bjt_npn"
  | "bjt_pnp"
  | "mosfet_n"
  | "mosfet_p"
  | "vsource"
  | "isource"
  | "sinesource"
  | "pulsesource"
  | "ground";

export interface ComponentNodeData {
  componentType: ComponentType;
  label: string;
  valueLabel?: string;   // e.g. "1kΩ", "100nF", "5V SIN"
  rotation?: number;
  [key: string]: unknown;
}

const SYMBOL_MAP: Record<ComponentType, React.FC> = {
  resistor: ResistorSymbol,
  capacitor: CapacitorSymbol,
  inductor: InductorSymbol,
  diode: DiodeSymbol,
  led: LEDSymbol,
  bjt_npn: BJTNPNSymbol,
  bjt_pnp: BJTPNPSymbol,
  mosfet_n: MOSFETNSymbol,
  mosfet_p: MOSFETNSymbol,
  vsource: VoltageSourceSymbol,
  isource: CurrentSourceSymbol,
  sinesource: SineSourceSymbol,
  pulsesource: PulseSourceSymbol,
  ground: GroundSymbol,
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

function getHandles(type: ComponentType) {
  // Ground: one source handle at the top (ConnectionMode.Loose allows source↔source)
  if (type === "ground") {
    return (
      <Handle type="source" position={Position.Top} id="gnd" style={HANDLE_STYLE} />
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
    return (
      <>
        <Handle type="source" position={Position.Top} id="collector" style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Left} id="base" style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Bottom} id="emitter" style={HANDLE_STYLE} />
      </>
    );
  }
  return null;
}

export const ComponentNode = memo(({ data, selected }: NodeProps) => {
  const nodeData = data as ComponentNodeData;
  const SymbolComponent = SYMBOL_MAP[nodeData.componentType] ?? ResistorSymbol;
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
