import { create } from "zustand";
import { matchResultVariable } from "@core/circuit/probeUtils.js";

export type SimulationStatus = "idle" | "running" | "done" | "error";

export interface SimulationResult {
  variables: string[];
  data: Record<string, Float64Array>;
  time?: Float64Array;
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
      // Keep the probes the user already had (so their panel assignment and
      // colours survive a re-run), plus any pending ones; only fall back to
      // the first variable when nothing carries over.
      const kept = selectedVariables.filter((v) => result.variables.includes(v));
      const pending = pendingProbes.filter((p) => result.variables.includes(p));
      const merged = [...new Set([...kept, ...pending])];
      const next = merged.length > 0 ? merged : [result.variables[0]];
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
  reset: () => set({ status: "idle", result: null, errorMessage: null, selectedVariables: [], pendingProbes: [], log: "" }),
}));
