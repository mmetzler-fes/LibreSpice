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
  /** LTSpice "Sync. Horiz. Axes": all panels share one x-axis range. */
  syncX: boolean;
}

/** Serialisable plot configuration, saved to / loaded from `.plt` files. */
export interface PlotSettings {
  version: 1;
  panels: PlotPanel[];
  traceToPanel: Record<string, string>;
  colors: Record<string, string>;
  expressions: string[];
  syncX: boolean;
}

interface PlotActions {
  addPanel: () => void;
  addPanelRelative: (refId: string, position: "above" | "below") => void;
  movePanel: (id: string, dir: "up" | "down") => void;
  removePanel: (id: string) => void;
  setTracePanel: (trace: string, panelId: string) => void;
  updatePanel: (id: string, patch: Partial<PlotPanel>) => void;
  fitPanel: (id: string) => void;
  setColor: (trace: string, color: string) => void;
  addExpression: (expr: string) => void;
  removeExpression: (expr: string) => void;
  toggleSyncX: () => void;
  importSettings: (settings: PlotSettings) => void;
}

let panelCounter = 1;
const newPanelId = () => `panel-${panelCounter++}`;

/** x-axis fields that {@link PlotState.syncX} keeps identical across panels. */
const X_KEYS: (keyof PlotPanel)[] = ["xMin", "xMax", "xTicks", "logX"];

export const usePlotStore = create<PlotState & PlotActions>((set, get) => ({
  panels: [{ id: "panel-0" }],
  traceToPanel: {},
  colors: {},
  expressions: [],
  syncX: false,

  addPanel: () => set((s) => ({ panels: [...s.panels, { id: newPanelId() }] })),

  addPanelRelative: (refId, position) =>
    set((s) => {
      const idx = s.panels.findIndex((p) => p.id === refId);
      if (idx < 0) return s;
      const at = position === "above" ? idx : idx + 1;
      const panel: PlotPanel = { id: newPanelId() };
      // Inherit the synced x-axis so a new pane lines up with the others.
      if (s.syncX) Object.assign(panel, pick(s.panels[idx], X_KEYS));
      const panels = [...s.panels];
      panels.splice(at, 0, panel);
      return { panels };
    }),

  movePanel: (id, dir) =>
    set((s) => {
      const idx = s.panels.findIndex((p) => p.id === id);
      const target = dir === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || target < 0 || target >= s.panels.length) return s;
      const panels = [...s.panels];
      [panels[idx], panels[target]] = [panels[target], panels[idx]];
      return { panels };
    }),

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
    set((s) => {
      const touchesX = Object.keys(patch).some((k) => (X_KEYS as string[]).includes(k));
      if (s.syncX && touchesX) {
        const xPatch = pick(patch, X_KEYS);
        return {
          panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : { ...p, ...xPatch })),
        };
      }
      return { panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
    }),

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

  toggleSyncX: () =>
    set((s) => {
      const syncX = !s.syncX;
      if (syncX && s.panels.length > 0) {
        const ref = pick(s.panels[0], X_KEYS);
        return { syncX, panels: s.panels.map((p) => ({ ...p, ...ref })) };
      }
      return { syncX };
    }),

  importSettings: (settings) => {
    if (!settings || settings.version !== 1 || !Array.isArray(settings.panels) || settings.panels.length === 0) {
      return;
    }
    // Avoid id collisions with panels created later.
    for (const p of settings.panels) {
      const m = /^panel-(\d+)$/.exec(p.id);
      if (m) panelCounter = Math.max(panelCounter, Number(m[1]) + 1);
    }
    set({
      panels: settings.panels,
      traceToPanel: settings.traceToPanel ?? {},
      colors: settings.colors ?? {},
      expressions: settings.expressions ?? [],
      syncX: !!settings.syncX,
    });
  },
}));

/** Shallow pick of the given keys from an object. */
function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** Default (unoverridden) colour for a trace, by its index in the trace list. */
export function defaultColor(index: number): string {
  return PLOT_PALETTE[index % PLOT_PALETTE.length];
}
