import { Simulation, type ResultType } from "eecircuit-engine";
import type { SimulationResult } from "@store/simulationStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { formatSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import {
  parseStepDirectives, stepCombinations, stripStepDirectives, withParam, parseMeasurements, type Measurement,
  parseDcSweep, withDcSource, isTempSweep, withTemp, type DcSweep, type StepSpec,
} from "./paramSweep.js";
import { splitMeasDirectives, evaluateMeasurements } from "./measure.js";

let sim: Simulation | null = null;

/** A swept source carries its own unit: `I…` is a current source, else voltage. */
function sourceUnit(name: string): string {
  return /^i/i.test(name) ? "A" : "V";
}

/**
 * X-axis label + unit for a plain single-source `.dc` sweep (the swept source's
 * value is the x-axis, e.g. `V` for a voltage source, `A` for a current one).
 * Returns null when there is no `.dc` directive, so time analyses keep the
 * default seconds axis.
 */
function dcSweepAxis(netlist: string): { label: string; unit: string } | null {
  for (const raw of netlist.split("\n")) {
    const m = raw.trim().match(/^\.dc\s+([A-Za-z][\w]*)/i);
    if (m) return { label: m[1], unit: sourceUnit(m[1]) };
  }
  return null;
}

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

/** Hard cap on a single ngspice run. Some errors (e.g. a failed result write on
 * an unsupported directive) leave `runSim()` pending forever; without this the
 * app would sit on "running" indefinitely. */
const RUN_TIMEOUT_MS = 30_000;

