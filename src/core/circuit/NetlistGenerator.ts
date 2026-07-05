import type { Circuit } from "./Circuit.js";

export interface TransientConfig {
  type: "tran";
  stepTime: number;
  stopTime: number;
  /** Time to start saving data (Tstart). */
  startTime?: number;
  /** Maximum internal timestep (Tmax). */
  maxStep?: number;
  /** Start from the DC solution / use initial conditions. */
  uic?: boolean;
}

export interface DCConfig {
  type: "dc";
  sourceName: string;
  start: number;
  stop: number;
  step: number;
}

export interface ACConfig {
  type: "ac";
  variation: "DEC" | "OCT" | "LIN";
  points: number;
  startFreq: number;
  stopFreq: number;
}

export interface OPConfig {
  type: "op";
}

export type SimulationConfig = TransientConfig | DCConfig | ACConfig | OPConfig;

/** Regex to detect analysis commands at the start of a directive line */
const ANALYSIS_RE = /^\.(tran|ac|dc|op)\b/i;

export class NetlistGenerator {
  generate(
    circuit: Circuit,
    config: SimulationConfig,
    directives = "",
    title = "LibreSpice Netlist",
    libraryDefs: string | { name: string; raw: string }[] = "",
  ): string {
    const lines: string[] = [`* ${title}`];

    for (const component of circuit.components.values()) {
      const line = component.getNetlistLine();
      if (line) lines.push(line);
    }
    const instanceLines = lines.slice(1).join("\n"); // component lines only

    // Library definitions as named blocks. A plain string (legacy callers) is
    // treated as a single anonymous block that is always emitted.
    const blocks: { name: string; raw: string }[] =
      typeof libraryDefs === "string"
        ? libraryDefs.trim()
          ? [{ name: "", raw: libraryDefs }]
          : []
        : libraryDefs;

    // Emit only the definitions the circuit actually references (plus their
    // transitive dependencies): a curated library can hold far more parts than
    // any single schematic uses, and dumping all of them bloats the netlist and
    // risks aborting ngspice on an unrelated (possibly incompatible) model.
    const defByName = new Map<string, string>();
    let alwaysOn = "";
    for (const b of blocks) {
      if (b.name) defByName.set(b.name.toLowerCase(), b.raw);
      else alwaysOn += `\n${b.raw}`; // unnamed legacy block: always included
    }
    const usedDefs = new Map<string, string>();
    const queue: string[] = [];
    const scanForRefs = (text: string) => {
      for (const tok of text.split(/[\s(),=]+/)) {
        const key = tok.toLowerCase();
        if (defByName.has(key) && !usedDefs.has(key)) {
          usedDefs.set(key, defByName.get(key)!);
          queue.push(key);
        }
      }
    };
    scanForRefs(instanceLines);
    scanForRefs(directives);
    while (queue.length) scanForRefs(usedDefs.get(queue.shift()!)!);

    const emitBlock = (raw: string) => {
      for (const l of raw.split("\n")) {
        const t = l.trimEnd();
        if (t.trim().length > 0 && !t.trim().startsWith("*")) lines.push(t);
      }
    };
    if (alwaysOn) emitBlock(alwaysOn);
    for (const raw of usedDefs.values()) emitBlock(raw);

    // Fallback device models: emit a generic `.model` for any semiconductor
    // whose model name isn't already provided by the library or a user
    // directive, so a bare diode/BJT/MOSFET simulates instead of aborting
    // ngspice with "could not find a valid modelname".
    const defined = new Set<string>();
    const collectDefs = (text: string) => {
      const re = /^\s*\.(?:model|subckt)\s+(\S+)/gim;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) defined.add(m[1].toLowerCase());
    };
    for (const b of blocks) if (b.name) defined.add(b.name.toLowerCase());
    if (alwaysOn) collectDefs(alwaysOn);
    collectDefs(directives);
    const emittedModels = new Set<string>();
    for (const component of circuit.components.values()) {
      const md = component.getModelDirective();
      const name = md?.match(/^\.model\s+(\S+)/i)?.[1].toLowerCase();
      if (md && name && !defined.has(name) && !emittedModels.has(name)) {
        lines.push(md);
        emittedModels.add(name);
      }
    }

