import { create } from "zustand";
import { matchResultVariable, renameNetInProbe } from "@core/circuit/probeUtils.js";

export type SimulationStatus = "idle" | "running" | "done" | "error";

export interface SimulationResult {
  variables: string[];
  data: Record<string, Float64Array>;
  time?: Float64Array;
  /**
   * Present for a `.step` sweep. Each swept signal appears in `data` as
   * `"<base> @<tag>"` (one entry per value); `param` is the swept name and
   * `values` are the tags in order, so the UI can group them.
   */
  step?: { param: string; values: string[] };
}

interface SimulationState {
  status: SimulationStatus;
  result: SimulationResult | null;
  errorMessage: string | null;
  selectedVariables: string[];
  hoveredVariable: string | null;
  /** Probes requested before a simulation has been run */
  pendingProbes: string[];
  /** Raw ngspice stdout/stderr from the last run, for the Log panel. */
  log: string;
}

interface SimulationActions {
  setStatus: (status: SimulationStatus) => void;
  setResult: (result: SimulationResult | null) => void;
  setErrorMessage: (msg: string | null) => void;
  setSelectedVariables: (vars: string[]) => void;
  toggleVariable: (variable: string) => void;
  addProbe: (variable: string) => void;
  addProbeCandidates: (candidates: string[]) => void;
  setHoveredVariable: (variable: string | null) => void;
  setLog: (log: string) => void;
  /** Follow a net rename: update selected probes and the current result's keys. */
  renameNetVariable: (oldLabel: string, newLabel: string) => void;
  reset: () => void;
}

export const useSimulationStore = create<SimulationState & SimulationActions>((set, get) => ({
  status: "idle",
  result: null,
  errorMessage: null,
  selectedVariables: [],
  hoveredVariable: null,
  pendingProbes: [],
  log: "",

  setStatus: (status) => set({ status }),
  setResult: (result) => {
    const { pendingProbes, selectedVariables } = get();
    if (result && result.variables.length > 0) {
      // The sweep/time base is never a meaningful trace (it is the x-axis).
      const isAxis = (v: string) => v === "time" || v === "frequency";
      // Keep the probes the user already had (so their panel assignment and
      // colours survive a re-run), plus any pending ones; only fall back to
      // the first real signal when nothing carries over.
      const kept = selectedVariables.filter((v) => result.variables.includes(v) && !isAxis(v));
      const pending = pendingProbes.filter((p) => result.variables.includes(p) && !isAxis(p));
      const merged = [...new Set([...kept, ...pending])];
      const firstReal = result.variables.find((v) => !isAxis(v));
      const next = merged.length > 0 ? merged : (firstReal ? [firstReal] : []);
      set({ result, status: "done", errorMessage: null, selectedVariables: next, pendingProbes: [] });
    } else {
      set({ result, status: "done", errorMessage: null });
    }
  },
  setErrorMessage: (errorMessage) => set({ errorMessage, status: "error" }),
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
      const matched = candidates
        .map((c) => matchResultVariable(result, c))
        .filter((v): v is string => v !== null);
      const toAdd = matched.filter((v) => !selectedVariables.includes(v));
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
  reset: () => set({ status: "idle", result: null, errorMessage: null, selectedVariables: [], pendingProbes: [], log: "" }),
}));
