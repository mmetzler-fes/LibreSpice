import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { symbolByName } from "@sym/asyParser.js";
import { GROUND_PIN_Y } from "@editor/pinGeometry.js";

/**
 * Shared LTSpice symbol geometry used by both the parser (`.asc` → schematic)
 * and the exporter (schematic → `.asc`), so the two are exact inverses and a
 * save/load round-trips to the same circuit.
 */

/** Node box half-size; the LTSpice symbol origin maps to the node's centre. */
export const CENTER = 40;

export const SYMBOL_TO_TYPE: Record<string, ComponentType> = {
  // A jumper is a piece of wire in LTSpice; here it is a part of its own, a
  // resistor of 1 uOhm behind the symbol (see library/sym/jumper.asy). It needs
  // its own type rather than being folded into "resistor": the pin geometry
  // hangs off the type, and a resistor's pins sit elsewhere — so the part landed
  // on no wire at all and quietly broke the branch it was meant to close.
  jumper: "jumper",
  res: "resistor", cap: "capacitor", polcap: "capacitor_polarized", ind: "inductor",
  // The IEC/European symbol set (`Misc\EuropeanResistor`, …) draws the same
  // devices with the same pins. Without these, an IEC schematic fell back to the
  // 2-pin default and lost the symbol it was drawn with.
  europeanpolcap: "capacitor_polarized",
  europeanresistor: "resistor", europeancap: "capacitor", europeancapacitor: "capacitor",
  europeaninductor: "inductor", europeanind: "inductor",
  diode: "diode", LED: "led", zener: "zener", schottky: "schottky",
  npn: "bjt_npn", pnp: "bjt_pnp",
  nmos: "mosfet_n", pmos: "mosfet_p",
  voltage: "vsource", current: "isource",
  opamp: "opamp", opamp2: "opamp", universalopamp: "opamp", universalopamp2: "opamp",
  // LTSpice's Digital library; the exact gate comes from our own attribute.
  and: "logicgate", or: "logicgate", nand: "logicgate", nor: "logicgate",
  xor: "logicgate", xnor: "logicgate", inv: "logicgate", buf: "logicgate",
  dflop: "dff", dflipflop: "dff", srflop: "dff",
};

