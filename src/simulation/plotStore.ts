import { create } from "zustand";

/**
 * Colour palette offered in the legend colour picker. The first entries double
 * as the default trace colours (assigned by order when no override is set).
 */
export const PLOT_PALETTE = [
  "#22d3ee", "#a78bfa", "#34d399", "#fb923c",
  "#f472b6", "#facc15", "#60a5fa", "#f87171",
  "#2dd4bf", "#c084fc", "#4ade80", "#f59e0b",
  "#e879f9", "#38bdf8", "#fca5a5", "#a3e635",
];

/** Per-panel axis configuration. Any `undefined` bound means "auto". */
export interface PlotPanel {
  id: string;
  /** x-axis: left bound, right bound, desired tick count, logarithmic. */
  xMin?: number;
  xMax?: number;
  xTicks?: number;
  logX?: boolean;
  /** y-axis: bottom bound, top bound, desired tick count. */
  yMin?: number;
  yMax?: number;
  yTicks?: number;
}

interface PlotState {
  panels: PlotPanel[];
  /** Trace name → panel id. Unmapped traces fall back to the first panel. */
  traceToPanel: Record<string, string>;
  /** Trace name → colour override. */
  colors: Record<string, string>;
  /** Arithmetic traces (e.g. `V(a)-V(b)`), persisted across simulation runs. */
  expressions: string[];
}

interface PlotActions {
  addPanel: () => void;
  removePanel: (id: string) => void;
  setTracePanel: (trace: string, panelId: string) => void;
  updatePanel: (id: string, patch: Partial<PlotPanel>) => void;
  fitPanel: (id: string) => void;
  setColor: (trace: string, color: string) => void;
  addExpression: (expr: string) => void;
  removeExpression: (expr: string) => void;
}

let panelCounter = 1;
const newPanelId = () => `panel-${panelCounter++}`;

export const usePlotStore = create<PlotState & PlotActions>((set, get) => ({
  panels: [{ id: "panel-0" }],
  traceToPanel: {},
  colors: {},
  expressions: [],

  addPanel: () => set((s) => ({ panels: [...s.panels, { id: newPanelId() }] })),

  removePanel: (id) =>
    set((s) => {
      if (s.panels.length <= 1) return s; // keep at least one panel
      const remaining = s.panels.filter((p) => p.id !== id);
      const fallback = remaining[0].id;
      const traceToPanel = { ...s.traceToPanel };
      for (const [trace, pid] of Object.entries(traceToPanel)) {
        if (pid === id) traceToPanel[trace] = fallback;
      }
      return { panels: remaining, traceToPanel };
    }),

  setTracePanel: (trace, panelId) =>
    set((s) => ({ traceToPanel: { ...s.traceToPanel, [trace]: panelId } })),

  updatePanel: (id, patch) =>
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  fitPanel: (id) =>
    set((s) => ({
      panels: s.panels.map((p) =>
        p.id === id
          ? { ...p, xMin: undefined, xMax: undefined, yMin: undefined, yMax: undefined }
          : p,
      ),
    })),

  setColor: (trace, color) => set((s) => ({ colors: { ...s.colors, [trace]: color } })),

  addExpression: (expr) => {
    const trimmed = expr.trim();
    if (!trimmed || get().expressions.includes(trimmed)) return;
    set((s) => ({ expressions: [...s.expressions, trimmed] }));
  },

  removeExpression: (expr) =>
    set((s) => {
      const traceToPanel = { ...s.traceToPanel };
      delete traceToPanel[expr];
      return { expressions: s.expressions.filter((e) => e !== expr), traceToPanel };
    }),
}));

/** Default (unoverridden) colour for a trace, by its index in the trace list. */
export function defaultColor(index: number): string {
  return PLOT_PALETTE[index % PLOT_PALETTE.length];
}
