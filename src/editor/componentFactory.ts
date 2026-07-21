import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { Diode, LED, Zener, Schottky, BJT, MOSFET } from "@core/components/semiconductors/Semiconductors.js";
import { VoltageSource, CurrentSource, SineSource, PulseSource } from "@core/components/sources/Sources.js";
import { Ground, OpAmp, CustomSubcircuit, NetLabel, NetConnector } from "@core/components/special/Special.js";
import { LogicGate, GATE_LABELS } from "@core/components/digital/LogicGate.js";
import { DFlipFlop, KIND_LABELS } from "@core/components/digital/DFlipFlop.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { ComponentType } from "./nodes/ComponentNode.js";

export function createSpiceComponent(
  type: ComponentType,
  id: string,
  label: string,
  x: number,
  y: number,
): SpiceComponent {
  const pos = { x, y };
  switch (type) {
    case "resistor":    return new Resistor(id, label, pos);
    case "capacitor":   return new Capacitor(id, label, pos);
    case "capacitor_polarized": return new Capacitor(id, label, pos);
    case "inductor":    return new Inductor(id, label, pos);
    case "diode":       return new Diode(id, label, pos);
    case "led":         return new LED(id, label, pos);
    case "zener":       return new Zener(id, label, pos);
    case "schottky":    return new Schottky(id, label, pos);
    case "opamp":       return new OpAmp(id, label, pos);
    case "logicgate":   return new LogicGate(id, label, pos);
    case "dff":         return new DFlipFlop(id, label, pos);
    case "bjt_npn":     return new BJT(id, label, pos, "NPN");
    case "bjt_pnp":     return new BJT(id, label, pos, "PNP");
    case "mosfet_n":    return new MOSFET(id, label, pos, "NMOS");
    case "mosfet_p":    return new MOSFET(id, label, pos, "PMOS");
    case "vsource":     return new VoltageSource(id, label, pos);
    case "isource":     return new CurrentSource(id, label, pos);
    case "sinesource":  return new SineSource(id, label, pos);
    case "pulsesource": return new PulseSource(id, label, pos);
    case "ground":      return new Ground(id, pos);
    case "netlabel":    return new NetLabel(id, label, pos);
    case "netconnector": return new NetConnector(id, label, pos);
    case "subcircuit":  return new CustomSubcircuit(id, label, pos);
    default:            return new Resistor(id, label, pos);
  }
}

/**
 * Builds a placed subcircuit instance from an imported `.subckt` definition.
 * The `raw` text becomes the component's spiceModel so the netlist line can
 * reference the subcircuit name and map the declared pins in order.
 */
export function createSubcircuitComponent(
  id: string,
  label: string,
  x: number,
  y: number,
  raw: string,
  pins: string[],
): CustomSubcircuit {
  const portNames = pins.length > 0 ? pins : ["1", "2"];
  return new CustomSubcircuit(id, label, { x, y }, raw, portNames);
}

const LABEL_PREFIX: Partial<Record<ComponentType, string>> = {
  resistor: "R", capacitor: "C", capacitor_polarized: "C", inductor: "L", diode: "D", led: "D",
  zener: "D", schottky: "D", opamp: "U",
  bjt_npn: "Q", bjt_pnp: "Q", mosfet_n: "M", mosfet_p: "M",
  vsource: "V", isource: "I", sinesource: "V", pulsesource: "V", ground: "GND",
  netlabel: "NET", netconnector: "PORT", subcircuit: "X",
};

/**
 * Is this id a net terminal (net label or net connector) rather than a device?
 * Both only name their net and emit no netlist line, so anything looking for a
 * *real* component pin has to skip them. Imported connectors keep the
 * `netlabel_` id they were created with before their IOPIN was seen, so both
 * prefixes count.
 */
export function isNetTerminalId(id: string): boolean {
  return id.startsWith("netlabel_") || id.startsWith("netconnector_");
}

/** Reference-designator prefix for a component type (e.g. resistor → "R"). */
export function labelPrefix(type: ComponentType): string {
  return LABEL_PREFIX[type] ?? "X";
}

export function getDefaultLabel(type: ComponentType, counter: number): string {
  return `${labelPrefix(type)}${counter}`;
}

/**
 * Next free reference designator for a type, numbered independently per prefix
 * (so resistors count R1, R2, … regardless of how many capacitors exist).
 * Derived from the labels already present, which keeps it stable across
 * deletions and undo/redo. Types sharing a prefix (e.g. diode/LED/zener → D)
 * share the same sequence.
 */
