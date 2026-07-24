import { create } from "zustand";
import { renameNetInProbe } from "@core/circuit/probeUtils.js";
import { useSimulationStore } from "@store/simulationStore.js";

/**
 * A trace name is an expression unless it is a bare probe like `V(out)` /
 * `I(R1)` / `Ic(Q1)`. Lives here rather than in `pltApply` so both the `.plt`
 * import and the store can use it without an import cycle.
 */
export function looksLikeExpression(name: string): boolean {
  return !/^\s*[@A-Za-z_][\w.]*\s*(\([^()]*\))?\s*$/.test(name);
}

/** How the y-axis maps data values to screen: linear, log10, or decibel (20·log10|v|). */
export type YScale = "linear" | "log" | "db";

/** Per-panel axis configuration. Any `undefined` bound means "auto". */
export interface PlotPanel {
  id: string;
  /** x-axis: left bound, right bound, desired tick count, logarithmic. */
  xMin?: number;
  xMax?: number;
  xTicks?: number;
  logX?: boolean;
  /**
   * Parametric x-axis: plot the panel's traces against this trace instead of the
   * sweep/time base (LTSpice's `Parametric:`), e.g. `I(RL)` for a source
   * characteristic U_KL(I_RL). The x bounds then refer to that quantity.
   */
  xTrace?: string;
  /** y-axis: bottom bound, top bound, desired tick count (left/first axis). */
  yMin?: number;
  yMax?: number;
  yTicks?: number;
  /** y-axis scale mode (default "linear"). Log/dB auto-fit from the data. */
  yScale?: YScale;
  /** Per-unit y-axis overrides, for panels showing several units (V, A, …). */
  yAxes?: Record<string, YAxisOverride>;
  /** Manual y-axis caption (e.g. "U [V]"); empty = auto from the primary unit. */
  yLabel?: string;
  /** Fixed panel height in px (via the drag handle); unset = share space. */
  height?: number;
}

export interface YAxisOverride {
  min?: number;
  max?: number;
  ticks?: number;
}

interface PlotState {
  panels: PlotPanel[];
  /** Trace name → panel id. Unmapped traces fall back to the first panel. */
  traceToPanel: Record<string, string>;
  /** Trace name → colour override. */
  colors: Record<string, string>;
  /** Arithmetic traces (e.g. `V(a)-V(b)`), persisted across simulation runs. */
  expressions: string[];
  /** Expressions currently toggled off (kept in the list, but not drawn). */
  hiddenExpressions: string[];
  /** LTSpice "Sync. Horiz. Axes": all panels share one x-axis range. */
  syncX: boolean;
  /**
   * Where the oscilloscope's measurement cursor sits on the x-axis, or null when
   * none is set.
   *
   * It lives here rather than inside the plot because the *schematic* reads it:
   * a seven-segment display shows the digit at the cursor's instant, so moving
   * the cursor moves the reading. The plot owns the gesture, the store carries
   * the number.
   */
  cursorTime: number | null;
  setCursorTime: (t: number | null) => void;
  /** Render the diagram (and its .svg export) on a white background. */
  svgLight: boolean;
}

/** Serialisable plot configuration, saved to / loaded from `.plt` files. */
export interface PlotSettings {
  version: 1;
  panels: PlotPanel[];
  traceToPanel: Record<string, string>;
  colors: Record<string, string>;
  expressions: string[];
  /** Functions kept in the list but toggled off. */
  hiddenExpressions?: string[];
  syncX: boolean;
  /** Diagram on a white background (print/beamer look). */
  svgLight?: boolean;
}

interface PlotActions {
  addPanel: () => void;
  addPanelRelative: (refId: string, position: "above" | "below") => void;
  movePanel: (id: string, dir: "up" | "down") => void;
  removePanel: (id: string) => void;
  setTracePanel: (trace: string, panelId: string) => void;
  updatePanel: (id: string, patch: Partial<PlotPanel>) => void;
  /**
   * Set a panel's x-axis quantity (LTSpice's "Quantity Plotted" / `Parametric:`).
   * Empty or "time" restores the sweep base. Anything else also has to be probed
   * — the panel needs its series to draw against — but gets no `traceToPanel`
   * entry: it is the x-axis, not a curve.
   */
  setPanelXQuantity: (id: string, quantity: string | undefined) => void;
  fitPanel: (id: string) => void;
  setColor: (trace: string, color: string) => void;
  addExpression: (expr: string) => void;
  /** Rename an existing function expression in place, keeping its panel/colour. */
  updateExpression: (oldExpr: string, newExpr: string) => void;
  /** Toggle whether a function is drawn (kept in the list either way). */
  toggleExpressionHidden: (expr: string) => void;
  removeExpression: (expr: string) => void;
  toggleSyncX: () => void;
  /** Toggle the diagram between the dark (screen) and light (print/beamer) look. */
  toggleSvgLight: () => void;
  importSettings: (settings: PlotSettings) => void;
  /**
   * Back to the defaults: one panel, linear x/y, auto bounds, no colour or
   * function overrides. Called when a new circuit is loaded, so its diagram does
   * not inherit the previous circuit's axes (a dB/log scale or a fixed range
   * fitted to other data leaves the new traces off-screen or invisible). A
   * sibling `.plt` is applied *after* this and overrides it.
   */
  resetSettings: () => void;
  /** Follow a net rename in traces/expressions/colours/panel assignments. */
  renameTraceNet: (oldLabel: string, newLabel: string) => void;
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
  hiddenExpressions: [],
  syncX: false,
  cursorTime: null,
  setCursorTime: (t) => set({ cursorTime: t }),
  svgLight: false,

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

