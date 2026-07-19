import { create } from "zustand";
import { matchResultVariable, renameNetInProbe } from "@core/circuit/probeUtils.js";

export type SimulationStatus = "idle" | "running" | "done" | "error";

export interface SimulationResult {
  variables: string[];
  data: Record<string, Float64Array>;
  /**
   * Real and imaginary parts of an `.ac`/`.noise` result, alongside the
   * magnitudes in `data`.
   *
   * `data` stays the magnitude, which is what a Bode plot shows and what every
   * existing consumer expects. But a *difference* of two AC signals cannot be
   * computed from magnitudes: |Va| − |Vb| is not |Va − Vb| unless the two are in
   * phase. A differential probe across the resistor of an RC divider read 0.153
   * instead of 0.532 at 1 kHz — a 71% error, and one that looks like a plausible
   * number rather than an obvious failure. Present only for a complex run.
   */
  complex?: Record<string, { re: Float64Array; im: Float64Array }>;
  time?: Float64Array;
  /**
   * Present for a `.step` sweep. Each swept signal appears in `data` as
   * `"<base> @<tag>"` (one entry per value); `param` is the swept name and
   * `values` are the tags in order, so the UI can group them.
   */
  step?: { param: string; values: string[] };
  /**
   * When set, the x-axis is a swept parameter (e.g. an `.op` run stepped over a
   * `.param`), not time — `time` then holds the parameter values. Used to label
   * and format the x-axis appropriately.
   */
  xLabel?: string;
  /**
   * Physical unit of the x-axis (e.g. "V" for a `.dc` voltage sweep). When set,
   * the x-axis ticks are suffixed with it instead of the default time "s".
   */
  xUnit?: string;
}

interface SimulationState {
  status: SimulationStatus;
  result: SimulationResult | null;
  /**
   * The `.meas` results of a swept run, one point per step — LTSpice's
   * `.log.raw` window. Kept apart from {@link result} rather than merged into
   * it: a transient sweep carries ~1000 time points *per step*, a measurement a
   * single number per step, and one result holds one x vector. Null whenever the
   * run had no `.meas`, or no `.step` to plot them against.
   */
  measResult: SimulationResult | null;
  /** Which of the two the scope is showing. */
  scopeView: "signals" | "measurements";
  errorMessage: string | null;
  selectedVariables: string[];
  hoveredVariable: string | null;
  /** Probes requested before a simulation has been run */
  pendingProbes: string[];
  /** Raw ngspice stdout/stderr from the last run, for the Log panel. */
  log: string;
  /** Progress of a multi-run `.step`/`.dc` sweep, else null. */
  progress: { done: number; total: number } | null;
}

interface SimulationActions {
  setStatus: (status: SimulationStatus) => void;
  setResult: (result: SimulationResult | null) => void;
  setMeasResult: (result: SimulationResult | null) => void;
  setScopeView: (view: "signals" | "measurements") => void;
  setErrorMessage: (msg: string | null) => void;
  setSelectedVariables: (vars: string[]) => void;
  toggleVariable: (variable: string) => void;
  addProbe: (variable: string) => void;
  addProbeCandidates: (candidates: string[]) => void;
  setHoveredVariable: (variable: string | null) => void;
  setLog: (log: string) => void;
  setProgress: (progress: { done: number; total: number } | null) => void;
  /** Follow a net rename: update selected probes and the current result's keys. */
  renameNetVariable: (oldLabel: string, newLabel: string) => void;
  /**
   * Restore probes from a loaded snapshot / share link. The circuit's own result
   * is cleared (it belongs to whatever was open before), and the probes go in as
   * *pending* so the next run resolves them against the real result variables.
   */
  loadProbes: (probes: string[]) => void;
  reset: () => void;
}