const SYMBOL_TO_TYPE_LC: Record<string, ComponentType> = Object.fromEntries(
  Object.entries(SYMBOL_TO_TYPE).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Resolve an LTSpice SYMBOL name to a component type. Strips any library
 * subdirectory (`Misc\EuropeanPolcap` → `EuropeanPolcap`) and matches
 * case-insensitively, so path-qualified and mixed-case names still map.
 */
export function symbolToType(symName: string): ComponentType | undefined {
  const base = (symName.split(/[\\/]/).pop() ?? symName).toLowerCase();
  const direct = SYMBOL_TO_TYPE_LC[base];
  if (direct) return direct;
  // LTSpice ships localized / suffixed variants of the generic op-amp symbol
  // (UniversalOpAmp2_EN, _DE, …). They all use the same 5-pin `level2` model, so
  // map any UniversalOpAmp* to the op-amp instead of silently falling back to a
  // resistor (which drops three pins and breaks the whole circuit).
  if (base.startsWith("universalopamp")) return "opamp";
  // LTSpice ships localized copies of the generic symbols with a locale suffix
  // (e.g. `current_EN`, `voltage_DE`). Strip a trailing `_XX` and retry so they
  // don't fall through to the resistor default, dropping their waveform/pins.
  const stripped = base.replace(/_[a-z]{2}$/, "");
  if (stripped !== base && SYMBOL_TO_TYPE_LC[stripped]) return SYMBOL_TO_TYPE_LC[stripped];
  return undefined;
}

export const TYPE_TO_SYMBOL: Record<string, string> = {
  jumper: "jumper",
  resistor: "res", capacitor: "cap", capacitor_polarized: "polcap", inductor: "ind",
  // Zener/Schottky are diodes with their own LTSpice symbols; without an entry
  // here they fell back to "res" and came back from a saved file as resistors.
  diode: "diode", led: "LED", zener: "zener", schottky: "schottky",
  bjt_npn: "npn", bjt_pnp: "pnp",
  mosfet_n: "nmos", mosfet_p: "pmos",
  vsource: "voltage", isource: "current",
  sinesource: "voltage", pulsesource: "voltage",
  opamp: "UniversalOpAmp2",
  // Overridden per gate by the exporter (Digital\\and, \\or, …); this is the fallback.
  logicgate: "Digital\\and",
  dff: "Digital\\dflop",
};

export interface PinOffset { handle: string; dx: number; dy: number }

/**
 * Pin positions in LTSpice symbol-local coordinates (offset from the symbol
 * origin, before rotation). Mirror LTSpice's stock `.asy` terminals — the
 * origin sits at a corner, so the offsets are asymmetric. Handles must match
 * the component's Port ids (see pinGeometry.PORT_HANDLES).
 */
export const PIN_OFFSETS: Record<string, PinOffset[]> = {
  // Two pins on one horizontal line, 64 apart — the spacing the shipped
  // schematics were drawn to (measured from the wires that stop either side of
  // the jumpers in 05-2-1_Leistungsanpassung1.asc, both agreeing).
  jumper: [
    { handle: "p", dx: -32, dy: 64 },
    { handle: "n", dx: 32, dy: 64 },
  ],
  resistor: [{ handle: "p", dx: 16, dy: 16 }, { handle: "n", dx: 16, dy: 96 }],
  capacitor: [{ handle: "p", dx: 16, dy: 0 }, { handle: "n", dx: 16, dy: 64 }],
  capacitor_polarized: [{ handle: "p", dx: 16, dy: 0 }, { handle: "n", dx: 16, dy: 64 }],
  inductor: [{ handle: "p", dx: 16, dy: 16 }, { handle: "n", dx: 16, dy: 96 }],
  diode: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  led: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  zener: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  schottky: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  vsource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  // LTSpice's current.asy puts "+" (SpiceOrder 1) at the *top* (`PIN 0 0`) and
  // "-" at the bottom (`PIN 0 80`) — same way round as its voltage source, and as
  // our own current_ANSI.asy. Having it the other way round silently reversed
  // every imported current source: a `.dc` over a base current then drove the
  // current *out* of the base, so the transistor never turned on (Ib came back
  // negative and the operating point ran away).
  isource: [{ handle: "p", dx: 0, dy: 0 }, { handle: "n", dx: 0, dy: 80 }],
  sinesource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  pulsesource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  // BJT/MOSFET terminals as in LTSpice's npn/pnp/nmos/pmos symbols (origin at
  // top-left): base/gate on the left, collector/drain top-right, emitter/source
  // bottom-right.
  bjt_npn: [{ handle: "c", dx: 64, dy: 0 }, { handle: "b", dx: 0, dy: 48 }, { handle: "e", dx: 64, dy: 96 }],
  bjt_pnp: [{ handle: "c", dx: 64, dy: 0 }, { handle: "b", dx: 0, dy: 48 }, { handle: "e", dx: 64, dy: 96 }],
  mosfet_n: [{ handle: "d", dx: 48, dy: 0 }, { handle: "g", dx: 0, dy: 80 }, { handle: "s", dx: 48, dy: 96 }],
  mosfet_p: [{ handle: "d", dx: 48, dy: 0 }, { handle: "g", dx: 0, dy: 80 }, { handle: "s", dx: 48, dy: 96 }],
  // UniversalOpAmp2 terminals (LTSpice symbol-local, origin at the centre):
  //   In+ (-32,16)  In- (-32,-16)  V+ (0,-32)  V- (0,32)  OUT (32,0)
  opamp: [
    { handle: "inp", dx: -32, dy: 16 },
    { handle: "inn", dx: -32, dy: -16 },
    { handle: "vcc", dx: 0, dy: -32 },
    { handle: "vee", dx: 0, dy: 32 },
    { handle: "out", dx: 32, dy: 0 },
  ],
  // D flip-flop, mirroring DFlipFlop.createPorts: data in and clock on the left,
  // Q and ~Q on the right, the asynchronous pins above and below.
  dff: [
    { handle: "d", dx: -32, dy: -24 },
    { handle: "clk", dx: -32, dy: 24 },
    { handle: "set", dx: 0, dy: -48 },
    { handle: "rst", dx: 0, dy: 48 },
    { handle: "q", dx: 32, dy: -24 },
    { handle: "qn", dx: 32, dy: 24 },
  ],
};

/** Ground's node is offset so its single terminal lands on the FLAG point. */
export const GROUND_PIN: PinOffset = { handle: "gnd", dx: CENTER, dy: GROUND_PIN_Y };

/**
 * An LTSpice symbol orientation: `R<deg>` (regular) or `M<deg>` (mirrored).
 * `M` means the symbol is flipped horizontally about its own origin *first*,
 * then rotated by the angle — that order matters, since mirror and rotation do
 * not commute (M∘R(θ) == R(-θ)∘M). The whole app follows LTSpice's order.
 */
export interface Orientation { deg: number; mirrored: boolean }

/** Parse a SYMBOL orientation field (`R0`, `R90`, `M0`, `M270`, …). */
export function parseRot(rot: string): Orientation {
  const m = /^([RM])(\d+)$/.exec((rot ?? "").trim().toUpperCase());
  if (!m) return { deg: 0, mirrored: false };
  const deg = ((parseInt(m[2], 10) % 360) + 360) % 360;
  return { deg: deg === 90 || deg === 180 || deg === 270 ? deg : 0, mirrored: m[1] === "M" };
}

/** Rotation angle of a SYMBOL orientation field, ignoring any mirror. */
export function rotDeg(rot: string): number {
  return parseRot(rot).deg;
}

/** Inverse of {@link parseRot}: an orientation → its `.asc` field. */
export function rotStr(deg: number, mirrored = false): string {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  const norm = d === 90 || d === 180 || d === 270 ? d : 0;
  return `${mirrored ? "M" : "R"}${norm}`;
}

/**
 * LTSpice-local pin offsets for a library part / `.subckt` instance, whose pins
 * come from its own `.asy` symbol rather than a fixed table. Falls back to the
 * generic box layout (pins down the left edge, then the right) that
 * `SubcircuitBox` draws when the part has no symbol. Handles are the external
 * pin names, in declared order — matching the node's handles.
 */
export function subcircuitPinOffsets(pinNames: string[], symbolName?: string): PinOffset[] {
  const sym = symbolName ? symbolByName(symbolName) : undefined;
  if (sym && sym.pins.length > 0) {
    return [...sym.pins]
      .sort((a, b) => a.order - b.order)
      .map((p, i) => ({ handle: pinNames[i] ?? `pin${p.order}`, dx: p.x, dy: p.y }));
  }
  const leftCount = Math.ceil(pinNames.length / 2);
  return pinNames.map((name, i) =>
    i < leftCount
      ? { handle: name, dx: 0, dy: 16 + i * 32 }
      : { handle: name, dx: 96, dy: 16 + (i - leftCount) * 32 },
  );
}

/**
 * Pin offsets for a logic gate: inputs down the left edge, output on the right.
 *
 * The gate is the only device whose pin count is a property, so it cannot use a
 * fixed table — the offsets are derived from the number of inputs, mirroring
 * LogicGate.createPorts so schematic and `.asc` agree.
 */
function logicGatePinOffsets(pinNames: string[]): PinOffset[] {
  const ins = pinNames.slice(0, -1);
  const out = pinNames[pinNames.length - 1] ?? "Out";
  const span = 48;
  const offsets = ins.map((name, i) => ({
    handle: name,
    dx: 0,
    dy: CENTER + (ins.length === 1 ? 0 : Math.round(-span / 2 + (span * i) / (ins.length - 1))),
  }));
  offsets.push({ handle: out, dx: CENTER + 32, dy: CENTER });
  return offsets;
}

/** Pin offsets for any node, including library parts (which have no fixed table). */
export function offsetsForNode(
  type: string, deg: number, pinNames?: string[], symbolName?: string, mirrored = false,
): PinOffset[] {
  const base = type === "subcircuit"
    ? subcircuitPinOffsets(pinNames ?? [], symbolName)
    : type === "logicgate"
      ? logicGatePinOffsets(pinNames ?? ["In1", "In2", "Out"])
      : (PIN_OFFSETS[type] ?? PIN_OFFSETS["resistor"]);
  return rotateOffsets(mirrorOffsets(base, mirrored), deg);
}

/** Pin offsets after applying an LTSpice orientation about the symbol origin. */
export function rotatedOffsets(type: string, deg: number, mirrored = false): PinOffset[] {
  return rotateOffsets(mirrorOffsets(PIN_OFFSETS[type] ?? PIN_OFFSETS["resistor"], mirrored), deg);
}

/**
 * Horizontal flip about the symbol's own origin (x = 0), which is what LTSpice's
 * `M` prefix does — verified against stock files: an `npn` at `M0` puts its base
 * at +0 and collector/emitter at -64, the exact negation of the `R0` offsets.
 * Applied *before* the rotation, per LTSpice's order.
 */
function mirrorOffsets(base: PinOffset[], mirrored: boolean): PinOffset[] {
  return mirrored ? base.map((p) => ({ ...p, dx: -p.dx })) : base;
}

function rotateOffsets(base: PinOffset[], deg: number): PinOffset[] {
  return base.map((p) => {
    let dx = p.dx, dy = p.dy;
    if (deg === 90) { dx = -p.dy; dy = p.dx; }
    else if (deg === 180) { dx = -p.dx; dy = -p.dy; }
    else if (deg === 270) { dx = p.dy; dy = -p.dx; }
    return { handle: p.handle, dx, dy };
  });
}

/**
 * Centre of a pin set. `mean` (the average) suits small 2-pin parts; `bbox`
 * (the pin bounding-box centre) suits asymmetric multi-pin parts like the
 * op-amp, whose averaged centre would sit off to one side and shift the whole
 * symbol relative to the imported wires.
 */
export type Centering = "mean" | "bbox";

/** Which centring an editor component type uses (see {@link Centering}). */
export function centeringFor(type: string): Centering {
  // Multi-pin, asymmetric .asy symbols (op-amp, transistors) centre on the pin
  // bounding box to match mapSymbol's native-scale rendering; 2-pin parts have
  // mean == bbox so the default is fine.
  return type === "opamp" || type === "subcircuit" || type.startsWith("bjt_") || type.startsWith("mosfet_")
    ? "bbox"
    : "mean";
}

function centre(offsets: PinOffset[], mode: Centering): { mx: number; my: number } {
  // A pinless symbol would otherwise centre on (Infinity + -Infinity)/2 = NaN
  // (bbox) or 0/0 = NaN (mean), and a single node at a NaN position breaks React
  // Flow's rect maths for the *whole* canvas: nothing can be dragged any more and
  // wires vanish when clicked. Keep it finite; the symbol origin is a fine centre.
  if (offsets.length === 0) return { mx: 0, my: 0 };
  if (mode === "bbox") {
    const xs = offsets.map((p) => p.dx), ys = offsets.map((p) => p.dy);
    return { mx: (Math.min(...xs) + Math.max(...xs)) / 2, my: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }
  const mx = offsets.reduce((s, p) => s + p.dx, 0) / offsets.length;
  const my = offsets.reduce((s, p) => s + p.dy, 0) / offsets.length;
  return { mx, my };
}

/** Symbol origin → node top-left, centering the box on the pins. */
export function symbolToNode(symX: number, symY: number, offsets: PinOffset[], mode: Centering = "mean"): { x: number; y: number } {
  const { mx, my } = centre(offsets, mode);
  return { x: Math.round(symX + mx) - CENTER, y: Math.round(symY + my) - CENTER };
}

/** Node top-left → symbol origin (inverse of {@link symbolToNode}). */
export function nodeToSymbol(nodeX: number, nodeY: number, offsets: PinOffset[], mode: Centering = "mean"): { x: number; y: number } {
  const { mx, my } = centre(offsets, mode);
  return { x: Math.round(nodeX + CENTER - mx), y: Math.round(nodeY + CENTER - my) };
}

/**
 * Default anchors of a component's two captions, in node-local px — the spot a
 * caption sits at when the user has not dragged it. LTSpice stores the dragged
 * position as `WINDOW 0` (reference) and `WINDOW 3` (value), relative to the
 * symbol origin, so the offset is the difference between the two.
 *
 * Both directions live here rather than in the exporter: the file is only worth
 * writing if it can be read back the same way, and while the pair sat apart the
 * exporter wrote the position and nothing ever restored it.
 */
export const CAPTION_DEFAULT = {
  label: { left: 8, top: 30 },
  value: { left: 8, top: 48 },
} as const;

export interface CaptionOffset { x: number; y: number }

/** Node-local caption offset → the `WINDOW` coordinates LTSpice stores. */
export function windowCoord(kind: "label" | "value", off?: CaptionOffset): CaptionOffset {
  const def = CAPTION_DEFAULT[kind];
  return { x: Math.round(def.left - CENTER + (off?.x ?? 0)), y: Math.round(def.top - CENTER + (off?.y ?? 0)) };
}

/** The inverse: `WINDOW` coordinates → the offset from the default spot. */
export function offsetFromWindow(kind: "label" | "value", win: CaptionOffset): CaptionOffset {
  const def = CAPTION_DEFAULT[kind];
  return { x: win.x - (def.left - CENTER), y: win.y - (def.top - CENTER) };
}