    // Compute branch currents for every device (R, C, L, sources, …) so they can
    // be plotted as @dev[i]. Skip if the user already set the option themselves.
    if (!/savecurrents/i.test(directives)) {
      lines.push(".options savecurrents");
    }

    // Parse directive lines – skip blank lines and full-line comments
    const directiveLines = directives
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("*"));

    // Only emit auto-generated analysis line when directives don't contain one
    const hasAnalysisInDirectives = directiveLines.some((l) => ANALYSIS_RE.test(l));
    if (!hasAnalysisInDirectives) {
      lines.push(this._analysisLine(config));
    }

    // Append custom directive lines, normalising LTSpice syntax for ngspice.
    for (const dl of directiveLines) {
      lines.push(normalizeMeasDirective(normalizeTranDirective(dl)));
    }

    lines.push(".end");

    let netlist = lines.join("\n");

    // Replace internal net IDs with user-defined labels
    for (const [id, net] of circuit.nets) {
      if (net.nodeLabel !== id && id !== "0") {
        // net IDs are alphanumeric (net1, net2, …) – word boundaries are safe
        const re = new RegExp(`\\b${id}\\b`, "g");
        netlist = netlist.replace(re, net.nodeLabel);
      }
    }

    return netlist;
  }

  private _analysisLine(config: SimulationConfig): string {
    return formatAnalysisDirective(config);
  }
}

/** SPICE-style engineering suffixes (case follows SPICE: `meg`=1e6, `m`=milli). */
const SPICE_UNITS: { e: number; s: string }[] = [
  { e: 12, s: "T" }, { e: 9, s: "g" }, { e: 6, s: "meg" }, { e: 3, s: "k" }, { e: 0, s: "" },
  { e: -3, s: "m" }, { e: -6, s: "u" }, { e: -9, s: "n" }, { e: -12, s: "p" }, { e: -15, s: "f" },
];

/**
 * Render a number in engineering notation with a SPICE suffix (e.g. 1e-6 → "1u",
 * 1e6 → "1meg"). The output is valid SPICE, so it is used both for display and
 * in the generated directive line.
 */
export function formatSpiceNumber(v: number): string {
  if (!isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a < 1e-15 || a >= 1e15) return String(v);
  const group = Math.max(-15, Math.min(12, Math.floor(Math.log10(a) / 3) * 3));
  const scaled = Number((v / 10 ** group).toPrecision(6));
  const suffix = SPICE_UNITS.find((u) => u.e === group)?.s ?? "";
  return `${scaled}${suffix}`;
}

/** Render a {@link SimulationConfig} as its SPICE analysis directive line. */
export function formatAnalysisDirective(config: SimulationConfig): string {
  const f = formatSpiceNumber;
  switch (config.type) {
    case "tran": {
      // Tmax requires Tstart to be present first; use a valid Tstart or 0.
      const hasStart = !!config.startTime && config.startTime > 0 && config.startTime < config.stopTime;
      const hasMax = !!config.maxStep && config.maxStep > 0;
      const parts = [".tran", f(config.stepTime), f(config.stopTime)];
      if (hasStart || hasMax) parts.push(f(hasStart ? config.startTime! : 0));
      if (hasMax) parts.push(f(config.maxStep!));
      return parts.join(" ") + (config.uic ? " uic" : "");
    }
    case "dc":
      return `.dc ${config.sourceName} ${f(config.start)} ${f(config.stop)} ${f(config.step)}`;
    case "ac":
      return `.ac ${config.variation} ${f(config.points)} ${f(config.startFreq)} ${f(config.stopFreq)}`;
    case "op":
      return ".op";
  }
}

/**
 * Normalise an LTSpice-style `.tran` directive for ngspice. LTSpice accepts a
 * lone stop time (`.tran 40ms`), but ngspice needs `.tran Tstep Tstop` and
 * rejects a zero/absent Tstep ("TSTOP is invalid"). When the step is missing or
 * zero, insert Tstop/1000 while preserving any Tstart/Tmax and modifiers (uic).
 */
