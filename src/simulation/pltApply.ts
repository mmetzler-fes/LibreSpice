import { parsePlt, tickStep } from "./pltFormat.js";
import { inferUnit } from "./units.js";
import { matchResultVariable } from "@core/circuit/probeUtils.js";
import { usePlotStore, type PlotPanel } from "./plotStore.js";
import { useSimulationStore } from "@store/simulationStore.js";

/** A trace name is an expression unless it is a bare probe like V(out) / I(R1). */
export function looksLikeExpression(name: string): boolean {
  return !/^\s*[@A-Za-z_][\w.]*\s*(\([^()]*\))?\s*$/.test(name);
}

/** Drop a trailing " @step" tag from a stepped-run trace name. */
export function stripStepTag(name: string): string {
  const i = name.lastIndexOf(" @");
  return i >= 0 ? name.slice(0, i) : name;
}

/**
 * Parse an LTSpice `.plt` document and apply it to the plot + probe stores:
 * rebuilds the panels, activates the referenced probes, and thus is re-used
 * automatically on the next simulation run. Returns false if the text is not a
 * valid `.plt` (callers decide whether to surface that). Shared by the plot
 * panel's "Open Plot Settings" and the toolbar's "Open Folder" auto-load.
 */
export function applyPltText(text: string): boolean {
  const doc = parsePlt(text);
  if (!doc) return false;

  const result = useSimulationStore.getState().result;
  // Resolve raw probe names to the actual result variable when a run exists.
  const resolveName = (n: string) =>
    looksLikeExpression(n) ? n : (result ? matchResultVariable(result, [n]) ?? n : n);

  const newPanels: PlotPanel[] = [];
  const tracePanel: Record<string, string> = {};
  const exprs = new Set<string>();
  const raw = new Set<string>();

  doc.panes.forEach((pane, i) => {
    const id = `panel-${i}`;
    // Map each Y[k] tuple to its unit group (same order as the traces).
    const units = [...new Set(pane.traces.map((t) => inferUnit(stripStepTag(resolveName(t)))))];
    const yAxes: Record<string, { min?: number; max?: number; ticks?: number }> = {};
    units.forEach((u, k) => {
      const ax = pane.y[k];
      if (ax) yAxes[u] = { min: ax.low, max: ax.high, ticks: tickStep(ax) };
    });
    const xTrace = pane.parametric ? resolveName(pane.parametric) : undefined;
    newPanels.push({
      id, xTrace,
      xMin: pane.x.low, xMax: pane.x.high, xTicks: tickStep(pane.x), logX: pane.log[0],
      yMin: pane.y[0]?.low, yMax: pane.y[0]?.high, yTicks: tickStep(pane.y[0]),
      yAxes,
    });
    for (const t of pane.traces) {
      const name = resolveName(t);
      tracePanel[name] = id;
      if (looksLikeExpression(name)) exprs.add(name); else raw.add(name);
    }
    // The parametric x-axis needs its own series, so it has to be probed too —
    // but it is not a y-trace, hence no `tracePanel` entry.
    if (xTrace) {
      if (looksLikeExpression(xTrace)) exprs.add(xTrace); else raw.add(xTrace);
    }
  });

  usePlotStore.getState().importSettings({
    version: 1, panels: newPanels, traceToPanel: tracePanel, colors: {}, expressions: [...exprs], syncX: false,
  });
  // Make the referenced probes active so the traces are re-plotted on next run.
  useSimulationStore.getState().setSelectedVariables([...raw]);
  return true;
}
