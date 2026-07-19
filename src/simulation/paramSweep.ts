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
  /** `.step V1 …` (a source's value) rather than `.step param NAME …`. */
  isSource?: boolean;
  /** The sweep asked for more points than {@link MAX_STEPS}; `values` is cut short. */
  truncated?: boolean;
}

/**
 * Cap the points of a single sweep. LTSpice has no such limit, so this only
 * exists to stop a typo (`.step param R 1 1MEG 1`) from queueing a million runs.
 * It has to be generous: `.step param Rvar 1p 1MEG 1k` is 1001 legitimate points,
 * and silently cutting it at 512 truncated the x-axis at half the sweep.
 */
const MAX_STEPS = 4096;

/** Cap the runs of a nested sweep (the cartesian product of all `.step` lines). */
const MAX_RUNS = 4096;

/**
 * Parse a `.step` sweep. Supported forms (LTSpice syntax):
 *   `.step [lin] param NAME start stop incr`   linear (default)
 *   `.step dec  param NAME start stop N`        N points per decade (log)
 *   `.step oct  param NAME start stop N`        N points per octave (log)
 *   `.step      param NAME list v1 v2 …`        explicit list
 *   `.step      V1 start stop incr`             sweep a source's value directly
 *   `.step      I1 list v1 v2 …`                (no `param` keyword)
 */
/** Parse a single `.step …` line into its swept values, or null. */
function parseStepLine(raw: string): StepSpec | null {
  const head = raw.trim().match(/^\.step\s+(?:(lin|oct|dec)\s+)?(.*)$/i);
  if (!head) return null;
  const kind = (head[1] || "lin").toLowerCase();
  let body = head[2].trim();
  // `.step [mode] param NAME …` sweeps a parameter; otherwise the first token is
  // a source (`.step V1 …` / `.step I1 list …`) whose value is swept.
  const pm = body.match(/^param\s+(.*)$/i);
  const isSource = !pm;
  if (pm) body = pm[1].trim();
  const nm = body.match(/^(\S+)\s+(.*)$/);
  if (!nm) return null;
  const name = nm[1];
  const rest = nm[2].trim();

  const list = rest.match(/^list\s+(.*)$/i);
  if (list) {
    const values = list[1].split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
    if (!values.length) return null;
    return { name, values: values.slice(0, MAX_STEPS), isSource, truncated: values.length > MAX_STEPS };
  }

  const nums = rest.split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
  if (nums.length < 3) return null;
  const [start, stop, third] = nums;
  const values: number[] = [];
  let wanted: number;

  if (kind === "lin") {
    if (third === 0) return null;
    wanted = Math.floor((stop - start) / third + 1e-9) + 1;
    for (let i = 0; i < wanted && values.length < MAX_STEPS; i++) {
      values.push(Number((start + i * third).toPrecision(12)));
    }
  } else {
    // dec / oct: `third` is points per decade / octave (logarithmic sweep).
    if (start <= 0 || stop <= 0 || third <= 0) return null;
    const decades = kind === "dec" ? Math.log10(stop / start) : Math.log2(stop / start);
    const ratio = kind === "dec" ? Math.pow(10, 1 / third) : Math.pow(2, 1 / third);
    wanted = Math.max(0, Math.round(third * decades)) + 1;
    for (let i = 0; i < wanted && values.length < MAX_STEPS; i++) {
      values.push(Number((start * Math.pow(ratio, i)).toPrecision(12)));
    }
  }
  return values.length ? { name, values, isSource, truncated: wanted > MAX_STEPS } : null;
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
 * capped at {@link MAX_RUNS} total runs so a broad nested sweep can't explode.
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
    combos = next.slice(0, MAX_RUNS);
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

/** A `.dc` analysis with a nested secondary source sweep. */
export interface DcSweep {
  /** Primary sweep tokens as written, e.g. `V1 0V 20V 100mV`. */
  primary: string;
  /** Primary source name (x-axis), e.g. `V1`. */
  primaryName: string;
  /** Secondary source stepped app-side (ngspice can't `list` a 2nd source). */
  secondary: { name: string; values: number[] };
}

/**
 * Parse a nested `.dc` directive whose SECOND source is a `list` (or start/stop/
 * incr). ngspice can't run a `list` second source, so the app sweeps it: one
 * `.dc <primary>` run per secondary value. Returns null if there's no such 2nd
 * source (a plain single-source `.dc` runs directly in ngspice).
 */
export function parseDcSweep(netlist: string): DcSweep | null {
  for (const raw of netlist.split(/\r?\n/)) {
    const m = raw.trim().match(/^\.dc\s+(.+)$/i);
    if (!m) continue;
    const t = m[1].trim().split(/\s+/);
    if (t.length < 4) return null;
    const primary = t.slice(0, 4);
    const rest = t.slice(4);
    if (rest.length < 2) return null; // no secondary source
    const name = rest[0];
    let values: number[] = [];
    if (/^list$/i.test(rest[1])) {
      values = rest.slice(2).map(parseSpiceNumber).filter((v): v is number => v != null);
    } else if (rest.length >= 4) {
      const [s, e, inc] = rest.slice(1, 4).map(parseSpiceNumber);
      if (s != null && e != null && inc) {
        for (let v = s; v <= e + Math.abs(inc) * 1e-9 && values.length < MAX_STEPS; v += inc) {
          values.push(Number(v.toPrecision(12)));
        }
      }
    }
    if (values.length === 0) return null;
    return { primary: primary.join(" "), primaryName: primary[0], secondary: { name, values: values.slice(0, MAX_STEPS) } };
  }
  return null;
}

/** Set a source's value to a fixed DC level, keeping its two node names. */
export function withDcSource(netlist: string, name: string, value: number): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s+(\\S+)\\s+(\\S+)\\b`, "i");
  return netlist
    .split(/\r?\n/)
    .map((l) => { const m = l.match(re); return m ? `${name} ${m[1]} ${m[2]} DC ${value}` : l; })
    .join("\n");
}

/**
 * Is this `.step` name the simulation temperature rather than a source or a
 * parameter? LTSpice treats `temp` as a reserved global, so `.step temp 0 100 10`
 * sweeps the ambient temperature — with or without the `param` keyword.
 *
 * Without this it parses as a *source* named `temp` (no `param` keyword, see
 * parseStepLine), and the substitution then matches no component line at all:
 * every run would use the same default 27 °C and the sweep would draw a stack of
 * identical curves.
 */
export function isTempSweep(name: string): boolean {
  return /^temp$/i.test(name);
}

/**
 * Set the simulation temperature, replacing any existing `.temp` line. ngspice
 * takes it in °C, which is also what LTSpice's `.step temp` means.
 */
export function withTemp(netlist: string, value: number): string {
  const lines = netlist.split(/\r?\n/).filter((l) => !/^\s*\.temp\b/i.test(l));
  const tempLine = `.temp ${value}`;
  const endIdx = lines.findIndex((l) => /^\s*\.end\s*$/i.test(l));
  if (endIdx >= 0) lines.splice(endIdx, 0, tempLine);
  else lines.push(tempLine);
  return lines.join("\n");
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
