import { Simulation, type ResultType } from "eecircuit-engine";
import type { SimulationResult } from "@store/simulationStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { formatSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import {
  parseStepDirectives, stepCombinations, stripStepDirectives, withParam, parseMeasurements, type Measurement,
  parseDcSweep, withDcSource, type DcSweep,
} from "./paramSweep.js";

let sim: Simulation | null = null;

async function getSimulation(): Promise<Simulation> {
  if (!sim) {
    sim = new Simulation();
    await sim.start();
  }
  return sim;
}

/** ngspice stdout/stderr for the last run. */
function engineLog(engine: Simulation): string {
  const tryGet = (fn: () => string | string[]): string => {
    try {
      const v = fn();
      return Array.isArray(v) ? v.join("\n") : v;
    } catch {
      return "";
    }
  };
  const info = tryGet(() => engine.getInfo());
  const errors = tryGet(() => engine.getError());
  const parts: string[] = [];
  if (info.trim()) parts.push("===== ngspice output =====", info.trim());
  if (errors.trim()) parts.push("===== Errors / warnings =====", errors.trim());
  return parts.join("\n\n");
}

/**
 * Yield to the event loop between sweep runs so the browser can paint (progress,
 * "running" state) and process the Stop button — each `runSim` is a blocking
 * WASM call, so without this a many-step sweep freezes the tab until it finishes.
 * Returns false if the user pressed Stop (status left "running"), so the caller
 * can abort the sweep.
 */
async function yieldAndContinue(): Promise<boolean> {
  await new Promise((r) => setTimeout(r));
  return useSimulationStore.getState().status === "running";
}

/** Run a single netlist and return its result plus the raw engine log. */
async function runOnce(netlist: string): Promise<{ result: SimulationResult; log: string }> {
  const engine = await getSimulation();
  engine.setNetList(netlist);
  const result: ResultType = await engine.runSim();
  return { result: convertResult(result), log: engineLog(engine) };
}

