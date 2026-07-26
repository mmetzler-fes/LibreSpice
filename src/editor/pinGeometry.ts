import type { Node } from "@xyflow/react";
import { symbolByName, symbolForType, type SymbolNorm } from "@sym/asyParser.js";
import { mapSymbol } from "@sym/AsySymbol.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import { outwardAxis, outwardDir, type Axis, type Pt, type RouteHints, type Box } from "@core/geometry/ortho.js";
import { isJK } from "@core/components/digital/DFlipFlop.js";

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
  jumper: ["p", "n"],
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
  jfet_n: ["d", "g", "s"],
  jfet_p: ["d", "g", "s"],
  opamp: ["inp", "inn", "vcc", "vee", "out"],
  ground: ["gnd"],
  junction: ["j"],
  netlabel: ["t"],
  netconnector: ["t"],
  // The flip-flop's ids match DFlipFlop.createPorts; the logic gate's input
  // count varies, so its handles are built per instance (see digitalPins).
  // A JK has a seventh ("k"); its handles are built per instance, like the gate's.
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
  // A junction is nothing but its connection point, so the pin is the centre.
  junction: [{ handleId: "j", order: 1, px: NODE_SIZE / 2, py: NODE_SIZE / 2 }],
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
  // The JFET's drain and source leave to the right of the channel, as njf.asy
  // draws them, so their terminals sit 32 px right of centre and not on the
  // channel bar — see JFETNSymbol.
  jfet_n: [
    { handleId: "d", order: 1, px: NODE_SIZE / 2 + 32, py: 0 },
    { handleId: "g", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "s", order: 3, px: NODE_SIZE / 2 + 32, py: NODE_SIZE },
  ],
  jfet_p: [
    { handleId: "d", order: 1, px: NODE_SIZE / 2 + 32, py: 0 },
    { handleId: "g", order: 2, px: 0, py: NODE_SIZE / 2 },
    { handleId: "s", order: 3, px: NODE_SIZE / 2 + 32, py: NODE_SIZE },
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
    // The JK has three pins down the left edge; every other kind has two. Same
    // heights for J and K, the clock between them (see DFlipFlop.createPorts).
    if (isJK(data.kind ?? "")) {
      return [
        at("d", 1, -32, -24), at("k", 2, -32, 24), at("clk", 3, -32, 0),
        at("set", 4, 0, -48), at("rst", 5, 0, 48),
        at("q", 6, 32, -24), at("qn", 7, 32, 24),
      ];
    }
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
  // A library part has no symbol *for its type* — it carries its own `.asy` by
  // name, and its handles are the subcircuit's declared pin names in SpiceOrder
  // (the same mapping ComponentNode's LibrarySymbolNode draws its handles from).
  // Left out of here, a `pot` or an `LM317` had no pins as far as the wire tool,
  // the SVG export and the pin re-seating were concerned: the export drew
  // neither the part nor any wire touching it, and the wire tool would not snap
  // to it.
  const libSym = data.componentType === "subcircuit" && data.symbolName
    ? symbolByName(data.symbolName, norm)
    : undefined;
  const sym = libSym ?? symbolForType(data.componentType, norm);
  if (sym) {
    const mapping = mapSymbol(sym, NODE_SIZE, 0, GRID, true);
    const c = NODE_SIZE / 2;
    const rotation = data.rotation ?? 0;
    return mapping.pins.map((pin) => {
      const [px, py] = rotatePoint(flip(pin.px), pin.py, c, c, rotation);
      const handleId = libSym
        ? (data.pins?.[pin.order - 1] ?? `pin${pin.order}`)
        : handleForOrder(data.componentType, pin.order);
      return { handleId, order: pin.order, px, py };
    });
  }
  const digital = data.componentType === "dff" || data.componentType === "logicgate";
  const pins = digital ? digitalPins(data) : FALLBACK_PINS[data.componentType] ?? [];
  // The hand-drawn symbols turn with the node just as an .asy one does, so their
  // pins turn with it too. Without this a rotated voltage source drew upside
  // down while its terminals stayed where they were, so a wire left the wrong
  // end of the symbol — and the same held for a rotated ground.
  const rotation = data.rotation ?? 0;
  const c = NODE_SIZE / 2;
  return pins.map((p) => {
    const [px, py] = rotatePoint(flip(p.px), p.py, c, c, rotation);
    return { ...p, px, py };
  });
}

/**
 * The axis a wire should leave this node's pin along, or undefined when the pin
 * offers no direction (a ground or a net terminal, which is its part's only pin).
 * Feeds the wire router, so a lead goes out of the symbol instead of running
 * along its flank.
 */
