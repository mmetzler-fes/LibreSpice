import type { Node } from "@xyflow/react";
import { symbolForType, type SymbolNorm } from "@sym/asyParser.js";
import { mapSymbol } from "@sym/AsySymbol.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";

/** Editor node box size in px (also the React Flow node footprint). */
export const NODE_SIZE = 80;
/** Margin used when fitting an .asy symbol into the node box. */
export const NODE_MARGIN = 14;
/**
 * Editor snap pitch in px; component pins snap to it, so they sit on grid lines
 * and can meet a wire (a tap needs ~2 px accuracy).
 *
 * 4 divides every pitch LTSpice draws on — its 16-unit schematic grid and the
 * 12-unit spacing alike — so every point of an imported schematic is reachable.
 * Measured over the bundled examples, the GCD of all wire/flag/symbol
 * coordinates is exactly 4 (98% are multiples of 16, but two schematics go down
 * to 4), so a coarser pitch would leave points we could never land on.
 */
export const GRID = 4;

/**
 * Spacing of the drawn grid dots. Deliberately coarser than the snap pitch: it
 * mirrors LTSpice's 16-unit schematic grid as a visual reference, while
 * placement still snaps to every {@link GRID} step in between.
 */
export const GRID_DOTS = 16;

/** CSS px per centimetre (96 px = 1 inch), for offsets specified in real units. */
export const PX_PER_CM = 96 / 2.54;

/**
 * Node-local y of the ground terminal (the top of its stem). A multiple of GRID,
 * so a placed ground lands on a grid line — at the old 20 px it was off the grid
 * and could never be dropped onto a wire.
 */
export const GROUND_PIN_Y = 24;

/**
 * Snap a flow coordinate to the grid. The single definition on purpose: the
 * placement ghost and the actual placement must agree to the pixel, or the ghost
 * points at a docking spot the component never lands on — the ghost used to carry
 * its own 20 px grid, so a net-label connector missed the wire it was aimed at.
 */
export function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

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
  capacitor_polarized: ["p", "n"],
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
  netlabel: ["t"],
  netconnector: ["t"],
  // The flip-flop's ids match DFlipFlop.createPorts; the logic gate's input
  // count varies, so its handles are built per instance (see digitalPins).
  dff: ["d", "clk", "set", "rst", "q", "qn"],
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

/**
 * Fixed handle layout for components drawn with hand-coded fallback symbols.
 * Every offset is a multiple of {@link GRID}: the node box is placed on the grid,
 * so a grid-aligned local offset puts the terminal on a grid line — which is what
 * lets it meet a wire.
 */
const SOURCE_PINS: LocalPin[] = [
  { handleId: "p", order: 1, px: NODE_SIZE / 2, py: 8 },
  { handleId: "n", order: 2, px: NODE_SIZE / 2, py: NODE_SIZE - 8 },
];

const FALLBACK_PINS: Partial<Record<ComponentType, LocalPin[]>> = {
  ground: [{ handleId: "gnd", order: 1, px: NODE_SIZE / 2, py: GROUND_PIN_Y }],
  // Both net terminals dock at the node centre, so the connection point does not
  // move when the symbol's arrow turns.
  netlabel: [{ handleId: "t", order: 1, px: NODE_SIZE / 2, py: NODE_SIZE / 2 }],
  netconnector: [{ handleId: "t", order: 1, px: NODE_SIZE / 2, py: NODE_SIZE / 2 }],
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

/**
 * Pins of the two digital parts, which have no `.asy` and whose pin *count*
 * depends on their properties — so they cannot live in the static table above.
 *
 * The offsets are node-centre-relative and deliberately the same numbers as the
 * components' own `createPorts` (LogicGate, DFlipFlop) and as `ltspiceGeometry`'s
 * `PIN_OFFSETS`. All three have to agree: the component decides the netlist, this
 * decides where a wire may dock, and the geometry table decides where an imported
 * `.asc` puts the pin. A disagreement leaves a part whose wires miss its pins.
 */
function digitalPins(data: ComponentNodeData): LocalPin[] {
  const c = NODE_SIZE / 2;
  const at = (handleId: string, order: number, dx: number, dy: number): LocalPin =>
    ({ handleId, order, px: c + dx, py: c + dy });

  if (data.componentType === "dff") {
    return [
      at("d", 1, -32, -24), at("clk", 2, -32, 24),
      at("set", 3, 0, -48), at("rst", 4, 0, 48),
      at("q", 5, 32, -24), at("qn", 6, 32, 24),
    ];
  }
  // Logic gate: inputs spread down the left edge, output centred on the right.
  const single = data.gateType === "not" || data.gateType === "buffer";
  const n = single ? 1 : (data.inputs ?? 2);
  const span = 48;
  const pins = Array.from({ length: n }, (_, i) =>
    at(`in${i + 1}`, i + 1, -32, n === 1 ? 0 : Math.round(-span / 2 + (span * i) / (n - 1))),
  );
  pins.push(at("out", n + 1, 32, 0));
  return pins;
}

/**
 * Node-local pin positions, accounting for the symbol's orientation. Mirror is
 * applied *before* rotation, exactly as LTSpice's `M<deg>` is defined — the two
 * do not commute, so flipping afterwards placed the pins of every mirrored,
 * rotated part on the wrong side.
 */
export function getLocalPins(data: ComponentNodeData, norm: SymbolNorm = "default"): LocalPin[] {
  const mirrored = !!data.mirrored;
  const flip = (px: number) => (mirrored ? NODE_SIZE - px : px);
  const sym = symbolForType(data.componentType, norm);
  if (sym) {
    const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
    const c = NODE_SIZE / 2;
    const rotation = data.rotation ?? 0;
    return mapping.pins.map((pin) => {
      const [px, py] = rotatePoint(flip(pin.px), pin.py, c, c, rotation);
      return { handleId: handleForOrder(data.componentType, pin.order), order: pin.order, px, py };
    });
  }
  const digital = data.componentType === "dff" || data.componentType === "logicgate";
  const pins = digital ? digitalPins(data) : FALLBACK_PINS[data.componentType] ?? [];
  // The hand-drawn symbols turn with the node just as an .asy one does, so their
  // pins have to turn with it too. Only the digital parts are rotated here: the
  // rest of the fallback table is grounds, sources and transistors, whose pins
  // the rest of the editor has always taken un-rotated, and quietly moving them
  // would re-route existing schematics.
  const rotation = digital ? data.rotation ?? 0 : 0;
  const c = NODE_SIZE / 2;
  return pins.map((p) => {
    const [px, py] = rotatePoint(flip(p.px), p.py, c, c, rotation);
    return { ...p, px, py };
  });
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