export async function runSimulation(netlist: string): Promise<SimulationResult> {
  const setLog = useSimulationStore.getState().setLog;
  const steps = parseStepDirectives(netlist);
  try {
    // A `.dc` with a `list` (or nested) second source can't run in ngspice, so
    // sweep it app-side: one `.dc <primary>` per secondary value, one curve each.
    const dc = parseDcSweep(netlist);
    if (dc) return await runDcSweep(netlist, dc, setLog);

    if (steps.length === 0 || steps.every((s) => s.values.length === 0)) {
      // Strip any (unparseable) `.step` too — ngspice can't execute it.
      const nl = stripStepDirectives(netlist);
      const { result, log } = await runOnce(nl);
      setLog(`===== Netlist =====\n${nl.trim()}\n\n${log}`);
      return result;
    }

    // Parameter sweep: run once per combination of all `.step` params (LTSpice
    // runs the full nested product), injecting every param so none is left as an
    // unresolved `{name}` — that would otherwise stall/abort ngspice.
    const base = stripStepDirectives(netlist);
    const combos = stepCombinations(steps, formatSpiceNumber);
    // `.step V1 …` sweeps a source's value; `.step param NAME …` sweeps a param.
    const isSource = new Map(steps.map((s) => [s.name, !!s.isSource]));
    const runs: { combo: (typeof combos)[number]; result: SimulationResult; log: string }[] = [];
    const measRows: string[] = [];
    const setProgress = useSimulationStore.getState().setProgress;
    setProgress({ done: 0, total: combos.length });
    if (combos.length > 1) await new Promise((r) => setTimeout(r)); // paint before first blocking run
    for (let i = 0; i < combos.length; i++) {
      // Between runs, let the UI paint and honour a Stop; abort with the partial
      // results gathered so far rather than discarding the whole sweep.
      if (i > 0 && !(await yieldAndContinue())) break;
      const combo = combos[i];
      const nl = combo.assignments.reduce(
        (acc, a) => (isSource.get(a.name) ? withDcSource(acc, a.name, a.value) : withParam(acc, a.name, a.value)),
        base,
      );
      const { result, log } = await runOnce(nl);
      runs.push({ combo, result, log });
      setProgress({ done: i + 1, total: combos.length });
      const meas: Measurement[] = parseMeasurements(log);
      if (meas.length) measRows.push(`${combo.tag}:  ${meas.map((m) => `${m.name} = ${m.value}`).join("   ")}`);
    }
    setProgress(null);
    const lastLog = runs[runs.length - 1]?.log ?? "";
    const paramName = steps.map((s) => s.name).join(", ");
    const measBlock = measRows.length ? `===== Measurements (.step ${paramName}) =====\n${measRows.join("\n")}\n\n` : "";
    setLog(`${measBlock}===== Netlist (last step) =====\n${base.trim()}\n\n${lastLog}`);

    // An `.op` run yields a single value per signal (no time/frequency axis). For
    // such a sweep the natural plot is the swept parameter on the x-axis and the
    // signal on the y-axis, so build ONE curve over the first `.step` param, with
    // any further `.step` params producing separate curves (grouped by tag).
    const hasXAxis = (runs[0]?.result.time?.length ?? 0) > 1;
    if (!hasXAxis && runs.length > 0) {
      return buildParamSweep(runs, steps);
    }

    // Time/frequency analyses: keep each combination as its own curve over the
    // shared x-axis, suffixing every signal with the combination tag.
    const merged: SimulationResult = { variables: [], data: {}, time: undefined, step: { param: paramName, values: [] } };
    for (const { combo, result } of runs) {
      merged.step!.values.push(combo.tag);
      if (!merged.time && result.time) {
        merged.time = result.time;
        merged.data["time"] = result.time;
        merged.variables.push("time");
      }
      for (const v of result.variables) {
        if (v === "time" || v === "frequency") continue;
        const key = `${v} @${combo.tag}`;
        merged.data[key] = result.data[v];
        merged.variables.push(key);
      }
    }
    return merged;
  } catch (e) {
    try { if (sim) setLog(engineLog(sim)); } catch { /* ignore */ }
    sim = null;
    throw new Error(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Turn per-point (`.op`) runs over `.step` params into an x/y plot: the first
 * step param becomes the x-axis, and each combination of the remaining params is
 * a separate curve (tagged so the plot groups them).
 */
function buildParamSweep(
  runs: { combo: { assignments: { name: string; value: number }[] }; result: SimulationResult }[],
  steps: { name: string; values: number[] }[],
): SimulationResult {
  const first = steps[0];
  const idxOf = new Map(first.values.map((v, i) => [v, i] as const));
  const traceData = new Map<string, Float64Array>();
  const outerTags: string[] = [];
  for (const { combo, result } of runs) {
    const fv = combo.assignments.find((a) => a.name === first.name)?.value;
    const i = fv != null ? idxOf.get(fv) : undefined;
    if (i == null) continue;
    const outerTag = combo.assignments
      .filter((a) => a.name !== first.name)
      .map((a) => `${a.name}=${formatSpiceNumber(a.value)}`)
      .join(" ");
    if (outerTag && !outerTags.includes(outerTag)) outerTags.push(outerTag);
    for (const v of result.variables) {
      if (v === "time" || v === "frequency") continue;
      const key = outerTag ? `${v} @${outerTag}` : v;
      let arr = traceData.get(key);
      if (!arr) { arr = new Float64Array(first.values.length).fill(NaN); traceData.set(key, arr); }
      arr[i] = result.data[v]?.[0] ?? NaN;
    }
  }
  const time = Float64Array.from(first.values);
  const out: SimulationResult = { variables: ["time"], data: { time }, time, xLabel: first.name };
  for (const [k, arr] of traceData) { out.data[k] = arr; out.variables.push(k); }
  if (outerTags.length > 0) {
    out.step = { param: steps.slice(1).map((s) => s.name).join(", "), values: outerTags };
  }
  return out;
}

/**
 * Nested `.dc` sweep: run `.dc <primary>` once per secondary-source value, with
 * that source pinned to the value. The primary sweep is the shared x-axis; each
 * secondary value becomes one tagged curve (so e.g. Ic vs V1 is drawn per I1).
 */
async function runDcSweep(netlist: string, dc: DcSweep, setLog: (s: string) => void): Promise<SimulationResult> {
  const base = netlist
    .split(/\r?\n/)
    .map((l) => (/^\s*\.dc\b/i.test(l) ? `.dc ${dc.primary}` : l))
    .join("\n");
  const merged: SimulationResult = {
    variables: [], data: {}, time: undefined, xLabel: dc.primaryName,
    step: { param: dc.secondary.name, values: [] },
  };
  let lastLog = "";
  const setProgress = useSimulationStore.getState().setProgress;
  setProgress({ done: 0, total: dc.secondary.values.length });
  if (dc.secondary.values.length > 1) await new Promise((r) => setTimeout(r)); // paint before first blocking run
  for (let i = 0; i < dc.secondary.values.length; i++) {
    if (i > 0 && !(await yieldAndContinue())) break;
    const value = dc.secondary.values[i];
    const nl = withDcSource(base, dc.secondary.name, value);
    const { result, log } = await runOnce(nl);
    setProgress({ done: i + 1, total: dc.secondary.values.length });
    lastLog = log;
    const tag = `${dc.secondary.name}=${formatSpiceNumber(value)}`;
    merged.step!.values.push(tag);
    const xVar = result.variables[0]; // the `.dc` sweep vector (x-axis)
    if (!merged.time && result.time) {
      merged.time = result.time;
      merged.data["time"] = result.time;
      merged.variables.push("time");
    }
    for (const v of result.variables) {
      if (v === xVar || v === "time" || v === "frequency") continue;
      const key = `${v} @${tag}`;
      merged.data[key] = result.data[v];
      merged.variables.push(key);
    }
  }
  setLog(`===== Netlist (last ${dc.secondary.name}) =====\n${base.trim()}\n\n${lastLog}`);
  return merged;
}

function convertResult(result: ResultType): SimulationResult {
  const variables = result.variableNames;
  const data: Record<string, Float64Array> = {};

  if (result.dataType === "real") {
    for (const d of result.data) {
      data[d.name] = new Float64Array(d.values as number[]);
    }
  } else {
    for (const d of result.data) {
      const complexVals = d.values as Array<{ real: number; img: number }>;
      data[d.name] = new Float64Array(complexVals.map((v) => Math.sqrt(v.real ** 2 + v.img ** 2)));
    }
  }

  const time = data["time"] ?? data[variables[0]];

  // Hide subcircuit-internal signals (hierarchical names contain a `.`, e.g.
  // `v(xu1.ng)`, `i(@b.xu1.bout[i])`) — like LTSpice, only top-level nodes and
  // device currents are probeable. This also keeps the auto-probe and the (huge)
  // probe list meaningful when a macromodel has many internal parts.
  const isAxis = (v: string) => v === "time" || v === "frequency";
  const kept = variables.filter((v) => isAxis(v) || !v.includes("."));
  const keptData: Record<string, Float64Array> = {};
  for (const v of kept) if (data[v]) keptData[v] = data[v];
  if (time && !keptData["time"]) keptData["time"] = time;
  return { variables: kept, data: keptData, time };
}
