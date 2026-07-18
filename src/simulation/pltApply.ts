import { parsePlt, tickStep } from "./pltFormat.js";
import { inferUnit } from "./units.js";
import { matchResultVariable } from "@core/circuit/probeUtils.js";
import { usePlotStore, looksLikeExpression, type PlotPanel } from "./plotStore.js";
import { useSimulationStore } from "@store/simulationStore.js";

/**
 * Decode `.plt` bytes to text. LTSpice writes these files as UTF-16LE *without*
 * a BOM, so reading one as UTF-8 (the browser's default for `File.text()`)
 * yields every character interleaved with NULs and the parse fails — every
 * LTSpice-authored `.plt` was rejected as invalid, while the app's own
 * UTF-8 output loaded fine.
 *
 * A BOM decides when present; otherwise a NUL in the first bytes means UTF-16,
 * and its position tells the endianness. Plain text never contains NUL.
 */
export function decodePltBytes(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const head = b.subarray(0, 64);
  if (head.includes(0)) {
    return new TextDecoder(b[0] === 0 ? "utf-16be" : "utf-16le").decode(b);
  }
  return new TextDecoder("utf-8").decode(b);
}

/** Read a picked `.plt` file, honouring LTSpice's UTF-16 encoding. */
export async function decodePltFile(file: File): Promise<string> {
  return decodePltBytes(await file.arrayBuffer());
}

// Defined in plotStore (both the store and this module need it); re-exported
// here because callers have always reached for it through the .plt module.
export { looksLikeExpression };

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
  const colors: Record<string, string> = {};
  const hidden = new Set<string>();

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
      ...(pane.yScale ? { yScale: pane.yScale } : {}),
      ...(pane.yLabel ? { yLabel: pane.yLabel } : {}),
      ...(pane.height !== undefined ? { height: pane.height } : {}),
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
    for (const [trace, color] of Object.entries(pane.colors ?? {})) colors[resolveName(trace)] = color;
    // A hidden function is not drawn, so it has no trace token — it only lives in
    // `Hidden:` and must be added back to the expression list (toggled off).
    for (const h of pane.hidden ?? []) {
      const name = resolveName(h);
      hidden.add(name);
      if (looksLikeExpression(name)) exprs.add(name); else raw.add(name);
      if (!(name in tracePanel)) tracePanel[name] = id;
    }
  });

  usePlotStore.getState().importSettings({
    version: 1,
    panels: newPanels,
    traceToPanel: tracePanel,
    colors,
    expressions: [...exprs],
    hiddenExpressions: [...hidden],
    syncX: !!doc.syncX,
    svgLight: !!doc.light,
  });
  // Make the referenced probes active so the traces are re-plotted on next run.
  useSimulationStore.getState().setSelectedVariables([...raw]);
  return true;
}