export function normalizeTranDirective(line: string): string {
  const head = line.match(/^(\s*\.tran)\b\s*(.*)$/i);
  if (!head) return line;
  const tokens = head[2].trim().split(/\s+/).filter(Boolean);
  const isNum = (t: string) => /^[-+]?[.\d]/.test(t);
  const nums = tokens.filter(isNum);
  if (nums.length === 0) return line;

  // Single value → it is Tstop (LTSpice shorthand).
  if (nums.length === 1) {
    const tstop = parseSpiceNumber(nums[0]) ?? 0;
    if (tstop <= 0) return line;
    return `.tran ${formatSpiceNumber(tstop / 1000)} ${tokens.join(" ")}`;
  }

  // Two+ values with a zero/invalid Tstep → replace the first numeric token.
  if ((parseSpiceNumber(nums[0]) ?? 0) <= 0) {
    const tstop = parseSpiceNumber(nums[1]) ?? 0;
    if (tstop <= 0) return line;
    const step = formatSpiceNumber(tstop / 1000);
    let replaced = false;
    const out = tokens.map((t) => (!replaced && isNum(t) ? ((replaced = true), step) : t));
    return `.tran ${out.join(" ")}`;
  }
  return line;
}

/**
 * Normalise an LTSpice `.meas` directive for ngspice: LTSpice writes the window
 * as `FROM 20ms TO 40ms`, ngspice needs `from=20ms to=40ms`. TRIG/TARG clauses
 * are left untouched.
 */
export function normalizeMeasDirective(line: string): string {
  if (!/^\s*\.meas\b/i.test(line)) return line;
  return line.replace(/\b(from|to)\s+([^\s]+)/gi, (_m, kw, val) => `${kw.toLowerCase()}=${val}`);
}

/** Parse a SPICE value token with an optional SI suffix (1u, 10m, 1meg, 1k). */
export function parseSpiceNumber(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)([a-zµ]*)$/i);
  if (!m) return undefined;
  let n = parseFloat(m[1]);
  const s = m[2].toLowerCase();
  if (s.startsWith("meg")) n *= 1e6;
  else if (s.startsWith("g")) n *= 1e9;
  else if (s.startsWith("t")) n *= 1e12;
  else if (s.startsWith("k")) n *= 1e3;
  else if (s.startsWith("m")) n *= 1e-3;
  else if (s.startsWith("u") || s.startsWith("µ")) n *= 1e-6;
  else if (s.startsWith("n")) n *= 1e-9;
  else if (s.startsWith("p")) n *= 1e-12;
  else if (s.startsWith("f")) n *= 1e-15;
  return isFinite(n) ? n : undefined;
}

/** Parse an analysis directive line (e.g. `.tran 1u 10m`) into a config. */
export function parseAnalysisDirective(line: string): SimulationConfig | null {
  const m = line.trim().match(/^\.(tran|ac|dc|op)\b(.*)$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const rest = m[2].trim().split(/\s+/).filter(Boolean);
  if (type === "op") return { type: "op" };
  if (type === "tran") {
    const uic = /\buic\b/i.test(m[2]);
    const nums = rest.filter((t) => !/^uic$/i.test(t)).map((t) => parseSpiceNumber(t));
    return {
      type: "tran",
      stepTime: nums[0] ?? 1e-6,
      stopTime: nums[1] ?? 1e-3,
      startTime: nums[2],
      maxStep: nums[3],
      uic,
    };
  }
  if (type === "dc") {
    return {
      type: "dc",
      sourceName: rest[0] ?? "V1",
      start: parseSpiceNumber(rest[1]) ?? 0,
      stop: parseSpiceNumber(rest[2]) ?? 5,
      step: parseSpiceNumber(rest[3]) ?? 0.1,
    };
  }
  // ac
  const variation = (rest[0] ?? "DEC").toUpperCase();
  return {
    type: "ac",
    variation: (["DEC", "OCT", "LIN"].includes(variation) ? variation : "DEC") as ACConfig["variation"],
    points: parseSpiceNumber(rest[1]) ?? 10,
    startFreq: parseSpiceNumber(rest[2]) ?? 1,
    stopFreq: parseSpiceNumber(rest[3]) ?? 1e6,
  };
}