/** Run a single netlist and return its result plus the raw engine log. */
async function runOnce(netlist: string): Promise<{ result: SimulationResult; log: string }> {
  const engine = await getSimulation();
  engine.setNetList(netlist);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ngspice did not return within ${RUN_TIMEOUT_MS / 1000}s (a directive may be unsupported)`)),
      RUN_TIMEOUT_MS,
    );
  });
  try {
    const result = (await Promise.race([engine.runSim(), timeout])) as ResultType;
    return { result: convertResult(result), log: engineLog(engine) };
  } finally {
    clearTimeout(timer!);
  }
}

/** Render app-side measurements as a log block, or "" when there are none. */
function measBlock(title: string, rows: string[]): string {
  return rows.length ? `===== Measurements (${title}) =====\n${rows.join("\n")}\n\n` : "";
}

export async function runSimulation(netlistIn: string): Promise<SimulationResult> {
  const setLog = useSimulationStore.getState().setLog;
  // Pull out the `.meas` directives ngspice cannot run (see measure.ts) — left in
  // the netlist they abort the run, and `runSim()` then never settles.
  const { netlist, appSide } = splitMeasDirectives(netlistIn);
  const steps = parseStepDirectives(netlist);
  try {
    // A `.dc` with a `list` (or nested) second source can't run in ngspice, so
    // sweep it app-side: one `.dc <primary>` per secondary value, one curve each.
    // Only a `.step` sweep produces a measurement-per-step curve; every other
    // path clears a previous one rather than leaving it stranded.
    const dc = parseDcSweep(netlist);
    if (dc) { useSimulationStore.getState().setMeasResult(null); return await runDcSweep(netlist, dc, setLog); }

    if (steps.length === 0 || steps.every((s) => s.values.length === 0)) {
      useSimulationStore.getState().setMeasResult(null);
      // Strip any (unparseable) `.step` too — ngspice can't execute it.
      const nl = stripStepDirectives(netlist);
      const { result, log } = await runOnce(nl);
      const rows = evaluateMeasurements(result, appSide).map((m) => `${m.name} = ${m.value}`);
      setLog(`${measBlock("app-side", rows)}===== Netlist =====\n${nl.trim()}\n\n${log}`);
      // A `.dc` sweep's x-vector is the swept source value, not time (ngspice
      // still returns it as the scale/"time" vector). Label/unit it (V or A) so
      // the plot shows e.g. "5V" instead of "5s".
      const dcAxis = dcSweepAxis(nl);
      if (dcAxis) {
        return { ...result, xLabel: dcAxis.label, xUnit: dcAxis.unit };
      }
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
        (acc, a) => isTempSweep(a.name) ? withTemp(acc, a.value)
          : isSource.get(a.name) ? withDcSource(acc, a.name, a.value)
          : withParam(acc, a.name, a.value),
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

    // The `.meas` results as their own plot over the swept parameter. Set even
    // when empty, so a re-run without measurements clears the previous one
    // instead of leaving a stale curve on screen.
    useSimulationStore.getState().setMeasResult(buildMeasurementSweep(runs, steps));

    // An `.op` run yields a single value per signal (no time/frequency axis). For
    // such a sweep the natural plot is the swept parameter on the x-axis and the
    // signal on the y-axis, so build ONE curve over the first `.step` param, with
    // any further `.step` params producing separate curves (grouped by tag).
    const hasXAxis = (runs[0]?.result.time?.length ?? 0) > 1;
    const sweep = !hasXAxis && runs.length > 0 ? buildParamSweep(runs, steps) : null;

    // App-side `.meas`: over a stepped `.op` the measurement domain is the swept
    // parameter itself (LTSpice semantics — `WHEN P=Pmax` yields the RM at which
    // the power peaks). Every other analysis measures per run, over its own axis.
    // A truncated sweep silently shortens the x-axis, which looks like a wrong
    // result rather than a cap — say so.
    const cut = steps.filter((s) => s.truncated);
    const warn = cut.length
      ? `===== Warning =====\n${cut
          .map((s) => `.step ${s.name}: sweep capped at ${s.values.length} points (last value ${s.values[s.values.length - 1]})`)
          .join("\n")}\n\n`
      : "";

    const appRows: string[] = [];
    if (appSide.length > 0) {
      if (sweep) {
        appRows.push(...evaluateMeasurements(sweep, appSide).map((m) => `${m.name} = ${m.value}`));
      } else {
        for (const { combo, result } of runs) {
          const meas = evaluateMeasurements(result, appSide);
          if (meas.length) appRows.push(`${combo.tag}:  ${meas.map((m) => `${m.name} = ${m.value}`).join("   ")}`);
        }
      }
    }
    setLog(
      `${warn}${measBlock(`.step ${paramName}`, [...appRows, ...measRows])}` +
        `===== Netlist (last step) =====\n${base.trim()}\n\n${lastLog}`,
    );

    if (sweep) return sweep;

    // Time/frequency analyses: keep each combination as its own curve over the
    // shared x-axis, suffixing every signal with the combination tag.
    const merged: SimulationResult = { variables: [], data: {}, time: undefined, step: { param: paramName, values: [] } };
    // A `.dc` run has no "time" variable — ngspice returns the swept source's
    // value as the first vector and convertResult adopts it as the scale (and
    // drops it as a signal). The axis still needs the source's own name and unit,
    // which only the netlist knows.
    const dcAxis = dcSweepAxis(base);
    for (const { combo, result } of runs) {
      merged.step!.values.push(combo.tag);
      if (!merged.time && result.time) {
        merged.time = result.time;
        merged.data["time"] = result.time;
        merged.variables.push("time");
        // Carry the x-axis labelling (e.g. frequency/Hz for `.ac`) onto the
        // merged sweep so its plot names the axis just like a single run.
        merged.xLabel = dcAxis?.label ?? result.xLabel;
        merged.xUnit = dcAxis?.unit ?? result.xUnit;
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
 * The `.meas` results of a swept run, as their own plot: one point per step,
 * with the swept parameter on the x-axis.
 *
 * This is LTSpice's `.log.raw` window. It has to be a *separate* result rather
 * than extra traces on the signal plot, because the two have incompatible x
 * axes: a transient sweep of 101 steps carries ~1160 time points per step, while
 * each measurement contributes a single number per step. One `SimulationResult`
 * holds one x vector, so they cannot share it.
 *
 * Returns null when there is nothing to draw — no `.meas` at all, or a sweep so
 * short that a "curve" would be a single point.
 */
export function buildMeasurementSweep(
  runs: { combo: { assignments: { name: string; value: number }[] }; log: string }[],
  steps: StepSpec[],
): SimulationResult | null {
  const first = steps[0];
  if (!first || first.values.length < 2) return null;
  const idxOf = new Map(first.values.map((v, i) => [v, i] as const));

  const series = new Map<string, Float64Array>();
  const outerTags: string[] = [];
  let any = false;
  for (const { combo, log } of runs) {
    const fv = combo.assignments.find((a) => a.name === first.name)?.value;
    const i = fv != null ? idxOf.get(fv) : undefined;
    if (i == null) continue;
    // Further stepped params fan out into separate curves, exactly as they do
    // for the signal plot.
    const outerTag = combo.assignments
      .filter((a) => a.name !== first.name)
      .map((a) => `${a.name}=${formatSpiceNumber(a.value)}`)
      .join(" ");
    if (outerTag && !outerTags.includes(outerTag)) outerTags.push(outerTag);
    for (const m of parseMeasurements(log)) {
      const key = outerTag ? `${m.name} @${outerTag}` : m.name;
      let arr = series.get(key);
      // A measurement that fails for some steps and succeeds for others leaves
      // gaps rather than zeros, so the curve breaks instead of diving to 0.
      if (!arr) { arr = new Float64Array(first.values.length).fill(NaN); series.set(key, arr); }
      const v = Number(m.value);
      if (isFinite(v)) { arr[i] = v; any = true; }
    }
  }
  if (!any) return null;

  const time = Float64Array.from(first.values);
  const out: SimulationResult = {
    variables: ["time"], data: { time }, time,
    // `.step V1 …` sweeps a source and so carries its unit; `.step param g …`
    // sweeps an arbitrary quantity whose unit the netlist cannot tell us.
    xLabel: first.name, xUnit: first.isSource ? sourceUnit(first.name) : undefined,
  };
  for (const [k, arr] of series) { out.data[k] = arr; out.variables.push(k); }
  if (outerTags.length > 0) {
    out.step = { param: steps.slice(1).map((s) => s.name).join(", "), values: outerTags };
  }
  return out;
}

/**
 * Turn per-point (`.op`) runs over `.step` params into an x/y plot: the first
 * step param becomes the x-axis, and each combination of the remaining params is
 * a separate curve (tagged so the plot groups them).
 */
function buildParamSweep(
  runs: { combo: { assignments: { name: string; value: number }[] }; result: SimulationResult }[],
  steps: StepSpec[],
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
  // `.step V1 …` sweeps a source, so the x-axis has that source's unit; a
  // `.step param NAME …` sweeps an arbitrary quantity whose unit is unknowable
  // from the netlist, so it stays unitless (bare numbers on the axis).
  const out: SimulationResult = {
    variables: ["time"], data: { time }, time,
    xLabel: first.name, xUnit: first.isSource ? sourceUnit(first.name) : undefined,
  };
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
    variables: [], data: {}, time: undefined, xLabel: dc.primaryName, xUnit: sourceUnit(dc.primaryName),
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
    if (!merged.time && result.time) {
      merged.time = result.time;
      merged.data["time"] = result.time;
      merged.variables.push("time");
    }
    for (const v of result.variables) {
      if (v === "time" || v === "frequency") continue;
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
  // Keep the phase for a complex run: magnitudes alone cannot express a
  // *difference* of two AC signals (see SimulationResult.complex).
  let complex: Record<string, { re: Float64Array; im: Float64Array }> | undefined;

  if (result.dataType === "real") {
    for (const d of result.data) {
      data[d.name] = new Float64Array(d.values as number[]);
    }
  } else {
    complex = {};
    for (const d of result.data) {
      const complexVals = d.values as Array<{ real: number; img: number }>;
      data[d.name] = new Float64Array(complexVals.map((v) => Math.sqrt(v.real ** 2 + v.img ** 2)));
      complex[d.name] = {
        re: new Float64Array(complexVals.map((v) => v.real)),
        im: new Float64Array(complexVals.map((v) => v.img)),
      };
    }
  }

  const time = data["time"] ?? data[variables[0]];

  // Hide subcircuit-internal signals (hierarchical names contain a `.`, e.g.
  // `v(xu1.ng)`, `i(@b.xu1.bout[i])`) — like LTSpice, only top-level nodes and
  // device currents are probeable. This also keeps the auto-probe and the (huge)
  // probe list meaningful when a macromodel has many internal parts.
  // A `.dc` run has no "time" or "frequency" vector: ngspice returns the swept
  // source's value as the first variable, under its own name (e.g. `v(v1)`), and
  // `time` above adopts it as the scale. It is the x-axis, so it must not also be
  // offered as a signal — plotted, it is just a diagonal line through the chart.
  // Guarded on length, because an `.op` run has no axis at all and its first
  // variable is a genuine (single-point) result.
  const sweepAxis = !variables.includes("time") && !variables.includes("frequency")
    && (time?.length ?? 0) > 1 ? variables[0] : null;
  const kept = variables.filter((v) => !v.includes(".") && v !== sweepAxis);
  const keptData: Record<string, Float64Array> = {};
  for (const v of kept) if (data[v]) keptData[v] = data[v];
  if (time && !keptData["time"]) keptData["time"] = time;
  // An `.ac`/`.noise` run sweeps frequency, not time — ngspice names the scale
  // vector "frequency" and returns it as the x-vector. Label it so the plot
  // shows Hz instead of defaulting the unnamed axis to seconds.
  const freqAxis = variables.includes("frequency");
  const keptComplex = complex
    ? Object.fromEntries(kept.filter((v) => complex![v]).map((v) => [v, complex![v]]))
    : undefined;
  return {
    variables: kept, data: keptData, time,
    ...(keptComplex ? { complex: keptComplex } : {}),
    ...(freqAxis ? { xLabel: "frequency", xUnit: "Hz" } : {}),
  };
}
