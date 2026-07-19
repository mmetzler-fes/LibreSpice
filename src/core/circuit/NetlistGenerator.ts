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

import { insertCurrentSenses } from "./currentSense.js";

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

    // Parsed up front because the device lines depend on it: an `.ac` run cannot
    // report a resistor's or capacitor's current at all, so those devices get a
    // series sense source instead (see currentSense).
    const directiveLines = directives
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("*"));
    const hasAnalysisInDirectives = directiveLines.some((l) => ANALYSIS_RE.test(l));
    const isAc = directiveLines.some((l) => /^\.ac\b/i.test(l))
      || (!hasAnalysisInDirectives && config.type === "ac");

    const componentLines: string[] = [];
    for (const component of circuit.components.values()) {
      const line = component.getNetlistLine();
      if (line) componentLines.push(line);
    }
    lines.push(...(isAc ? insertCurrentSenses(componentLines) : componentLines));
    const instanceLines = componentLines.join("\n"); // component lines only

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
    // Also skip for `.ac`: asking the bundled ngspice for *any* device-current
    // vector during an AC run breaks its result write ("no writable vector
    // found") and then hangs `runSim()` forever — a targeted `.save @r1[i]`
    // hangs exactly the same, so this is not about the option being blunt. Those
    // currents come from series sense sources instead (see currentSense).
    if (!isAc && !/savecurrents/i.test(directives)) {
      lines.push(".options savecurrents");
    }

    if (!hasAnalysisInDirectives) {
      lines.push(this._analysisLine(config));
    }

    // Append custom directive lines, normalising LTSpice syntax for ngspice.
    for (const dl of directiveLines) {
      lines.push(normalizeParamDirective(normalizeMeasDirective(normalizeTranDirective(normalizeDcDirective(dl)))));
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

/**
 * SPICE-style engineering suffixes. `MEG`=1e6, `m`=milli (case matters: SPICE and
 * LTSpice read a lone `M` as *milli*, so 1e6 is always written as `MEG` — never
 * `M` — to stay compatible with LTSpice).
 */
const SPICE_UNITS: { e: number; s: string }[] = [
  { e: 12, s: "T" }, { e: 9, s: "g" }, { e: 6, s: "MEG" }, { e: 3, s: "k" }, { e: 0, s: "" },
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
 * A bare `.dc` (no sweep source/range) is invalid in ngspice — it aborts the
 * whole run with "Bad syntax". Interpret an argument-less `.dc` as the operating
 * point (`.op`), the simplest DC analysis, so it yields a usable bias result
 * instead of crashing. A `.dc` that already has a source + range is left as-is.
 */
export function normalizeDcDirective(line: string): string {
  const m = line.match(/^\s*\.dc\b(.*)$/i);
  if (!m) return line;
  return m[1].trim() === "" ? ".op" : line;
}

/**
 * Normalise an LTSpice `.meas` directive for ngspice: LTSpice writes the window
 * as `FROM 20ms TO 40ms`, ngspice needs `from=20ms to=40ms`. TRIG/TARG clauses
 * are left untouched.
 */
export function normalizeMeasDirective(line: string): string {
  if (!/^\s*\.meas\b/i.test(line)) return line;
  return expandDiffProbes(
    line.replace(/\b(from|to)\s+([^\s]+)/gi, (_m, kw, val) => `${kw.toLowerCase()}=${val}`),
  );
}

/**
 * `.param T 1ms` → `.param T=1ms`. LTSpice accepts a space between a parameter
 * and its value; ngspice needs the `=`.
 *
 * This is not a cosmetic difference. Handed the space form, the bundled ngspice
 * does not report a syntax error — it never returns at all, and since `runSim()`
 * is a blocking WASM call the run timeout cannot fire either (its `setTimeout`
 * never gets a turn). The circuit simply sits on "running" for ever, with
 * nothing in the log to say why. Measured against the engine: `.param T 1ms`
 * alone hangs it, even when nothing uses `T`.
 *
 * Values are taken as single tokens, with braces and parentheses kept whole, so
 * `.param a 1 b {x+y}` and an already-correct `.param c=2` both survive. A
 * trailing name with no value is left as written rather than guessed at.
 */
export function normalizeParamDirective(line: string): string {
  const m = line.match(/^(\s*\.param\s+)(.*)$/i);
  if (!m) return line;

  // Split on whitespace, but never inside {...} or (...).
  const tokens: string[] = [];
  let depth = 0, cur = "";
  for (const ch of m[2]) {
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { tokens.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) tokens.push(cur);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.includes("=")) {
      // `name = value` split across tokens by the spaces around the `=`.
      if (t.endsWith("=") && i + 1 < tokens.length) { out.push(t + tokens[++i]); continue; }
      out.push(t);
      continue;
    }
    if (i + 1 < tokens.length && tokens[i + 1] === "=" && i + 2 < tokens.length) {
      out.push(`${t}=${tokens[i + 2]}`); i += 2; continue;
    }
    if (i + 1 < tokens.length && tokens[i + 1].startsWith("=")) {
      out.push(`${t}${tokens[++i]}`); continue;
    }
    if (i + 1 < tokens.length) { out.push(`${t}=${tokens[++i]}`); continue; }
    out.push(t); // dangling name — leave it be rather than invent a value
  }
  return m[1] + out.join(" ");
}

/**
 * `V(a,b)` → `par('v(a)-v(b)')`, LTSpice's differential probe. ngspice has no
 * such vector and fails the whole measurement ("no such vector as 'v(u2+,u2-)'"),
 * so a `.meas` over a bridge output written the LTSpice way produced no result.
 *
 * The `par('…')` wrapper is required: ngspice rejects a bare `(v(a)-v(b))` in a
 * `.meas` just as it rejects `v(a,b)` — measured against the engine, only the
 * par() form runs. A node named `0` is ground and drops out to a plain zero.
 */
export function expandDiffProbes(line: string): string {
  return line.replace(
    /\bv\s*\(\s*([^\s,()]+)\s*,\s*([^\s,()]+)\s*\)/gi,
    (_m, a: string, b: string) => {
      const term = (n: string) => (n === "0" ? "0" : `v(${n})`);
      return `par('${term(a)}-${term(b)}')`;
    },
  );
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
    
    let stepTime = 1e-6;
    let stopTime = 1e-3;
    let startTime = nums[2];
    let maxStep = nums[3];

    if (nums.length === 1 && nums[0] !== undefined) {
      stopTime = nums[0];
      stepTime = stopTime > 0 ? stopTime / 1000 : 1e-6;
    } else if (nums.length >= 2) {
      stepTime = nums[0] ?? 1e-6;
      stopTime = nums[1] ?? 1e-3;
      if (stepTime <= 0 && stopTime > 0) {
        stepTime = stopTime / 1000;
      }
    }

    return {
      type: "tran",
      stepTime,
      stopTime,
      startTime,
      maxStep,
      uic,
    };
  }
  if (type === "dc") {
    // A bare `.dc` (no source/range) is not a valid sweep — treat it as the
    // operating point, matching normalizeDcDirective's netlist rewrite.
    if (rest.length === 0) return { type: "op" };
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

/**
 * Keep the SPICE-directives text in sync with the analysis chosen in the UI.
 * When the text already carries an analysis line (`.tran`/`.ac`/`.dc`/`.op`) —
 * e.g. imported from an `.asc` — it takes precedence over the config in the
 * generated netlist, so the Analysis-Type dropdown would otherwise be ignored.
 * Replace that first analysis line with the chosen config; if there is none,
 * leave the text untouched (the generator auto-emits the config's line).
 */
export function syncAnalysisDirective(text: string, config: SimulationConfig): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => ANALYSIS_RE.test(l.trim()));
  if (idx < 0) return text;
  lines[idx] = formatAnalysisDirective(config);
  return lines.join("\n");
}
