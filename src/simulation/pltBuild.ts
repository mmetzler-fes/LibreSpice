import { siPrefix, type PltAxis, type PltDoc, type PltPane } from "./pltFormat.js";
import type { PlotPanel } from "./plotStore.js";

/**
 * Build the `.plt` document for the current plot configuration — the inverse of
 * {@link applyPltText}. Kept separate from the plot component so the save/load
 * round-trip is testable without a rendered canvas: the caller supplies the
 * resolved traces and axis ranges (which depend on the simulation result), this
 * assembles the document.
 *
 * The LTSpice-defined part (traces / X / Y[k] / Log / Parametric) is written as
 * before; settings LTSpice has no field for (colours, dB scale, hidden functions,
 * synced x-axes, light background) go into extra keys that LTSpice skips.
 */
export interface PltBuildInput {
  analysis: string;
  panels: PlotPanel[];
  /** Trace name → colour override (whole plot; split per pane here). */
  colors: Record<string, string>;
  syncX: boolean;
  svgLight: boolean;
  /** The y-traces drawn in a panel (its parametric x-trace excluded). */
  tracesOf: (panel: PlotPanel) => string[];
  /** Functions assigned to this panel but toggled off (they have no trace token). */
  hiddenOf: (panel: PlotPanel) => string[];
  /** Resolved y-axis groups, one per unit, in the same order as Y[0], Y[1]… */
  yAxesOf: (panel: PlotPanel, traces: string[]) => { yMin: number; yMax: number; ticks?: number }[];
  /** Resolved x-axis range (sweep/time, or the parametric trace's range). */
  xRangeOf: (panel: PlotPanel) => { low: number; high: number; ticks?: number };
}

/** An axis tuple; `tick` is the grid spacing, defaulting to ~5 divisions. */
function axisFrom(low: number, high: number, step?: number): PltAxis {
  return {
    prefix: siPrefix(Math.max(Math.abs(low), Math.abs(high))),
    low,
    tick: step && step > 0 ? step : (high - low) / 5,
    high,
  };
}

export function buildPltDoc(input: PltBuildInput): PltDoc {
  const { panels, colors, tracesOf, hiddenOf, yAxesOf, xRangeOf } = input;
  return {
    analysis: input.analysis,
    syncX: input.syncX,
    light: input.svgLight,
    panes: panels.map((panel): PltPane => {
      const traces = tracesOf(panel);
      const hidden = hiddenOf(panel);
      const groups = yAxesOf(panel, traces);
      const y = groups.map((g) => axisFrom(g.yMin, g.yMax, g.ticks ?? panel.yTicks));
      if (y.length === 0) y.push(axisFrom(panel.yMin ?? -1, panel.yMax ?? 1, panel.yTicks));
      const xr = xRangeOf(panel);
      // Colours only for the traces this pane actually shows (incl. hidden ones,
      // so toggling a function back on restores its colour too).
      const paneColors: Record<string, string> = {};
      for (const t of [...traces, ...hidden]) if (colors[t]) paneColors[t] = colors[t];

      return {
        traces,
        x: axisFrom(xr.low, xr.high, xr.ticks),
        y,
        log: [!!panel.logX, false, false],
        parametric: panel.xTrace,
        ...(Object.keys(paneColors).length ? { colors: paneColors } : {}),
        ...(panel.yScale && panel.yScale !== "linear" ? { yScale: panel.yScale } : {}),
        ...(hidden.length ? { hidden } : {}),
        ...(panel.yLabel ? { yLabel: panel.yLabel } : {}),
        ...(panel.height !== undefined ? { height: panel.height } : {}),
      };
    }),
  };
}