export function pinOutwardAxis(node: Node, handleId: string, norm: SymbolNorm = "default"): Axis | undefined {
  const data = node.data as ComponentNodeData;
  if (!data) return undefined;
  const pins = getLocalPins(data, norm);
  const pin = pins.find((p) => p.handleId === handleId);
  if (!pin) return undefined;
  return outwardAxis({ x: pin.px, y: pin.py }, pins.map((p) => ({ x: p.px, y: p.py })));
}

/** The same, as a unit step: which way leads out of the part (see outwardDir). */
export function pinOutwardDir(node: Node, handleId: string, norm: SymbolNorm = "default"): Pt | undefined {
  const data = node.data as ComponentNodeData;
  if (!data) return undefined;
  const pins = getLocalPins(data, norm);
  const pin = pins.find((p) => p.handleId === handleId);
  if (!pin) return undefined;
  return outwardDir({ x: pin.px, y: pin.py }, pins.map((p) => ({ x: p.px, y: p.py })));
}

/**
 * Route hints for one wire, from the parts its two ends sit on. The single place
 * that decides this, so the canvas, the SVG export and the `.asc` exporter all
 * draw a wire the same way — they route it independently.
 *
 * An end that taps an existing wire is not on a pin and contributes nothing.
 */
export function edgeRouteHints(
  nodes: Node[],
  edge: { source?: string; sourceHandle?: string | null; target?: string; targetHandle?: string | null; data?: unknown },
  norm: SymbolNorm = "default",
): RouteHints {
  const d = edge.data as { sourceTap?: unknown; targetTap?: unknown } | undefined;
  const axis = (id?: string, handle?: string | null) => {
    if (!id || !handle) return undefined;
    const node = nodes.find((n) => n.id === id);
    return node ? pinOutwardAxis(node, handle, norm) : undefined;
  };
  const dir = (id?: string, handle?: string | null) => {
    if (!id || !handle) return undefined;
    const node = nodes.find((n) => n.id === id);
    return node ? pinOutwardDir(node, handle, norm) : undefined;
  };
  return {
    startAxis: d?.sourceTap ? undefined : axis(edge.source, edge.sourceHandle),
    endAxis: d?.targetTap ? undefined : axis(edge.target, edge.targetHandle),
    startDir: d?.sourceTap ? undefined : dir(edge.source, edge.sourceHandle),
    endDir: d?.targetTap ? undefined : dir(edge.target, edge.targetHandle),
    obstacles: nodeBodies(nodes, norm),
  };
}

/**
 * How far a part's body reaches past its terminals, across the line they sit on.
 *
 * A two-terminal part's pins share one coordinate, so the box they span is a line
 * with no width — nothing a route could run "through". The drawn body does have
 * width, and this is it, near enough: a resistor is about 16 px across, a source
 * 40, and a route pushed 10 px clear of the terminal line is out of both.
 */
const BODY_HALF = 10;

/**
 * The parts' bodies, as boxes a wire should not be routed through.
 *
 * Taken from the terminals rather than from the artwork: every part has pins in
 * the same coordinate system, whether it is drawn from an `.asy`, from a
 * hand-coded symbol or not yet drawn at all. The box is the span of the pins,
 * widened only where that span is flat — along the pins' own line it must stay
 * exact, or a wire arriving at a terminal the proper way would count as running
 * into the part.
 *
 * Parts with a single pin (ground, a name, a junction) have no body to speak of
 * and are left out; a wire is meant to reach those.
 */
export function nodeBodies(nodes: Node[], norm: SymbolNorm = "default"): Box[] {
  const out: Box[] = [];
  for (const n of nodes) {
    const pins = getNodePins(n, norm);
    if (pins.length < 2) continue;
    const xs = pins.map((p) => p.x), ys = pins.map((p) => p.y);
    const x1 = Math.min(...xs), x2 = Math.max(...xs);
    const y1 = Math.min(...ys), y2 = Math.max(...ys);
    out.push({
      x1: x1 === x2 ? x1 - BODY_HALF : x1,
      x2: x1 === x2 ? x2 + BODY_HALF : x2,
      y1: y1 === y2 ? y1 - BODY_HALF : y1,
      y2: y1 === y2 ? y2 + BODY_HALF : y2,
    });
  }
  return out;
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
  if (!data) return [];
  return getLocalPins(data, norm).map((p) => ({
    nodeId: node.id,
    handleId: p.handleId,
    x: node.position.x + p.px,
    y: node.position.y + p.py,
  }));
}
