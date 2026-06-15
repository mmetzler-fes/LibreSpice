import { create } from "zustand";

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
}

interface SimulationActions {
  setStatus: (status: SimulationStatus) => void;
  setResult: (result: SimulationResult | null) => void;
  setErrorMessage: (msg: string | null) => void;
  setSelectedVariables: (vars: string[]) => void;
  toggleVariable: (variable: string) => void;
  setHoveredVariable: (variable: string | null) => void;
  reset: () => void;
}

export const useSimulationStore = create<SimulationState & SimulationActions>((set, get) => ({
  status: "idle",
  result: null,
  errorMessage: null,
  selectedVariables: [],
  hoveredVariable: null,

  setStatus: (status) => set({ status }),
  setResult: (result) => {
    set({ result, status: "done", errorMessage: null });
    if (result && result.variables.length > 0) {
      set({ selectedVariables: [result.variables[0]] });
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
  setHoveredVariable: (hoveredVariable) => set({ hoveredVariable }),
  reset: () => set({ status: "idle", result: null, errorMessage: null, selectedVariables: [] }),
}));