export const useSimulationStore = create<SimulationState & SimulationActions>((set, get) => ({
  status: "idle",
  result: null,
  measResult: null,
  scopeView: "signals",
  errorMessage: null,
  selectedVariables: [],
  hoveredVariable: null,
  pendingProbes: [],
  log: "",
  progress: null,

  setStatus: (status) => set({ status }),
  setResult: (result) => {
    const { pendingProbes, selectedVariables } = get();
    if (result && result.variables.length > 0) {
      // The sweep/time base is never a meaningful trace (it is the x-axis).
      const isAxis = (v: string) => v === "time" || v === "frequency";
      // Keep the probes the user already had (so their panel assignment and
      // colours survive a re-run), plus any pending ones.
      // Resolve, don't string-compare: a probe restored from a `.plt` is spelled
      // the way LTSpice writes it (`V(U1)`), while ngspice answers `v(u1)`. An
      // exact `includes` dropped exactly those traces on every single run.
      const kept = selectedVariables
        .map((v) => matchResultVariable(result, [v]))
        .filter((v): v is string => v !== null && !isAxis(v));
      // A pending probe was requested before the run, so it is spelled the way
      // the schematic writes it (`I(R1)`) — ngspice answers with `i(r1)` or
      // `@r1[i]`. Resolve it, or the very probe the user asked for is dropped.
      const pending = pendingProbes
        .map((p) => matchResultVariable(result, p))
        .filter((v): v is string => v !== null && !isAxis(v));
      // No auto-pick: the scope shows what the user asked for via "add to scope"
      // and nothing else. A default trace guessed from the netlist was never the
      // signal anyone wanted, and it had to be hunted down and unticked first.
      const next = [...new Set([...kept, ...pending])];
      set({ result, status: "done", errorMessage: null, selectedVariables: next, pendingProbes: [], progress: null });
    } else {
      set({ result, status: "done", errorMessage: null, progress: null });
    }
  },
  setErrorMessage: (errorMessage) => set({ errorMessage, status: "error", progress: null }),
  setSelectedVariables: (selectedVariables) => set({ selectedVariables }),
  toggleVariable: (variable) => {
    const current = get().selectedVariables;
    const next = current.includes(variable)
      ? current.filter((v) => v !== variable)
      : [...current, variable];
    set({ selectedVariables: next });
  },
  addProbe: (variable) => {
    const { result, selectedVariables, pendingProbes } = get();
    if (result) {
      if (!selectedVariables.includes(variable)) {
        set({ selectedVariables: [...selectedVariables, variable] });
      }
    } else if (!pendingProbes.includes(variable)) {
      set({ pendingProbes: [...pendingProbes, variable] });
    }
  },
  addProbeCandidates: (candidates) => {
    const { result, selectedVariables, pendingProbes } = get();
    if (result) {
      // The list holds alternative *spellings* of one quantity (`I(R1)`, `i(R1)`,
      // `@R1[i]`, `@r1[i]`), not four probes: resolving each on its own added the
      // same trace once per spelling. Dedupe against itself, not just against the
      // existing selection.
      const matched = candidates
        .map((c) => matchResultVariable(result, c))
        .filter((v): v is string => v !== null);
      const toAdd = [...new Set(matched)].filter((v) => !selectedVariables.includes(v));
      if (toAdd.length > 0) {
        set({ selectedVariables: [...selectedVariables, ...toAdd] });
      }
    } else {
      const toAdd = candidates.filter((c) => !pendingProbes.includes(c));
      if (toAdd.length > 0) {
        set({ pendingProbes: [...pendingProbes, ...toAdd] });
      }
    }
  },
  setHoveredVariable: (hoveredVariable) => set({ hoveredVariable }),
  setLog: (log) => set({ log }),
  /**
   * Measurement traces are switched on as they arrive. Unlike signal probes,
   * which the user picks deliberately, every `.meas` in the netlist was written
   * *because* someone wanted that number — so the plot shows them all, the way
   * LTSpice opens its log window with the lot.
   */
  setMeasResult: (measResult) => {
    if (!measResult) { set({ measResult: null }); return; }
    // The swept parameter rides along as a trace but stays off: it is the x-axis
    // drawn as a diagonal, and on a shared y-axis it would squash the readings.
    const names = measResult.variables.filter((v) => v !== "time" && v !== measResult.xLabel);
    set((s) => ({
      measResult,
      selectedVariables: [...new Set([...s.selectedVariables, ...names])],
    }));
  },
  setScopeView: (scopeView) => set({ scopeView }),
  setProgress: (progress) => set({ progress }),
  renameNetVariable: (oldLabel, newLabel) => {
    if (oldLabel === newLabel) return;
    const rw = (s: string) => renameNetInProbe(s, oldLabel, newLabel);
    set((state) => {
      const selectedVariables = state.selectedVariables.map(rw);
      const pendingProbes = state.pendingProbes.map(rw);
      let result = state.result;
      if (result) {
        // Rename the node-voltage vector so the plot updates without a re-run.
        const variables = result.variables.map((v) => rw(v));
        const data: Record<string, Float64Array> = {};
        for (const [k, val] of Object.entries(result.data)) data[rw(k)] = val;
        result = { ...result, variables, data };
      }
      return { selectedVariables, pendingProbes, result };
    });
  },
  loadProbes: (probes) =>
    set({ status: "idle", result: null, measResult: null, scopeView: "signals", errorMessage: null, selectedVariables: [], pendingProbes: [...probes], log: "", progress: null }),
  reset: () => set({ status: "idle", result: null, measResult: null, scopeView: "signals", errorMessage: null, selectedVariables: [], pendingProbes: [], log: "", progress: null }),
}));
