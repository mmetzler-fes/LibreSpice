import type { ComponentType } from "@editor/nodes/ComponentNode.js";

/**
 * Shared LTSpice symbol geometry used by both the parser (`.asc` → schematic)
 * and the exporter (schematic → `.asc`), so the two are exact inverses and a
 * save/load round-trips to the same circuit.
 */

/** Node box half-size; the LTSpice symbol origin maps to the node's centre. */
export const CENTER = 40;

export const SYMBOL_TO_TYPE: Record<string, ComponentType> = {
  res: "resistor", cap: "capacitor", polcap: "capacitor_polarized", ind: "inductor",
  europeanpolcap: "capacitor_polarized",
  diode: "diode", LED: "led",
  npn: "bjt_npn", pnp: "bjt_pnp",
  nmos: "mosfet_n", pmos: "mosfet_p",
  voltage: "vsource", current: "isource",
  opamp: "opamp", opamp2: "opamp", universalopamp: "opamp", universalopamp2: "opamp",
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
  const base = symName.split(/[\\/]/).pop() ?? symName;
  return SYMBOL_TO_TYPE_LC[base.toLowerCase()];
}

export const TYPE_TO_SYMBOL: Record<string, string> = {
  resistor: "res", capacitor: "cap", capacitor_polarized: "polcap", inductor: "ind",
  diode: "diode", led: "LED",
  bjt_npn: "npn", bjt_pnp: "pnp",
  mosfet_n: "nmos", mosfet_p: "pmos",
  vsource: "voltage", isource: "current",
  sinesource: "voltage", pulsesource: "voltage",
};

export interface PinOffset { handle: string; dx: number; dy: number }

/**
 * Pin positions in LTSpice symbol-local coordinates (offset from the symbol
 * origin, before rotation). Mirror LTSpice's stock `.asy` terminals — the
 * origin sits at a corner, so the offsets are asymmetric. Handles must match
 * the component's Port ids (see pinGeometry.PORT_HANDLES).
 */
export const PIN_OFFSETS: Record<string, PinOffset[]> = {
  resistor: [{ handle: "p", dx: 16, dy: 16 }, { handle: "n", dx: 16, dy: 96 }],
  capacitor: [{ handle: "p", dx: 16, dy: 0 }, { handle: "n", dx: 16, dy: 64 }],
  capacitor_polarized: [{ handle: "p", dx: 16, dy: 0 }, { handle: "n", dx: 16, dy: 64 }],
  inductor: [{ handle: "p", dx: 16, dy: 16 }, { handle: "n", dx: 16, dy: 96 }],
  diode: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  led: [{ handle: "a", dx: 16, dy: 0 }, { handle: "k", dx: 16, dy: 64 }],
  vsource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  isource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  sinesource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  pulsesource: [{ handle: "p", dx: 0, dy: 16 }, { handle: "n", dx: 0, dy: 96 }],
  bjt_npn: [{ handle: "c", dx: 16, dy: -16 }, { handle: "b", dx: -16, dy: 0 }, { handle: "e", dx: 16, dy: 16 }],
  bjt_pnp: [{ handle: "c", dx: 16, dy: -16 }, { handle: "b", dx: -16, dy: 0 }, { handle: "e", dx: 16, dy: 16 }],
  mosfet_n: [{ handle: "d", dx: 16, dy: -16 }, { handle: "g", dx: -16, dy: 0 }, { handle: "s", dx: 16, dy: 16 }],
  mosfet_p: [{ handle: "d", dx: 16, dy: -16 }, { handle: "g", dx: -16, dy: 0 }, { handle: "s", dx: 16, dy: 16 }],
  // UniversalOpAmp2 terminals (LTSpice symbol-local, origin at the centre):
  //   In+ (-32,16)  In- (-32,-16)  V+ (0,-32)  V- (0,32)  OUT (32,0)
  opamp: [
    { handle: "inp", dx: -32, dy: 16 },
    { handle: "inn", dx: -32, dy: -16 },
    { handle: "vcc", dx: 0, dy: -32 },
    { handle: "vee", dx: 0, dy: 32 },
    { handle: "out", dx: 32, dy: 0 },
  ],
};

/** Ground's node is offset so its single terminal lands on the FLAG point. */
export const GROUND_PIN: PinOffset = { handle: "gnd", dx: CENTER, dy: 20 };

export function rotDeg(rot: string): number {
  if (rot === "R90") return 90;
  if (rot === "R180") return 180;
  if (rot === "R270") return 270;
  return 0;
}

export function rotStr(deg: number): string {
  if (deg === 90) return "R90";
  if (deg === 180) return "R180";
  if (deg === 270) return "R270";
  return "R0";
}

/** Pin offsets after applying an LTSpice rotation about the symbol origin. */
export function rotatedOffsets(type: string, deg: number): PinOffset[] {
  const base = PIN_OFFSETS[type] ?? PIN_OFFSETS["resistor"];
  return base.map((p) => {
    let dx = p.dx, dy = p.dy;
    if (deg === 90) { dx = -p.dy; dy = p.dx; }
    else if (deg === 180) { dx = -p.dx; dy = -p.dy; }
    else if (deg === 270) { dx = p.dy; dy = -p.dx; }
    return { handle: p.handle, dx, dy };
  });
}

function mean(offsets: PinOffset[]): { mx: number; my: number } {
  const mx = offsets.reduce((s, p) => s + p.dx, 0) / offsets.length;
  const my = offsets.reduce((s, p) => s + p.dy, 0) / offsets.length;
  return { mx, my };
}

/** Symbol origin → node top-left, centering the box on the pin bounding box. */
export function symbolToNode(symX: number, symY: number, offsets: PinOffset[]): { x: number; y: number } {
  const { mx, my } = mean(offsets);
  return { x: Math.round(symX + mx) - CENTER, y: Math.round(symY + my) - CENTER };
}

/** Node top-left → symbol origin (inverse of {@link symbolToNode}). */
export function nodeToSymbol(nodeX: number, nodeY: number, offsets: PinOffset[]): { x: number; y: number } {
  const { mx, my } = mean(offsets);
  return { x: Math.round(nodeX + CENTER - mx), y: Math.round(nodeY + CENTER - my) };
}
