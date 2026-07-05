import { parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";

/**
 * `.step` / `.param` / `.meas` helpers. The bundled ngspice build does not
 * implement `.step`, so a parameter sweep is orchestrated in the app: the
 * `.step` directive is parsed, then the circuit is run once per value with a
 * `.param NAME=value` injected, and the traces are merged.
 */

export interface StepSpec {
  name: string;
  values: number[];
}

/** Cap total runs so a broad sweep can't launch thousands of simulations. */
const MAX_STEPS = 512;

/**
 * Parse a `.step` sweep. Supported forms (LTSpice syntax):
 *   `.step [lin] param NAME start stop incr`   linear (default)
 *   `.step dec  param NAME start stop N`        N points per decade (log)
 *   `.step oct  param NAME start stop N`        N points per octave (log)
 *   `.step      param NAME list v1 v2 …`        explicit list
 */
/** Parse a single `.step param …` line into its swept values, or null. */
function parseStepLine(raw: string): StepSpec | null {
  const m = raw.trim().match(/^\.step\s+(?:(lin|oct|dec)\s+)?param\s+(\S+)\s+(.*)$/i);
  if (!m) return null;
  const kind = (m[1] || "lin").toLowerCase();
  const name = m[2];
  const rest = m[3].trim();

  const list = rest.match(/^list\s+(.*)$/i);
  if (list) {
    const values = list[1].split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
    return values.length ? { name, values: values.slice(0, MAX_STEPS) } : null;
  }

  const nums = rest.split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
  if (nums.length < 3) return null;
  const [start, stop, third] = nums;
  const values: number[] = [];

  if (kind === "lin") {
    if (third === 0) return null;
    const steps = Math.floor((stop - start) / third + 1e-9);
    for (let i = 0; i <= steps && values.length < MAX_STEPS; i++) {
      values.push(Number((start + i * third).toPrecision(12)));
    }
  } else {
    // dec / oct: `third` is points per decade / octave (logarithmic sweep).
    if (start <= 0 || stop <= 0 || third <= 0) return null;
    const decades = kind === "dec" ? Math.log10(stop / start) : Math.log2(stop / start);
    const ratio = kind === "dec" ? Math.pow(10, 1 / third) : Math.pow(2, 1 / third);
    const total = Math.max(0, Math.round(third * decades));
    for (let i = 0; i <= total && values.length < MAX_STEPS; i++) {
      values.push(Number((start * Math.pow(ratio, i)).toPrecision(12)));
    }
  }
  return values.length ? { name, values } : null;
}

/** All `.step param` sweeps in the netlist (LTSpice allows several, nested). */
export function parseStepDirectives(netlist: string): StepSpec[] {
  const specs: StepSpec[] = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const s = parseStepLine(raw);
    if (s) specs.push(s);
  }
  return specs;
}

/** The first `.step` sweep, or null (kept for callers that want a single one). */
export function parseStepDirective(netlist: string): StepSpec | null {
  return parseStepDirectives(netlist)[0] ?? null;
}

/** One assignment in a nested-sweep combination. */
export interface StepCombo {
  /** e.g. `R12=1 RL=10` — used to tag traces and label the run. */
  tag: string;
  assignments: { name: string; value: number }[];
}

/**
 * Cartesian product of several `.step` sweeps (LTSpice runs every combination),
 * capped at {@link MAX_STEPS} total runs so a broad nested sweep can't explode.
 */
export function stepCombinations(specs: StepSpec[], fmt: (v: number) => string): StepCombo[] {
  let combos: { name: string; value: number }[][] = [[]];
  for (const spec of specs) {
    const next: { name: string; value: number }[][] = [];
    for (const combo of combos) {
      for (const value of spec.values) {
        next.push([...combo, { name: spec.name, value }]);
      }
    }
    combos = next.slice(0, MAX_STEPS);
  }
  return combos.map((assignments) => ({
    tag: assignments.map((a) => `${a.name}=${fmt(a.value)}`).join(" "),
    assignments,
  }));
}

/** Remove every `.step` directive line (ngspice can't execute them). */
export function stripStepDirectives(netlist: string): string {
  return netlist.split(/\r?\n/).filter((l) => !/^\s*\.step\b/i.test(l)).join("\n");
}

/** Inject `.param NAME=value`, replacing any existing definition of NAME. */
export function withParam(netlist: string, name: string, value: number): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paramRe = new RegExp(`^\\s*\\.param\\s+${esc}\\s*=`, "i");
  const lines = netlist.split(/\r?\n/).filter((l) => !paramRe.test(l));
  const paramLine = `.param ${name}=${value}`;
  const endIdx = lines.findIndex((l) => /^\s*\.end\s*$/i.test(l));
  if (endIdx >= 0) lines.splice(endIdx, 0, paramLine);
  else lines.push(paramLine);
  return lines.join("\n");
}

export interface Measurement {
  name: string;
  value: string;
}

/** Extract `.meas` results (`name = value from=/at= …`) from the ngspice log. */
export function parseMeasurements(log: string): Measurement[] {
  const out: Measurement[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+)\s*=\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s+(?:from=|at=|to=)/i);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}
