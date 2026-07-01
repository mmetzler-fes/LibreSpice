import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { Diode, LED, Zener, Schottky, BJT, MOSFET } from "@core/components/semiconductors/Semiconductors.js";
import { VoltageSource, CurrentSource, SineSource, PulseSource } from "@core/components/sources/Sources.js";
import { Ground, OpAmp, CustomSubcircuit } from "@core/components/special/Special.js";
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
    case "inductor":    return new Inductor(id, label, pos);
    case "diode":       return new Diode(id, label, pos);
    case "led":         return new LED(id, label, pos);
    case "zener":       return new Zener(id, label, pos);
    case "schottky":    return new Schottky(id, label, pos);
    case "opamp":       return new OpAmp(id, label, pos);
    case "bjt_npn":     return new BJT(id, label, pos, "NPN");
    case "bjt_pnp":     return new BJT(id, label, pos, "PNP");
    case "mosfet_n":    return new MOSFET(id, label, pos, "NMOS");
    case "mosfet_p":    return new MOSFET(id, label, pos, "PMOS");
    case "vsource":     return new VoltageSource(id, label, pos);
    case "isource":     return new CurrentSource(id, label, pos);
    case "sinesource":  return new SineSource(id, label, pos);
    case "pulsesource": return new PulseSource(id, label, pos);
    case "ground":      return new Ground(id, pos);
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

export function getDefaultLabel(type: ComponentType, counter: number): string {
  const map: Partial<Record<ComponentType, string>> = {
    resistor: "R", capacitor: "C", inductor: "L", diode: "D", led: "D",
    zener: "D", schottky: "D", opamp: "U",
    bjt_npn: "Q", bjt_pnp: "Q", mosfet_n: "M", mosfet_p: "M",
    vsource: "V", isource: "I", sinesource: "V", pulsesource: "V", ground: "GND",
    subcircuit: "X",
  };
  return `${map[type] ?? "X"}${counter}`;
}

function fmtSI(v: number, unit: string): string {
  const a = Math.abs(v);
  if (a === 0) return `0${unit}`;
  if (a >= 1e9)  return `${+(v / 1e9).toPrecision(3)}G${unit}`;
  if (a >= 1e6)  return `${+(v / 1e6).toPrecision(3)}M${unit}`;
  if (a >= 1e3)  return `${+(v / 1e3).toPrecision(3)}k${unit}`;
  if (a >= 1)    return `${+v.toPrecision(3)}${unit}`;
  if (a >= 1e-3) return `${+(v * 1e3).toPrecision(3)}m${unit}`;
  if (a >= 1e-6) return `${+(v * 1e6).toPrecision(3)}µ${unit}`;
  if (a >= 1e-9) return `${+(v * 1e9).toPrecision(3)}n${unit}`;
  return `${+(v * 1e12).toPrecision(3)}p${unit}`;
}

export function getValueLabel(component: SpiceComponent, type: ComponentType): string {
  switch (type) {
    case "resistor":  {
      const r = component as unknown as { resistance: number };
      return fmtSI(r.resistance, "Ω");
    }
    case "capacitor": {
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
      return `${fmtSI(v.dcValue, "V")} DC`;
    }
    case "isource":   {
      const i = component as unknown as { dcValue: number };
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
    default: return "";
  }
}