  setPanelXQuantity: (id, quantity) => {
    const x = quantity?.trim();
    const xTrace = !x || x.toLowerCase() === "time" ? undefined : x;
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, xTrace } : p)) }));
    if (!xTrace) return;
    // A formula is a function of the plot; a plain probe has to be requested from
    // the engine. `addProbe` queues it when no result is loaded yet.
    if (looksLikeExpression(xTrace)) get().addExpression(xTrace);
    else useSimulationStore.getState().addProbe(xTrace);
  },

  fitPanel: (id) =>
    set((s) => ({
      panels: s.panels.map((p) =>
        p.id === id
          ? { ...p, xMin: undefined, xMax: undefined, yMin: undefined, yMax: undefined, yAxes: undefined }
          : p,
      ),
    })),

  setColor: (trace, color) => set((s) => ({ colors: { ...s.colors, [trace]: color } })),

  addExpression: (expr) => {
    const trimmed = expr.trim();
    if (!trimmed || get().expressions.includes(trimmed)) return;
    set((s) => ({ expressions: [...s.expressions, trimmed] }));
  },

  updateExpression: (oldExpr, newExpr) =>
    set((s) => {
      const trimmed = newExpr.trim();
      // No-op on blank, unchanged, or a name that would collide with another
      // existing expression.
      if (!trimmed || trimmed === oldExpr) return {};
      if (s.expressions.includes(trimmed)) return {};
      const expressions = s.expressions.map((e) => (e === oldExpr ? trimmed : e));
      // Carry the panel assignment and colour over to the new key.
      const colors = { ...s.colors };
      if (oldExpr in colors) { colors[trimmed] = colors[oldExpr]; delete colors[oldExpr]; }
      const traceToPanel = { ...s.traceToPanel };
      if (oldExpr in traceToPanel) { traceToPanel[trimmed] = traceToPanel[oldExpr]; delete traceToPanel[oldExpr]; }
      // Preserve a hidden state across the rename.
      const hiddenExpressions = s.hiddenExpressions.map((e) => (e === oldExpr ? trimmed : e));
      return { expressions, colors, traceToPanel, hiddenExpressions };
    }),

  toggleExpressionHidden: (expr) =>
    set((s) => ({
      hiddenExpressions: s.hiddenExpressions.includes(expr)
        ? s.hiddenExpressions.filter((e) => e !== expr)
        : [...s.hiddenExpressions, expr],
    })),

  removeExpression: (expr) =>
    set((s) => {
      const traceToPanel = { ...s.traceToPanel };
      delete traceToPanel[expr];
      return {
        expressions: s.expressions.filter((e) => e !== expr),
        hiddenExpressions: s.hiddenExpressions.filter((e) => e !== expr),
        traceToPanel,
      };
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

  toggleSvgLight: () => set((s) => ({ svgLight: !s.svgLight })),

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
      hiddenExpressions: settings.hiddenExpressions ?? [],
      syncX: !!settings.syncX,
      ...(settings.svgLight !== undefined && { svgLight: settings.svgLight }),
    });
  },

  resetSettings: () =>
    set({
      panels: [{ id: "panel-0" }],
      traceToPanel: {},
      colors: {},
      expressions: [],
      hiddenExpressions: [],
      syncX: false,
      // svgLight is a viewing preference (screen vs. beamer), not a property of
      // the circuit, so it deliberately survives a load.
    }),

  renameTraceNet: (oldLabel, newLabel) => {
    if (oldLabel === newLabel) return;
    const rw = (s: string) => renameNetInProbe(s, oldLabel, newLabel);
    set((state) => {
      const colors: Record<string, string> = {};
      for (const [k, v] of Object.entries(state.colors)) colors[rw(k)] = v;
      const traceToPanel: Record<string, string> = {};
      for (const [k, v] of Object.entries(state.traceToPanel)) traceToPanel[rw(k)] = v;
      return { expressions: state.expressions.map(rw), hiddenExpressions: state.hiddenExpressions.map(rw), colors, traceToPanel };
    });
  },
}));

/**
 * Snapshot the current diagram configuration as serialisable {@link PlotSettings}
 * — the same shape written to a `.plt` file, reused to embed the plot config in
 * a share link / autosave. The inverse of {@link PlotActions.importSettings}.
 */
export function currentPlotSettings(): PlotSettings {
  const s = usePlotStore.getState();
  return {
    version: 1,
    panels: s.panels,
    traceToPanel: s.traceToPanel,
    colors: s.colors,
    expressions: s.expressions,
    hiddenExpressions: s.hiddenExpressions,
    syncX: s.syncX,
    svgLight: s.svgLight,
  };
}

/** Shallow pick of the given keys from an object. */
function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
