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

/** Parse a `.step param NAME start stop incr` or `.step param NAME list …`. */
export function parseStepDirective(netlist: string): StepSpec | null {
  for (const raw of netlist.split(/\r?\n/)) {
    const m = raw.trim().match(/^\.step\s+param\s+(\S+)\s+(.*)$/i);
    if (!m) continue;
    const name = m[1];
    const rest = m[2].trim();

    const list = rest.match(/^list\s+(.*)$/i);
    if (list) {
      const values = list[1].split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
      return values.length ? { name, values } : null;
    }

    const nums = rest.split(/[\s,]+/).map(parseSpiceNumber).filter((v): v is number => v != null);
    if (nums.length >= 3 && nums[2] !== 0) {
      const [start, stop, incr] = nums;
      const values: number[] = [];
      const steps = Math.floor((stop - start) / incr + 1e-9);
      for (let i = 0; i <= steps; i++) values.push(Number((start + i * incr).toPrecision(12)));
      return values.length ? { name, values } : null;
    }
    return null;
  }
  return null;
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
