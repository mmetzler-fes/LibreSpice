import type { Node } from "@xyflow/react";
import { symbolForType, type SymbolNorm } from "@sym/asyParser.js";
import { mapSymbol } from "@sym/AsySymbol.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";

/** Editor node box size in px (also the React Flow node footprint). */
export const NODE_SIZE = 80;
/** Margin used when fitting an .asy symbol into the node box. */
export const NODE_MARGIN = 14;

export function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/**
 * Ordered handle ids per component type, in SPICE pin order. Each id MUST match
 * the suffix of the corresponding `Port` id (e.g. resistor port `R1-p` → "p"),
 * otherwise `Circuit.connectPorts` cannot resolve the wire endpoints.
 */
export const PORT_HANDLES: Partial<Record<ComponentType, string[]>> = {
  resistor: ["p", "n"],
  capacitor: ["p", "n"],
  inductor: ["p", "n"],
  vsource: ["p", "n"],
  isource: ["p", "n"],
  sinesource: ["p", "n"],
  pulsesource: ["p", "n"],
  diode: ["a", "k"],
  led: ["a", "k"],
  zener: ["a", "k"],
  schottky: ["a", "k"],
  bjt_npn: ["c", "b", "e"],
  bjt_pnp: ["c", "b", "e"],
  mosfet_n: ["d", "g", "s"],
  mosfet_p: ["d", "g", "s"],
  opamp: ["inp", "inn", "vcc", "vee", "out"],
  ground: ["gnd"],
};

/** Handle id for a given component type and 1-based SPICE pin order. */
export function handleForOrder(type: ComponentType, order: number): string {
  return PORT_HANDLES[type]?.[order - 1] ?? `pin${order}`;
}

export interface LocalPin {
  handleId: string;
  /** 1-based SPICE pin order. */
  order: number;
  /** Pin position in node-local px (top-left origin of the NODE_SIZE box). */
  px: number;
  py: number;
}

/** Fixed handle layout for components drawn with hand-coded fallback symbols. */
const SOURCE_PINS: LocalPin[] = [
  { handleId: "p", order: 1, px: NODE_SIZE / 2, py: 10 },
  { handleId: "n", order: 2, px: NODE_SIZE / 2, py: NODE_SIZE - 10 },
];

const FALLBACK_PINS: Partial<Record<ComponentType, LocalPin[]>> = {
  ground: [{ handleId: "gnd", order: 1, px: NODE_SIZE / 2, py: 20 }],
  vsource: SOURCE_PINS,
  sinesource: SOURCE_PINS,
  pulsesource: SOURCE_PINS,
  bjt_npn: [
    { handleId: "c", order: 1, px: NODE_SIZE / 2, py: 0 },
    { handleId: "b", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "e", order: 3, px: NODE_SIZE / 2, py: NODE_SIZE },
  ],
  bjt_pnp: [
    { handleId: "c", order: 1, px: NODE_SIZE / 2, py: 0 },
    { handleId: "b", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "e", order: 3, px: NODE_SIZE / 2, py: NODE_SIZE },
  ],
  mosfet_n: [
    { handleId: "d", order: 1, px: NODE_SIZE / 2, py: 0 },
    { handleId: "g", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "s", order: 3, px: NODE_SIZE / 2, py: NODE_SIZE },
  ],
  mosfet_p: [
    { handleId: "d", order: 1, px: NODE_SIZE / 2, py: 0 },
    { handleId: "g", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "s", order: 3, px: NODE_SIZE / 2, py: NODE_SIZE },
  ],
};

/** Node-local pin positions, accounting for rotation of `.asy` symbols. */
export function getLocalPins(data: ComponentNodeData, norm: SymbolNorm = "default"): LocalPin[] {
  const sym = symbolForType(data.componentType, norm);
  if (sym) {
    const mapping = mapSymbol(sym, NODE_SIZE, NODE_MARGIN);
    const c = NODE_SIZE / 2;
    const rotation = data.rotation ?? 0;
    return mapping.pins.map((pin) => {
      const [px, py] = rotatePoint(pin.px, pin.py, c, c, rotation);
      return { handleId: handleForOrder(data.componentType, pin.order), order: pin.order, px, py };
    });
  }
  return FALLBACK_PINS[data.componentType] ?? [];
}

export interface NodePin {
  nodeId: string;
  handleId: string;
  /** Pin position in flow coordinates. */
  x: number;
  y: number;
}

/** All pin positions for a node in flow coordinates. */
export function getNodePins(node: Node, norm: SymbolNorm = "default"): NodePin[] {
  const data = node.data as ComponentNodeData;
  if (!data || data.componentType === "subcircuit") return [];
  return getLocalPins(data, norm).map((p) => ({
    nodeId: node.id,
    handleId: p.handleId,
    x: node.position.x + p.px,
    y: node.position.y + p.py,
  }));
}