export function getNextLabel(type: ComponentType, existingLabels: Iterable<string>): string {
  const prefix = labelPrefix(type);
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const label of existingLabels) {
    const m = re.exec(label);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${max + 1}`;
}

let idCounter = 1;

/**
 * A node id that is guaranteed not to be in use. The placement counter alone was
 * not enough: an import numbers its own components (`netlabel_2`, `ground_1`, …),
 * so a freshly placed part could be handed an id that already existed. The new
 * component then *replaced* the old one in the circuit map while both nodes stayed
 * on the canvas — renaming the new label edited the old one, and its name appeared
 * across the schematic.
 */
export function nextComponentId(type: string, usedIds: Iterable<string>): string {
  const taken = new Set(usedIds);
  let id: string;
  do {
    id = `${type}_${idCounter++}`;
  } while (taken.has(id));
  return id;
}

function fmtSI(v: number, unit: string): string {
  const a = Math.abs(v);
  if (a === 0) return `0${unit}`;
  if (a >= 1e9)  return `${+(v / 1e9).toPrecision(3)}G${unit}`;
  // 1e6 → "MEG", never "M": SPICE/LTSpice read a lone "M" as milli.
  if (a >= 1e6)  return `${+(v / 1e6).toPrecision(3)}MEG${unit}`;
  if (a >= 1e3)  return `${+(v / 1e3).toPrecision(3)}k${unit}`;
  if (a >= 1)    return `${+v.toPrecision(3)}${unit}`;
  if (a >= 1e-3) return `${+(v * 1e3).toPrecision(3)}m${unit}`;
  if (a >= 1e-6) return `${+(v * 1e6).toPrecision(3)}µ${unit}`;
  if (a >= 1e-9) return `${+(v * 1e9).toPrecision(3)}n${unit}`;
  return `${+(v * 1e12).toPrecision(3)}p${unit}`;
}

export function getValueLabel(component: SpiceComponent, type: ComponentType): string {
  // A parametric value (e.g. "{Cvar}") is shown verbatim.
  if (component.valueExpr) return component.valueExpr;
  switch (type) {
    case "resistor":  {
      const r = component as unknown as { resistance: number };
      return fmtSI(r.resistance, "Ω");
    }
    case "capacitor":
    case "capacitor_polarized": {
      const c = component as unknown as { capacitance: number };
      return fmtSI(c.capacitance, "F");
    }
    case "inductor":  {
      const l = component as unknown as { inductance: number };
      return fmtSI(l.inductance, "H");
    }
    case "vsource":   {
      const v = component as unknown as {
        sourceType?: string; dcValue: number; sAmpl: number; sFreq: number; pV2: number; pPer: number;
      };
      if (v.sourceType === "Sine") return `${fmtSI(v.sAmpl, "V")} ${fmtSI(v.sFreq, "Hz")}`;
      if (v.sourceType === "Pulse") return `${fmtSI(v.pV2, "V")} ${fmtSI(v.pPer, "s")}`;
      // A breakpoint list is too long for the caption, so name the waveform.
      if (v.sourceType === "PWL") return "PWL";
      return `${fmtSI(v.dcValue, "V")} DC`;
    }
    case "isource":   {
      const i = component as unknown as { sourceType?: string; dcValue: number; sAmpl: number; sFreq: number };
      if (i.sourceType === "Sine") return `${fmtSI(i.sAmpl, "A")} ${fmtSI(i.sFreq, "Hz")}`;
      if (i.sourceType === "PWL") return "PWL";
      return `${fmtSI(i.dcValue, "A")} DC`;
    }
    case "sinesource": {
      const s = component as unknown as { amplitude: number; frequency: number };
      return `${fmtSI(s.amplitude, "V")} ${fmtSI(s.frequency, "Hz")}`;
    }
    case "pulsesource": {
      const p = component as unknown as { pulsedValue: number; period: number };
      return `${fmtSI(p.pulsedValue, "V")} ${fmtSI(p.period, "s")}`;
    }
    case "logicgate": {
      const g = component as unknown as { gateType: keyof typeof GATE_LABELS; inputs: number };
      return GATE_LABELS[g.gateType] ?? "";
    }
    case "dff": {
      // The caption names the kind and, for the edge-triggered ones, the edge:
      // the symbol's clock wedge is easy to miss, and a flip-flop on the wrong
      // edge fails in a way that looks like a wiring mistake.
      const f = component as unknown as { kind: keyof typeof KIND_LABELS; edge: string };
      if (f.kind === "dlatch") return "Latch";
      const mark = f.kind === "tff" ? "TFF" : "DFF";
      return f.edge === "falling" ? `${mark} \u2193` : `${mark} \u2191`;
    }
    default: return "";
  }
}
