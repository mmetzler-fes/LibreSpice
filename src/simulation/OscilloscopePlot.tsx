import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useSimulationStore } from "@store/simulationStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { canonicalProbe, dedupeProbes, matchResultVariable } from "@core/circuit/probeUtils.js";
import { usePlotStore, type PlotPanel, type YScale } from "./plotStore.js";
import { usePlotTheme, plotThemeFor } from "./plotTheme.js";
import { ClampedMenu } from "../ClampedMenu.js";
import { evalExpression, resolveSeries, stepView, exprCheckResult, isExpression, parametricXSeries } from "./expression.js";
import { inferUnit } from "./units.js";
import { serializePlt } from "./pltFormat.js";
import { buildPltDoc } from "./pltBuild.js";
import { setPltBuilder } from "./plotStore.js";
import { stripStepTag, applyPltText, decodePltFile } from "./pltApply.js";
import { parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "@editor/pointerDrag.js";

/** Trigger a browser download of a text payload. */
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** ngspice analysis type → LTSpice `.plt` section header. */
const ANALYSIS_LABEL: Record<string, string> = {
  tran: "Transient Analysis",
  ac: "AC Analysis",
  dc: "DC transfer characteristic",
  op: "Operating Point",
};

/** A trace name is a formula unless it is a single variable / `V(..)` / `I(..)`. */
const MARGIN = { top: 16, right: 16, bottom: 36, left: 56 };
const MARGIN_COMPACT = { top: 8, right: 8, bottom: 28, left: 48 };

/** Approximate dimensions of a cursor / stamp readout box (px). */
const READOUT_H = 72;
const READOUT_W = 130;

/** Clamp a readout box top so it stays within the container. */
function clampTop(top: number, containerH: number): number {
  return Math.max(4, Math.min(containerH - READOUT_H - 4, top));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build a native-SVG readout box (title + x/y readout) mirroring the on-screen
 * HTML cursor/stamp box, so it survives the .svg export (the HTML overlays do
 * not). Positioned at (x, y) in the panel's pixel coordinate space.
 */
function svgReadoutBox(
  doc: Document,
  x: number,
  y: number,
  o: { color: string; title: string; xText: string; yText: string; dark: boolean },
): SVGGElement {
  const W = READOUT_W, PAD = 6, LH = 15;
  const H = PAD * 2 + LH * 3;
  const th = plotThemeFor(!o.dark);
  const fg = th.text;
  const g = doc.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${x},${y})`);
  const rect = doc.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", String(W));
  rect.setAttribute("height", String(H));
  rect.setAttribute("rx", "4");
  rect.setAttribute("fill", th.cardBg);
  rect.setAttribute("fill-opacity", "0.92");
  rect.setAttribute("stroke", o.color);
  g.appendChild(rect);
  const text = (tx: number, ty: number, fill: string, anchor: "start" | "end", s: string) => {
    const t = doc.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(tx));
    t.setAttribute("y", String(ty));
    t.setAttribute("fill", fill);
    t.setAttribute("font-size", "10");
    t.setAttribute("font-family", "ui-monospace, monospace");
    t.setAttribute("text-anchor", anchor);
    t.textContent = s;
    g.appendChild(t);
  };
  text(PAD, PAD + 11, o.color, "start", o.title);
  text(PAD, PAD + 11 + LH, "#64748b", "start", "x");
  text(W - PAD, PAD + 11 + LH, fg, "end", o.xText);
  text(PAD, PAD + 11 + LH * 2, "#64748b", "start", "y");
  text(W - PAD, PAD + 11 + LH * 2, fg, "end", o.yText);
  return g;
}

const DND_MIME = "application/x-librespice-trace";

/**
 * Smallest a plot pane may be dragged to, in px.
 *
 * One constant for both the drag clamp and the CSS floor. They used to disagree
 * — the drag stopped at 120 while `min-height` held the pane at 200 — so the
 * last stretch of a downward drag did nothing at all.
 *
 * This is not the pane's *effective* floor: the header, and the axis settings
 * row while it is open, cannot shrink below their content, so a pane with its
 * settings expanded bottoms out higher than its neighbours. That is the row
 * genuinely needing the room, not a limit worth working around.
 */
const MIN_PANE_H = 120;
const MIN_PANE_H_COMPACT = 100;

/** Grab area of the resize edge, in px. Comfortably hittable with a mouse or a pen. */
const RESIZE_HANDLE_H = 14;

const SI_PREFIXES: { e: number; s: string }[] = [
  { e: 12, s: "T" }, { e: 9, s: "G" }, { e: 6, s: "M" }, { e: 3, s: "k" }, { e: 0, s: "" },
  { e: -3, s: "m" }, { e: -6, s: "µ" }, { e: -9, s: "n" }, { e: -12, s: "p" }, { e: -15, s: "f" },
];

/**
 * Engineering-notation number: scales by a power-of-1000 SI prefix so the
 * mantissa stays in [1, 1000) (e.g. 0.01 → "10m", 10 → "10", 10000 → "10k"),
 * with trailing zeros trimmed. No prefix is used when the value is already in a
 * readable range.
 *
 * `step` is the spacing between neighbouring labels, and it decides how many
 * digits are shown. Four significant digits are plenty for an axis that spans a
 * decade and hopeless for one that does not: a buck converter's output ripples
 * by 15 µV around 4.92 V, and every tick of that axis printed as "4.921". Three
 * identical numbers up the side make a 15 µV ripple look like a 5 V swing —
 * which is exactly what it looked like. The same held for the time axis, where
 * a 30 µs window read "99.98ms" five times over.
 */
export function siFormat(v: number, step?: number): string {
  if (!isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a < 1e-15 || a >= 1e15) return v.toExponential(2);
  const group = Math.max(-15, Math.min(12, Math.floor(Math.log10(a) / 3) * 3));
  const scaledV = v / 10 ** group;
  // Enough digits to separate two neighbouring ticks, plus one so the last one
  // is not the rounding. Capped: past ~12 digits a double has nothing left to
  // say, and a label that long does not fit under a tick anyway.
  const digits = step && isFinite(step) && step > 0
    ? Math.max(4, Math.min(12, Math.floor(Math.log10(Math.abs(scaledV)))
        - Math.floor(Math.log10(Math.abs(step / 10 ** group))) + 2))
    : 4;
  const scaled = Number(scaledV.toPrecision(digits));
  const prefix = SI_PREFIXES.find((p) => p.e === group)?.s ?? "";
  return `${scaled}${prefix}`;
}

function fmtTime(t: number, step?: number): string {
  const s = siFormat(t, step);
  return s === "0" || s === "—" ? s : `${s}s`;
}

/** Pretty-print ngspice vector names: `@r1[i]`/`i(r1)` → `I(R1)`, `v(out)` → `V(out)`. */
function displayVar(name: string): string {
  const c = canonicalProbe(name);
  if (c) return c.display;
  const m = name.match(/^@(.+)\[(\w)\]$/i); // other @dev[x] vectors (e.g. [p])
  if (!m) return name;
  const fn = m[2].toUpperCase();
  return `${fn}(${m[1].toUpperCase()})`;
}

/** Default y-axis caption from a physical unit, e.g. "V" → "U [V]", "A" → "I [A]". */
function defaultAxisLabel(unit: string): string {
  if (!unit) return "";
  const quantity: Record<string, string> = { V: "U", A: "I", W: "P", "Ω": "R", "℧": "G" };
  return `${quantity[unit] ? `${quantity[unit]} ` : ""}[${unit}]`;
}

function fmtVal(v: number, unit = "", step?: number): string {
  const s = siFormat(v, step);
  return s === "—" ? s : `${s}${unit}`;
}

/** The spacing of an evenly spaced tick list, for {@link siFormat}'s digits. */
function tickStep(ticks: number[]): number | undefined {
  return ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : undefined;
}

function niceTicks(min: number, max: number, count = 6): number[] {
  const range = max - min;
  if (range === 0 || !isFinite(range)) return [min];
  const rough = range / count;
  const exp = Math.floor(Math.log10(rough));
  const mantissa = rough / 10 ** exp;
  const nice = mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10;
  const step = nice * 10 ** exp;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) ticks.push(v);
  return ticks;
}

/**
 * Ticks for a linear axis. When `step` (the grid spacing) is given it is used
 * verbatim (aligned to a multiple of the step); otherwise a "nice" spacing is
 * chosen automatically to give roughly `autoCount` ticks.
 */
export function ticksFor(min: number, max: number, step: number | undefined, autoCount: number): number[] {
  if (step && isFinite(step) && step > 0 && max > min) {
    // A step far smaller than the window is a typo, not a wish: 100n across a
    // 30 µs window asks for 300 labels, which draw as an unreadable smear of
    // overlapping text where an axis used to be. Past what can be read, the
    // automatic ticks are the more useful answer — the entered number stays in
    // the field, so it can be corrected rather than guessed at.
    if ((max - min) / step > MAX_TICKS) return niceTicks(min, max, autoCount);
    const ticks: number[] = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-6; v += step) {
      ticks.push(v);
      if (ticks.length > MAX_TICKS) break;
    }
    return ticks;
  }
  return niceTicks(min, max, autoCount);
}

/** Most ticks an axis will draw before falling back to automatic spacing. */
const MAX_TICKS = 40;

/** Decade ticks (1·10ⁿ, 2·10ⁿ, 5·10ⁿ) inside a positive range, for log axes. */
function logTicks(min: number, max: number): number[] {
  if (min <= 0 || max <= 0) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) ticks.push(v);
    }
  }
  return ticks;
}

/** Every integer decade multiple (1·10ⁿ…9·10ⁿ) in range — minor grid for log axes. */
function logMinorTicks(min: number, max: number): number[] {
  if (min <= 0 || max <= 0) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) {
    for (let m = 1; m < 10; m++) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) ticks.push(v);
    }
  }
  return ticks;
}

/** Sub-divide each major interval into `divisions` — minor grid for linear axes. */
function minorTicksLinear(majors: number[], divisions: number): number[] {
  if (majors.length < 2 || divisions < 2) return [];
  const step = (majors[1] - majors[0]) / divisions;
  const out: number[] = [];
  for (let i = 0; i < majors.length - 1; i++) {
    for (let d = 1; d < divisions; d++) out.push(majors[i] + d * step);
  }
  return out;
}

/**
 * Forward/inverse maps for a y-axis scale mode. `fwd` takes a data value into
 * the space the axis is linear in (identity / log10 / dB); `inv` returns from
 * that space back to a data value (used to label ticks). Log and dB are only
 * defined for positive magnitudes — non-positive values map to NaN so the line
 * simply breaks there.
 */
function yScaleMaps(mode: YScale): { fwd: (v: number) => number; inv: (u: number) => number } {
  switch (mode) {
    case "log":
      return { fwd: (v) => (v > 0 ? Math.log10(v) : NaN), inv: (u) => 10 ** u };
    case "db":
      return { fwd: (v) => (Math.abs(v) > 0 ? 20 * Math.log10(Math.abs(v)) : NaN), inv: (u) => 10 ** (u / 20) };
    default:
      return { fwd: (v) => v, inv: (u) => u };
  }
}

interface ViewRange { xMin: number; xMax: number; yMin: number; yMax: number }

/**
 * Do these two bounds still describe a range worth drawing in?
 *
 * The axis fields sit next to each other and take any number, so a right bound
 * below the left one is a slip of a moment — and it used to blank the panel:
 * `(v - min)/(max - min)` puts every sample outside the pane (or at infinity),
 * so nothing is drawn and nothing says why. A pair that fails here is ignored in
 * favour of the fitted range; the typed number stays in the field.
 */
export function usableRange(lo: number, hi: number): boolean {
  return isFinite(lo) && isFinite(hi) && hi > lo;
}

/** A set of traces sharing one unit, with its own fitted y-range. */
interface UnitGroup { unit: string; traces: string[]; yMin: number; yMax: number }

/** Strip a `.step` tag suffix (" @Cvar=1m") to recover the base trace name. */
/** Group a panel's traces by physical unit (V, A, Ω, …) for separate y-axes. */
function groupByUnit(traces: string[], seriesMap: Record<string, Float64Array | null>): UnitGroup[] {
  const byUnit = new Map<string, string[]>();
  for (const t of traces) {
    const u = inferUnit(stripStepTag(t));
    const arr = byUnit.get(u) ?? [];
    arr.push(t);
    byUnit.set(u, arr);
  }
  return [...byUnit.entries()].map(([unit, ts]) => {
    let mn = Infinity, mx = -Infinity;
    for (const t of ts) {
      const d = seriesMap[t];
      if (!d) continue;
      for (const v of d) { if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.12;
    return { unit, traces: ts, yMin: mn - pad, yMax: mx + pad };
  });
}

/** A unit group with the panel's manual overrides applied. */
interface AxisGroup extends UnitGroup { ticks?: number }

/** Apply per-unit y-overrides (left/first axis also honours legacy yMin/yMax). */
export function applyYOverrides(groups: UnitGroup[], panel: PlotPanel): AxisGroup[] {
  return groups.map((g, gi) => {
    const o = panel.yAxes?.[g.unit] ?? (gi === 0 ? { min: panel.yMin, max: panel.yMax, ticks: panel.yTicks } : {});
    const lo = o.min ?? g.yMin, hi = o.max ?? g.yMax;
    // A pair that no longer describes a range (top at or below bottom) is not
    // applied: every sample would map outside the pane and the panel would go
    // blank, with the fields still reading as if all were well. The typed
    // numbers stay; only the drawing falls back to the fitted range.
    const usable = usableRange(lo, hi);
    return { ...g, yMin: usable ? lo : g.yMin, yMax: usable ? hi : g.yMax, ticks: o.ticks };
  });
}

interface OscilloscopePlotProps {
  compact?: boolean;
}

export function OscilloscopePlot({ compact = false }: OscilloscopePlotProps) {
  const { result: signalResult, measResult, scopeView, setScopeView,
    selectedVariables, toggleVariable, setSelectedVariables } = useSimulationStore();
  // The scope draws one of two results. They cannot be merged: a transient sweep
  // carries ~1000 time points per step while a measurement contributes a single
  // number per step, and a result holds one x vector (see measResult).
  const hasMeas = !!measResult;
  const result = scopeView === "measurements" && measResult ? measResult : signalResult;
  const { autoProbeCurrent, toggleAutoProbeCurrent } = useUIStore();
  const analysisType = useCircuitStore((s) => s.simulationConfig.type);
  const circuitName = useCircuitStore((s) => s.circuitName);
  // Handle of the currently open .asc, used to start file dialogs in its folder.
  const fileHandle = useCircuitStore((s) => s.fileHandle);
  const circuit = useCircuitStore((s) => s.circuit);
  const spiceDirectives = useCircuitStore((s) => s.spiceDirectives);
  const propertyVersion = useCircuitStore((s) => s.propertyVersion);
  const {
    panels, traceToPanel, colors, expressions, hiddenExpressions, syncX, svgLight,
    addPanelRelative, movePanel, removePanel, setTracePanel, updatePanel, fitPanel, setColor,
    addExpression, updateExpression, toggleExpressionHidden, removeExpression, toggleSyncX,
    setPanelXQuantity,
  } = usePlotStore();
  const pt = plotThemeFor(svgLight);
  // Active palette: bright for dark backgrounds, deep for light backgrounds.
  const palette = pt.traces;

  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [exprInput, setExprInput] = useState("");
  const [exprError, setExprError] = useState<string | null>(null);

  const stepTags = result?.step?.values ?? null;

  // Scalar parameters usable in `{name}` expression tokens: each component's
  // primary value (e.g. R1 → resistance) plus any `.param NAME=value`, so a
  // formula like `I(R1)*{R1}` (power in R1) can reference the component value.
  const paramMap = useMemo(() => {
    void propertyVersion; // recompute when a component property is edited
    const map: Record<string, number> = {};
    for (const comp of circuit.components.values()) {
      for (const p of comp.getProperties()) {
        if (p.key === "label") continue;
        const n = typeof p.value === "number" ? p.value : parseSpiceNumber(String(p.value));
        if (n !== undefined && isFinite(n)) { map[comp.label] = n; break; }
      }
    }
    // `.param NAME=value …` — user-defined params override component values.
    for (const line of spiceDirectives.split("\n")) {
      const m = line.match(/^\s*\.param\s+(.+)$/i);
      if (!m) continue;
      for (const pair of m[1].split(/\s+/)) {
        const eq = pair.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
        const n = eq ? parseSpiceNumber(eq[2]) : undefined;
        if (eq && n !== undefined) map[eq[1]] = n;
      }
    }
    return map;
  }, [circuit, spiceDirectives, propertyVersion]);

  // Every trace we can draw: selected raw probes + arithmetic expressions. For a
  // .step sweep, expressions expand to one trace per parameter value so a
  // function like V(a)-V(b) is drawn for every step.
  const allTraces = useMemo(() => {
    // Hidden functions stay in the list but aren't drawn.
    const shown = expressions.filter((e) => !hiddenExpressions.includes(e));
    const exprTraces = stepTags ? shown.flatMap((e) => stepTags.map((t) => `${e} @${t}`)) : shown;
    const known = new Set(result?.variables ?? []);
    // Both views share one selection list, so filter it to what the shown result
    // can actually resolve — otherwise switching to signals drags the
    // measurement names along as empty traces, and back again.
    const sel = known.size > 0
      ? selectedVariables.filter((v) => known.has(v) || (result != null && matchResultVariable(result, [v]) !== null))
      : selectedVariables;
    return [...new Set([...sel, ...exprTraces])];
  }, [selectedVariables, expressions, hiddenExpressions, stepTags, result]);

  // A stepped run tags every vector (`v(out) @1`), so both the plot and the
  // validation have to look at one step's view under the plain names.
  /** x-series for a trace on a parametric panel (see parametricXSeries). */
  const xSeriesFor = useCallback(
    (xTrace: string | undefined, yTrace?: string) =>
      result ? parametricXSeries(result, xTrace, yTrace, stepTags, paramMap) : null,
    [result, stepTags, paramMap],
  );

  const checkResult = result ? exprCheckResult(result, stepTags) : null;

  // Resolve each trace to a data series (raw variable or evaluated expression).
  const seriesMap = useMemo(() => {
    const map: Record<string, Float64Array | null> = {};
    const errors: Record<string, string> = {};
    if (result) {
      for (const trace of allTraces) {
        if (result.data[trace]) { map[trace] = result.data[trace]; continue; }
        const at = trace.lastIndexOf(" @");
        const tag = at >= 0 && stepTags?.includes(trace.slice(at + 2)) ? trace.slice(at + 2) : null;
        const base = tag ? trace.slice(0, at) : trace;
        // A formula is evaluated; a probe name is looked up. Falling back on
        // `isExpression` rather than trusting the registration list alone: a
        // formula that reaches the plot without being registered (restored
        // settings, a renamed net, an import) used to resolve to null and drew
        // as nothing — indistinguishable from a signal that is genuinely zero.
        if (expressions.includes(base) || isExpression(result, base)) {
          const r = evalExpression(tag ? stepView(result, tag) : result, base, paramMap);
          map[trace] = r.values ?? null;
          if (r.error) errors[base] = r.error;
        } else {
          map[trace] = resolveSeries(result, trace);
        }
      }
    }
    return { map, errors };
  }, [result, allTraces, expressions, stepTags, paramMap]);

  // For a .step sweep, group each signal's per-step traces under one collapsible
  // topic so the probe list stays readable.
  const probeGroups = useMemo(() => {
    if (!result || !stepTags) return null;
    const groups = new Map<string, { display: string; members: { raw: string; tag: string }[] }>();
    for (const v of result.variables) {
      if (v === "time" || v === "frequency") continue;
      const at = v.lastIndexOf(" @");
      if (at < 0 || !stepTags.includes(v.slice(at + 2))) continue;
      const baseRaw = v.slice(0, at);
      const display = canonicalProbe(baseRaw)?.display ?? baseRaw;
      if (!groups.has(baseRaw)) groups.set(baseRaw, { display, members: [] });
      groups.get(baseRaw)!.members.push({ raw: v, tag: v.slice(at + 2) });
    }
    return [...groups.values()];
  }, [result, stepTags]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroupOpen = (key: string) =>
    setExpandedGroups((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleGroupAll = (members: { raw: string }[]) => {
    const raws = members.map((m) => m.raw);
    const allSel = raws.every((r) => selectedVariables.includes(r));
    setSelectedVariables(allSel
      ? selectedVariables.filter((v) => !raws.includes(v))
      : [...new Set([...selectedVariables, ...raws])]);
  };

  // Stable default colour per trace; explicit overrides win.
  const colorFor = useCallback(
    (trace: string): string => {
      if (colors[trace]) return colors[trace];
      const rawIdx = result?.variables.indexOf(trace) ?? -1;
      let idx: number;
      if (rawIdx >= 0) idx = rawIdx; // raw signals (incl. per-step) keep distinct colours
      else if (expressions.indexOf(trace) >= 0) idx = (result?.variables.length ?? 0) + expressions.indexOf(trace);
      else {
        // Per-step expression render ("E @tag"): stable hash so each step differs.
        let h = 0;
        for (let i = 0; i < trace.length; i++) h = (h * 31 + trace.charCodeAt(i)) | 0;
        idx = Math.abs(h);
      }
      return palette[idx % palette.length];
    },
    [colors, result, expressions, palette],
  );

  const panelForTrace = useCallback(
    (trace: string) => traceToPanel[trace] ?? traceToPanel[stripStepTag(trace)] ?? panels[0]?.id,
    [traceToPanel, panels],
  );

  // Unassigned traces default to the first pane (panels[0]). Inserting a pane
  // above the top pane would make the new empty pane become panels[0] and steal
  // those traces, so it looks like the pane was added below. Pin the defaulting
  // traces to their current pane first so they stay put.
  const addRelative = useCallback(
    (refId: string, pos: "above" | "below") => {
      const firstId = panels[0]?.id;
      if (firstId) {
        for (const t of allTraces) {
          if (traceToPanel[t] == null) setTracePanel(t, firstId);
        }
      }
      addPanelRelative(refId, pos);
    },
    [panels, allTraces, traceToPanel, setTracePanel, addPanelRelative],
  );

  const handleAddExpression = () => {
    const expr = exprInput.trim();
    if (!expr) return;
    if (checkResult) {
      const r = evalExpression(checkResult, expr, paramMap);
      if (r.error) { setExprError(r.error); return; }
    }
    addExpression(expr);
    setExprInput("");
    setExprError(null);
  };

  // Commit an inline edit of an existing function. Reject (return false, keeping
  // the row in edit mode) when the new expression doesn't parse.
  const handleEditExpression = (oldExpr: string, next: string): boolean => {
    const trimmed = next.trim();
    if (!trimmed) return false;
    if (checkResult) {
      const r = evalExpression(checkResult, trimmed, paramMap);
      if (r.error) { setExprError(r.error); return false; }
    }
    setExprError(null);
    updateExpression(oldExpr, trimmed);
    return true;
  };

  // Each panel registers a builder that produces its export SVG (with readout
  // boxes baked in); "export all" stacks them into one file.
  const exportersRef = useRef<Map<string, () => SVGSVGElement | null>>(new Map());
  const registerExport = useCallback((id: string, build: (() => SVGSVGElement | null) | null) => {
    if (build) exportersRef.current.set(id, build);
    else exportersRef.current.delete(id);
  }, []);

  const handleExportAllSvg = useCallback(() => {
    const GAP = 12;
    // Keep the on-screen panel order.
    const parts = panels
      .map((p) => exportersRef.current.get(p.id)?.())
      .filter((s): s is SVGSVGElement => !!s);
    if (parts.length === 0) return;
    const width = Math.max(...parts.map((s) => Number(s.getAttribute("width")) || 0));
    const heights = parts.map((s) => Number(s.getAttribute("height")) || 0);
    const totalH = heights.reduce((a, b) => a + b, 0) + GAP * (parts.length - 1);
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("xmlns", SVG_NS);
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(totalH));
    root.setAttribute("viewBox", `0 0 ${width} ${totalH}`);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", String(width));
    bg.setAttribute("height", String(totalH));
    bg.setAttribute("fill", plotThemeFor(svgLight).plotBg);
    root.appendChild(bg);
    let y = 0;
    parts.forEach((s, i) => {
      // Nest each panel SVG as its own viewport at the stacked offset.
      s.setAttribute("x", "0");
      s.setAttribute("y", String(y));
      root.appendChild(s);
      y += heights[i] + GAP;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`;
    downloadText(xml, `${(circuitName.trim() || "plot")}_Diagramme.svg`, "image/svg+xml");
  }, [panels, svgLight, circuitName]);

  // Save the plot configuration as an LTSpice-compatible `.plt` file, defaulting
  // to the current .asc's folder and base name.
  /**
   * The current plot configuration as `.plt` text.
   *
   * Shared by the Save button and by the LTSpice bundle export, which drops it
   * beside the `.asc` — LTSpice opens a schematic's `.plt` by itself, so the
   * waveform window comes up with the same panes, traces and colours instead of
   * empty. Only callable once a simulation has produced data; `setPltBuilder`
   * below is what tells the rest of the app whether that is the case.
   */
  const buildPltText = () => {
    const time = result!.time!;
    const doc = buildPltDoc({
      analysis: ANALYSIS_LABEL[analysisType] ?? "Transient Analysis",
      panels, colors, syncX, svgLight,
      tracesOf: (panel) => allTraces.filter((t) => panelForTrace(t) === panel.id && t !== panel.xTrace),
      // A hidden function has no trace, so it is not in allTraces — take it from
      // the expression list, or its colour and its "off" state would be lost.
      hiddenOf: (panel) =>
        expressions.filter((e) => hiddenExpressions.includes(e) && panelForTrace(e) === panel.id),
      yAxesOf: (panel, traces) => applyYOverrides(groupByUnit(traces, seriesMap.map), panel),
      // A parametric panel's x bounds describe its x-trace, not the time base.
      xRangeOf: (panel) => {
        const xs = (panel.xTrace ? seriesMap.map[panel.xTrace] : null) ?? time;
        return { low: panel.xMin ?? xs[0], high: panel.xMax ?? xs[xs.length - 1], ticks: panel.xTicks };
      },
    });
    return serializePlt(doc);
  };

  const handleSavePlt = async () => {
    const content = buildPltText();
    const suggestedName = `${circuitName.trim() || "plot"}.plt`;
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName,
          startIn: fileHandle ?? undefined,
          types: [{ description: "LTSpice Plot Settings", accept: { "text/plain": [".plt"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        // fall through to a plain download
      }
    }
    downloadText(content, suggestedName, "text/plain");
  };

  // Load an LTSpice `.plt` file, starting the picker in the current .asc's folder.
  const handleLoadPlt = async () => {
    const read = (f: File) => decodePltFile(f);
    if ("showOpenFilePicker" in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          startIn: fileHandle ?? undefined,
          types: [{ description: "LTSpice Plot Settings", accept: { "text/plain": [".plt"], "application/octet-stream": [".plt"] } }],
          multiple: false,
        });
        if (!applyPltText(await read(await handle.getFile()))) alert("Invalid .plt file");
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        // fall through to a plain <input> picker
      }
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".plt";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file && !applyPltText(await read(file))) alert("Invalid .plt file");
    };
    input.click();
  };

  // Hand the `.plt` builder to the rest of the app, or take it back when there
  // is nothing plotted. No dependency list on purpose: the builder closes over
  // this render's panels, colours and traces, and a stale one would export the
  // plot as it looked two edits ago. Assigning a function reference is cheap.
  useEffect(() => {
    setPltBuilder(result?.time?.length ? buildPltText : null);
    return () => setPltBuilder(null);
  });

  const noData = (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#64748b", background: pt.panelBg }}>
      <p style={{ margin: 0, fontSize: compact ? 12 : 14 }}>No simulation data</p>
      <p style={{ margin: 0, fontSize: 11, color: "#475569" }}>Run simulation — double-click a component to probe</p>
    </div>
  );
  if (!result) return noData;

  // Operating point (`.op`) — or any single-point result — has one DC value per
  // signal and no sweep/time axis to plot, so show the values as a table
  // (LTSpice-style) instead of an empty graph. An `.op` driven by `.step` does
  // have an axis (the engine makes the swept param the x-axis), so it falls
  // through and is plotted like any other sweep.
  const hasSweepAxis = (result.time?.length ?? 0) > 1;
  if (!hasSweepAxis && (analysisType === "op" || result.time?.length === 1)) {
    const rows = dedupeProbes(result.variables)
      .filter(({ raw }) => raw !== "time" && raw !== "frequency")
      .map(({ raw, display }) => ({ display, value: result.data[raw]?.[0] ?? NaN, unit: inferUnit(raw) }));
    return (
      <div style={{ height: "100%", overflow: "auto", background: pt.panelBg, padding: compact ? 12 : 20 }}>
        <div style={{ fontSize: compact ? 12 : 14, fontWeight: 600, color: pt.text, marginBottom: 10 }}>
          {analysisType === "op" ? "Operating Point (.op)" : "DC bias values"}
        </div>
        {rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>No node voltages or currents in the result.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", fontFamily: "monospace", fontSize: compact ? 11 : 13 }}>
            <tbody>
              {rows.map((r) => (
                <tr key={r.display}>
                  <td style={{ padding: "3px 24px 3px 0", color: pt.heading, whiteSpace: "nowrap" }}>{r.display}</td>
                  <td style={{ padding: "3px 0", textAlign: "right", color: pt.text, whiteSpace: "nowrap" }}>{fmtVal(r.value, r.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  // No usable time base (e.g. a failed run).
  if (!result.time || result.time.length === 0) return noData;

  const sidebarW = compact ? 150 : 210;

  return (
    // Scroll wrapper: under heavy browser zoom (Ctrl+wheel) the fixed-size
    // sidebar and min-height panels can grow past the viewport — scroll to reach
    // the rest instead of clipping it.
    <div style={{ height: "100%", overflow: "auto", background: pt.panelBg }}>
    <div style={{ height: "100%", minWidth: compact ? 320 : 480, minHeight: compact ? 180 : 300, display: "flex" }}>
      {/* ── Sidebar: probes, colours, expressions ── */}
      <div style={{
        width: sidebarW, flexShrink: 0, borderRight: `1px solid ${pt.border}`,
        background: pt.sidebarBg,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: compact ? "6px 8px" : "10px 12px", borderBottom: `1px solid ${pt.border}`, background: pt.sidebarBg }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: pt.heading, textTransform: "uppercase" }}>Probes</span>
          {/* Only offered when the run actually produced measurements, so the
              control does not sit there dead for the common single-run case. */}
          {hasMeas && (
            <div style={{ display: "flex", gap: 0, marginTop: 6, border: `1px solid ${pt.border}`, borderRadius: 4, overflow: "hidden" }}>
              {([["signals", "Signale"], ["measurements", "Messwerte"]] as const).map(([view, label]) => (
                <button
                  key={view}
                  onClick={() => setScopeView(view)}
                  title={view === "measurements"
                    ? "Die .meas-Ergebnisse über dem gestuften Parameter"
                    : "Die simulierten Signale über der Zeit"}
                  style={{
                    flex: 1, padding: "3px 6px", fontSize: 10, cursor: "pointer", border: "none",
                    background: scopeView === view ? pt.activeBg : "transparent",
                    color: scopeView === view ? pt.heading : pt.textMuted,
                    fontWeight: scopeView === view ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <label
            title="Add a component's current to the probes when you click it in the schematic"
            style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer", color: pt.textMuted, fontSize: 10 }}
          >
            <input type="checkbox" checked={autoProbeCurrent} onChange={toggleAutoProbeCurrent} style={{ cursor: "pointer" }} />
            Current on click
          </label>
        </div>

        {/* Expression builder (arithmetic on probe variables). Deliberately *above*
            the list: anchored at the bottom, iPadOS covered it with the keyboard's
            autofill/shortcut bar — a bar that does not shrink the visual viewport,
            so no measurement can compensate for it. Up here it is out of reach of
            any on-screen keyboard, and it also stops drifting down as the probe
            list grows. */}
        <div style={{ padding: 6, borderBottom: `1px solid ${pt.border}`, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: pt.labelDim, textTransform: "uppercase" }}>Add function</div>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              value={exprInput}
              onChange={(e) => { setExprInput(e.target.value); setExprError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddExpression(); }}
              placeholder="V(a)-V(b)  ·  {R1}*I(D2) [V]  ·  ph(V(a))"
              title="Arithmetik über Messgrößen. {name} = Bauteilwert/.param. ph(V(a)) = Phase in Grad (nur .ac); sie bekommt eine eigene y-Achse. Optionale Einheit am Ende, z. B. [V], erzwingt die geteilte y-Achse."
              style={{
                flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 10, fontFamily: "monospace",
                background: pt.inputBg,
                color: pt.text,
                border: `1px solid ${pt.borderStrong}`,
                borderRadius: 4,
              }}
            />
            <button
              onClick={handleAddExpression}
              style={{ padding: "3px 8px", fontSize: 10, background: pt.border, color: pt.heading, border: `1px solid ${pt.borderStrong}`, borderRadius: 4, cursor: "pointer" }}
            >
              +
            </button>
          </div>
          {exprError && <div style={{ fontSize: 9, color: "#f87171" }}>{exprError}</div>}
        </div>

        {/* Functions, right under the field that creates them: appended at the
            bottom of the probe list, a new one landed at the very end of a long
            scroll — on the iPad behind the keyboard bar, exactly where it is
            hardest to reach. They grow downward from here instead. */}
        {expressions.length > 0 && (
          <div className="keyboard-safe" style={{ padding: "0 6px 6px", display: "flex", flexDirection: "column", gap: 2, borderBottom: `1px solid ${pt.border}`, flexShrink: 0, maxHeight: "40%", overflow: "auto" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: pt.labelDim, textTransform: "uppercase", padding: "2px 0" }}>
              Functions
            </div>
            {expressions.map((expr) => (
              <ProbeRow
                key={expr}
                label={expr}
                color={colorFor(expr)}
                active={!hiddenExpressions.includes(expr)}
                draggable
                error={seriesMap.errors[expr]}
                onToggle={() => toggleExpressionHidden(expr)}
                onDragStart={(e) => e.dataTransfer.setData(DND_MIME, expr)}
                onSwatch={() => setColorPickerFor(colorPickerFor === expr ? null : expr)}
                showPicker={colorPickerFor === expr}
                onPick={(c) => { setColor(expr, c); setColorPickerFor(null); }}
                onRemove={() => removeExpression(expr)}
                onEdit={(next) => handleEditExpression(expr, next)}
              />
            ))}
          </div>
        )}

        <div className="keyboard-safe" style={{ padding: 6, display: "flex", flexDirection: "column", gap: 2, flex: 1, overflow: "auto" }}>
          {probeGroups
            ? probeGroups.map((g) => {
                const key = g.members[0].raw;
                const open = expandedGroups.has(key);
                const selCount = g.members.filter((m) => selectedVariables.includes(m.raw)).length;
                return (
                  <div key={key} style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", fontSize: 11, color: "#cbd5e1" }}>
                      <button onClick={() => toggleGroupOpen(key)} title={open ? "Collapse" : "Expand"}
                        style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", width: 12, padding: 0, fontSize: 10 }}>
                        {open ? "▾" : "▸"}
                      </button>
                      <input type="checkbox" style={{ cursor: "pointer" }}
                        checked={selCount === g.members.length}
                        ref={(el) => { if (el) el.indeterminate = selCount > 0 && selCount < g.members.length; }}
                        onChange={() => toggleGroupAll(g.members)} />
                      <span style={{ flex: 1, cursor: "pointer", fontWeight: 600 }} onClick={() => toggleGroupOpen(key)}>{g.display}</span>
                      <span style={{ fontSize: 9, color: "#64748b" }}>{selCount}/{g.members.length}</span>
                    </div>
                    {open && g.members.map((m) => (
                      <div key={m.raw} style={{ marginLeft: 14 }}>
                        <ProbeRow
                          label={m.tag}
                          color={colorFor(m.raw)}
                          active={selectedVariables.includes(m.raw)}
                          draggable={selectedVariables.includes(m.raw)}
                          onToggle={() => toggleVariable(m.raw)}
                          onDragStart={(e) => e.dataTransfer.setData(DND_MIME, m.raw)}
                          onSwatch={() => setColorPickerFor(colorPickerFor === m.raw ? null : m.raw)}
                          showPicker={colorPickerFor === m.raw}
                          onPick={(c) => { setColor(m.raw, c); setColorPickerFor(null); }}
                        />
                      </div>
                    ))}
                  </div>
                );
              })
            : dedupeProbes(result.variables).map(({ raw, display }) => {
                const active = selectedVariables.includes(raw);
                const color = colorFor(raw);
                return (
                  <ProbeRow
                    key={raw}
                    label={display}
                    color={color}
                    active={active}
                    draggable={active}
                    onToggle={() => toggleVariable(raw)}
                    onDragStart={(e) => e.dataTransfer.setData(DND_MIME, raw)}
                    onSwatch={() => setColorPickerFor(colorPickerFor === raw ? null : raw)}
                    showPicker={colorPickerFor === raw}
                    onPick={(c) => { setColor(raw, c); setColorPickerFor(null); }}
                  />
                );
              })}

        </div>

      </div>

      {/* ── Panels (stacked; add/move/delete via right-click menu, drag targets) ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
        {panels.map((panel, i) => {
          // A parametric panel puts one quantity on the x-axis, so it is not drawn
          // as a curve; its series replaces the sweep/time base.
          const xSeries = panel.xTrace ? xSeriesFor(panel.xTrace, allTraces.find((t) => panelForTrace(t) === panel.id)) : null;
          const traces = allTraces.filter((t) => panelForTrace(t) === panel.id && t !== panel.xTrace);
          return (
            <PlotPanelView
              key={panel.id}
              panel={panel}
              traces={traces}
              seriesMap={seriesMap.map}
              time={xSeries ?? result.time!}
              xForTrace={panel.xTrace ? (t) => xSeriesFor(panel.xTrace, t) : undefined}
              xLabel={xSeries ? panel.xTrace : result.xLabel}
              xUnit={xSeries ? inferUnit(panel.xTrace!) : result.xUnit}
              colorFor={colorFor}
              compact={compact}
              index={i}
              count={panels.length}
              syncX={syncX}
              onDropTrace={(trace) => setTracePanel(trace, panel.id)}
              onRemoveTrace={(trace) =>
                expressions.includes(trace) ? removeExpression(trace) : toggleVariable(trace)}
              onAddRelative={(pos) => addRelative(panel.id, pos)}
              onMove={(dir) => movePanel(panel.id, dir)}
              onRemovePanel={() => removePanel(panel.id)}
              onFit={() => fitPanel(panel.id)}
              onToggleSyncX={toggleSyncX}
              onSavePlt={handleSavePlt}
              onLoadPlt={handleLoadPlt}
              onUpdate={(patch) => updatePanel(panel.id, patch)}
              onSetXQuantity={(q) => setPanelXQuantity(panel.id, q)}
              registerExport={registerExport}
              onExportAll={handleExportAllSvg}
            />
          );
        })}
      </div>
    </div>
    </div>
  );
}

/* ───────────────────────── Sidebar probe row ───────────────────────── */

interface ProbeRowProps {
  label: string;
  color: string;
  active: boolean;
  draggable: boolean;
  error?: string;
  onToggle: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onSwatch: () => void;
  showPicker: boolean;
  onPick: (c: string) => void;
  onRemove?: () => void;
  /** When set, the row is an editable function; returns true if the edit is
   *  accepted (valid), so the row can leave edit mode. */
  onEdit?: (next: string) => boolean;
}

function ProbeRow({ label, color, active, draggable, error, onToggle, onDragStart, onSwatch, showPicker, onPick, onRemove, onEdit }: ProbeRowProps) {
  const svgLight = usePlotStore((s) => s.svgLight);
  const pt = plotThemeFor(svgLight);
  const palette = pt.traces;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  // Set on Escape so the ensuing blur discards instead of committing.
  const cancelled = useRef(false);

  const beginEdit = () => { setDraft(label); setEditing(true); };
  const commitEdit = () => {
    if (cancelled.current) { cancelled.current = false; setEditing(false); return; }
    // A no-op change (or one the store rejects, e.g. invalid) leaves edit mode
    // only when accepted; keep editing so the user can fix a bad expression.
    if (draft.trim() === label || onEdit?.(draft) !== false) setEditing(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        draggable={draggable && !editing}
        onDragStart={onDragStart}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 6px", borderRadius: 4,
          background: active ? (pt.border) : "transparent",
          cursor: editing ? "text" : draggable ? "grab" : "pointer",
        }}
        title={editing ? undefined : draggable ? "Drag into a panel" : undefined}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onSwatch(); }}
          title="Change colour"
          style={{
            width: 12, height: 12, borderRadius: 3, flexShrink: 0, padding: 0,
            border: "1px solid #00000040", cursor: "pointer",
            background: active ? color : (pt.chipInactive),
          }}
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
            }}
            onBlur={commitEdit}
            style={{
              flex: 1, minWidth: 0, padding: "1px 4px", fontSize: 10, fontFamily: "monospace",
              background: pt.inputBg, color: pt.text,
              border: `1px solid ${pt.borderStrong}`, borderRadius: 3,
            }}
          />
        ) : (
          <button
            onClick={onToggle}
            style={{
              flex: 1, minWidth: 0, border: "none", background: "transparent", padding: 0,
              textAlign: "left", cursor: "pointer",
              fontSize: 10, fontFamily: "monospace",
              color: error ? "#f87171" : active ? color : "#475569",
              wordBreak: "break-all",
            }}
          >
            {label}
          </button>
        )}
        {onEdit && !editing && (
          <button
            onClick={(e) => { e.stopPropagation(); beginEdit(); }}
            title="Funktion bearbeiten"
            style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
          >
            ✎
          </button>
        )}
        {onRemove && !editing && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove"
            style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        )}
      </div>
      {error && <div style={{ fontSize: 9, color: "#f87171", padding: "0 6px 2px 24px" }}>{error}</div>}
      {showPicker && (
        <div style={{
          position: "absolute", zIndex: 20, top: 22, left: 6,
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4,
          padding: 6,
          background: pt.cardBg,
          border: `1px solid ${pt.borderMuted}`,
          borderRadius: 6,
          boxShadow: "0 4px 12px #00000060",
        }}>
          {palette.map((c) => (
            <button
              key={c}
              onClick={() => onPick(c)}
              style={{ width: 16, height: 16, borderRadius: 3, background: c, border: c === color ? "2px solid #fff" : "1px solid #00000040", cursor: "pointer", padding: 0 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── One diagram panel ───────────────────────── */

interface PlotPanelViewProps {
  panel: PlotPanel;
  traces: string[];
  seriesMap: Record<string, Float64Array | null>;
  time: Float64Array;
  /**
   * x-series for one trace on a parametric panel. A swept family carries one
   * run per step, so each curve needs the x-quantity *from its own run* — a
   * single shared array would draw all of them against the first step's x.
   * Returns null for a non-parametric panel, where `time` serves everyone.
   */
  xForTrace?: (trace: string) => Float64Array | null;
  /** When set, the x-axis is a swept parameter (not time) — used for labels. */
  xLabel?: string;
  /** Physical unit of the x-axis (e.g. "V" for a `.dc` sweep); default seconds. */
  xUnit?: string;
  colorFor: (trace: string) => string;
  compact: boolean;
  index: number;
  count: number;
  syncX: boolean;
  onDropTrace: (trace: string) => void;
  onRemoveTrace: (trace: string) => void;
  onAddRelative: (position: "above" | "below") => void;
  onMove: (dir: "up" | "down") => void;
  onRemovePanel: () => void;
  onFit: () => void;
  onToggleSyncX: () => void;
  onSavePlt: () => void;
  onLoadPlt: () => void;
  onUpdate: (patch: Partial<PlotPanel>) => void;
  /** Set the x-axis quantity (parametric plot); undefined restores the time base. */
  onSetXQuantity: (quantity: string | undefined) => void;
  /** Register/unregister this panel's export-SVG builder with the parent, so it
   *  can combine every panel into one file. */
  registerExport: (id: string, build: (() => SVGSVGElement | null) | null) => void;
  /** Export all panels stacked into a single .svg (only shown when count > 1). */
  onExportAll: () => void;
}

function PlotPanelView(props: PlotPanelViewProps) {
  const { panel, traces, seriesMap, time, xForTrace, xLabel, xUnit, colorFor, compact, index, count, syncX,
    onDropTrace, onRemoveTrace, onAddRelative, onMove, onRemovePanel, onFit, onToggleSyncX, onSavePlt, onLoadPlt, onUpdate, onSetXQuantity,
    registerExport, onExportAll } = props;
  const margin = compact ? MARGIN_COMPACT : MARGIN;
  // The x-axis is time by default; for a swept-parameter/`.dc` run it is the
  // swept quantity, so format the ticks with its unit (e.g. "5V") instead of
  // seconds.
  const fmtX = (t: number, step?: number) => (xLabel ? fmtVal(t, xUnit ?? "", step) : fmtTime(t, step));
  const canRemove = count > 1;
  const circuitName = useCircuitStore((s) => s.circuitName);
  const svgLight = usePlotStore((s) => s.svgLight);
  const toggleSvgLight = usePlotStore((s) => s.toggleSvgLight);
  const isDark = !svgLight;
  const pt = plotThemeFor(svgLight);
  const th = pt.diagram;

  /** Merge a manual override into one unit's y-axis. */
  const setYAxis = (unit: string, patch: { min?: number; max?: number; ticks?: number }) =>
    onUpdate({ yAxes: { ...panel.yAxes, [unit]: { ...panel.yAxes?.[unit], ...patch } } });

  const ctrlBtnStyle: React.CSSProperties = {
    padding: "2px 8px", fontSize: 10,
    background: pt.activeBg,
    color: pt.heading,
    border: `1px solid ${pt.borderStrong}`,
    borderRadius: 4, cursor: "pointer", flexShrink: 0,
  };
  const menuItemStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "4px 10px", textAlign: "left",
    border: "none", background: "transparent",
    color: pt.text,
    cursor: "pointer", fontSize: 11, borderRadius: 4, whiteSpace: "nowrap",
  };
  const menuDivider = { height: 1, background: pt.borderMuted, margin: "4px 0" };
  const menuPopup: React.CSSProperties = {
    position: "fixed", zIndex: 41,
    background: pt.cardBg,
    border: `1px solid ${pt.borderMuted}`,
    borderRadius: 6, padding: 4, fontSize: 11,
    boxShadow: "0 4px 12px #00000070",
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: compact ? 180 : 260 });
  const [showAxis, setShowAxis] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** Measurement cursor bound to one probe; `t` is a value on the x-axis. */
  const [cursor, setCursor] = useState<{ trace: string; t: number } | null>(null);
  /** Permanently "stamped" cursor positions – each carries its computed readout position (px). */
  const [stamps, setStamps] = useState<{ trace: string; t: number; top: number; left: number | null }[]>([]);
  /** Manual vertical position for the live cursor readout (px from container top). */
  const [cursorManualTop, setCursorManualTop] = useState<number | null>(null);
  /** Probe context menu (cursor toggle), at viewport coords. */
  const [menu, setMenu] = useState<{ trace: string; x: number; y: number } | null>(null);
  /** Pane context menu (add/move/delete/sync), at viewport coords. */
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Publish the cursor's instant so the schematic can read it. The gesture stays
  // here — the store only carries the number — and a display on the sheet then
  // shows the value at exactly the point the cursor sits on (see
  // SevenSegmentNode). Cleared on unmount, so a closed panel leaves no ghost.
  const setCursorTime = usePlotStore((s) => s.setCursorTime);
  useEffect(() => {
    setCursorTime(cursor ? cursor.t : null);
  }, [cursor, setCursorTime]);
  useEffect(() => () => setCursorTime(null), [setCursorTime]);

  // Drop the cursor / stamps whose probe leaves this panel.
  useEffect(() => {
    if (cursor && !traces.includes(cursor.trace)) setCursor(null);
    setStamps((s) => s.filter((st) => traces.includes(st.trace)));
  }, [cursor, traces]);

  // When cursor switches to a new trace, reset the manual top so the box
  // re-anchors to the new trace's y-value.
  useEffect(() => { setCursorManualTop(null); }, [cursor?.trace]);

  const RIGHT_AXIS_W = compact ? 42 : 50;

  // Group traces by unit → one y-axis each (first left, the rest stacked right,
  // LTSpice-style). Each axis can be scaled manually (see the settings menu).
  const groups = useMemo(() => groupByUnit(traces, seriesMap), [traces, seriesMap]);
  const yGroups: AxisGroup[] = applyYOverrides(groups, panel);
  const y0: AxisGroup = yGroups[0] ?? { unit: "", traces: [], yMin: -1, yMax: 1 };
  const rightCount = Math.max(0, yGroups.length - 1);
  const marginRight = margin.right + rightCount * RIGHT_AXIS_W;

  const plotW = dims.w - margin.left - marginRight;
  const plotH = dims.h - margin.top - margin.bottom;

  // Span of the x-axis across every drawn trace. Without a parametric x-axis all
  // traces share `time` and this is just its first/last sample.
  const xExtent: [number, number] = useMemo(() => {
    if (!xForTrace) return [time[0], time[time.length - 1]];
    let lo = Infinity, hi = -Infinity;
    for (const t of traces) {
      const xs = xForTrace(t) ?? time;
      for (let i = 0; i < xs.length; i++) {
        const v = xs[i];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return isFinite(lo) && isFinite(hi) && lo !== hi ? [lo, hi] : [time[0], time[time.length - 1]];
  }, [xForTrace, traces, time]);

  // x defaults to the saved-data window (tstart..tstop).
  //
  // A hand-set bound is only taken when the two still describe a range. Typing a
  // right bound below the left one — easily done, the fields sit next to each
  // other and a `.tran` window can start at 99.97ms — left `(t - xMin)/(xMax -
  // xMin)` negative or infinite for every sample, so every trace was placed off
  // the pane and the plot went blank with nothing on screen saying why. The
  // entered number stays in the field; only the drawing falls back to auto.
  const xLowSet = panel.xMin ?? xExtent[0];
  const xHighSet = panel.xMax ?? xExtent[1];
  const xUsable = usableRange(xLowSet, xHighSet);
  const vr: ViewRange = {
    // Over every trace's x-series: on a parametric panel the runs need not share
    // a range, and taking only the first would clip the others.
    xMin: xUsable ? xLowSet : xExtent[0],
    xMax: xUsable ? xHighSet : xExtent[1],
    yMin: y0.yMin,
    yMax: y0.yMax,
  };

  const logX = !!panel.logX;
  const xLo = logX ? Math.max(vr.xMin, 1e-30) : vr.xMin;
  const lxMin = logX ? Math.log10(xLo) : vr.xMin;
  const lxMax = logX ? Math.log10(Math.max(vr.xMax, xLo * 10)) : vr.xMax;

  const toSx = (t: number): number => {
    if (logX) return t <= 0 ? NaN : ((Math.log10(t) - lxMin) / (lxMax - lxMin)) * plotW;
    return ((t - vr.xMin) / (vr.xMax - vr.xMin)) * plotW;
  };

  // y-axis scale (linear / log10 / dB). Log and dB axes are linear in fwd-space
  // (log10 v / 20·log10|v|), so their extent is fitted from the data there — the
  // linear-space yMin/yMax (and their manual overrides) don't apply.
  const yScale: YScale = panel.yScale ?? "linear";
  const ymap = yScaleMaps(yScale);
  const fwdDomain = (g: { yMin: number; yMax: number; traces: string[] }): [number, number] => {
    if (yScale === "linear") return [g.yMin, g.yMax];
    let lo = Infinity, hi = -Infinity;
    for (const tr of g.traces) {
      const d = seriesMap[tr];
      if (!d) continue;
      for (const v of d) { const f = ymap.fwd(v); if (isFinite(f)) { if (f < lo) lo = f; if (f > hi) hi = f; } }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.05;
    return [lo - pad, hi + pad];
  };
  const mkToSy = (g: { yMin: number; yMax: number; traces: string[] }) => {
    const [fLo, fHi] = fwdDomain(g);
    return (v: number): number => plotH - ((ymap.fwd(v) - fLo) / (fHi - fLo)) * plotH;
  };
  // y-axis tick data-values + labels for one group, honouring the scale mode.
  // The `tick` field (g.ticks) sets the spacing: for dB it is a step in dB, for
  // log a step in decades (log10), for linear a step in data units.
  const yTicksFor = (g: AxisGroup): { v: number; label: string }[] => {
    const [fLo, fHi] = fwdDomain(g);
    if (yScale === "db")
      return ticksFor(fLo, fHi, g.ticks, autoYCount).map((u) => ({ v: ymap.inv(u), label: `${Number(u.toPrecision(3))}dB` }));
    if (yScale === "log") {
      // With an explicit tick step, space decades linearly in log10; otherwise
      // fall back to the natural 1·2·5 decade ticks.
      if (g.ticks && g.ticks > 0)
        return ticksFor(fLo, fHi, g.ticks, autoYCount).map((u) => ({ v: ymap.inv(u), label: fmtVal(ymap.inv(u)) }));
      return logTicks(ymap.inv(fLo), ymap.inv(fHi)).map((v) => ({ v, label: fmtVal(v) }));
    }
    // A linear axis is the one that can zoom in far enough for four digits to
    // stop separating its ticks, so its labels are the ones told the spacing.
    const lin = ticksFor(g.yMin, g.yMax, g.ticks, autoYCount);
    const step = tickStep(lin);
    return lin.map((v) => ({ v, label: fmtVal(v, "", step) }));
  };
  const toSy = mkToSy(y0); // left axis
  const groupOf = (t: string) => yGroups.find((g) => g.traces.includes(t)) ?? y0;

  /** The x-samples a trace is drawn against: its own on a parametric panel. */
  const xsOf = (trace: string): Float64Array => xForTrace?.(trace) ?? time;

  const buildPath = (data: Float64Array, sy: (v: number) => number, xs: Float64Array = time): string => {
    let d = "";
    let first = true;
    const n = Math.min(xs.length, data.length);
    for (let i = 0; i < n; i++) {
      const x = toSx(xs[i]);
      const y = sy(data[i]);
      if (!isFinite(x) || !isFinite(y)) { first = true; continue; }
      d += first ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
      first = false;
    }
    return d;
  };

  // Auto tick counts when no explicit spacing (panel.xTicks/yTicks) is set.
  const autoXCount = Math.max(4, Math.floor(plotW / 80));
  const autoYCount = Math.max(3, Math.floor(plotH / 60));
  // Log x-axis: label 1·2·5 per decade; the 1…9 minor lines below fill in the
  // classic 10-gridlines-per-decade look.
  const xTicks = logX ? logTicks(xLo, vr.xMax) : ticksFor(vr.xMin, vr.xMax, panel.xTicks, autoXCount);
  const yTicks = yTicksFor(y0);

  // Minor gridlines (no labels): finer grid between the labelled major lines,
  // LTSpice-style. Log axes get every integer decade multiple (2…9); linear/dB
  // axes get one line halfway between each major.
  const xMinor = logX ? logMinorTicks(xLo, vr.xMax) : minorTicksLinear(xTicks, 2);
  const [yfLo, yfHi] = yScale === "linear" ? [y0.yMin, y0.yMax] : fwdDomain(y0);
  const yMinor = yScale === "log"
    ? logMinorTicks(ymap.inv(Math.min(yfLo, yfHi)), ymap.inv(Math.max(yfLo, yfHi)))
    : minorTicksLinear(yTicks.map((t) => t.v), 2);

  /** Nearest sample index within a trace's own x-series (binary search). */
  const nearestIndex = (t: number, xs: Float64Array = time): number => {
    let lo = 0, hi = xs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(xs[lo - 1] - t) < Math.abs(xs[lo] - t)) return lo - 1;
    return lo;
  };

  // Snap the cursor to the nearest sample and read its x/y.
  const cursorInfo = cursor
    ? (() => {
        const cx = xsOf(cursor.trace);
        const idx = nearestIndex(cursor.t, cx);
        const sampleT = cx[idx];
        const value = seriesMap[cursor.trace]?.[idx] ?? NaN;
        const sy = mkToSy(groupOf(cursor.trace))(value);
        return { idx, sampleT, value, sx: toSx(sampleT), sy, color: colorFor(cursor.trace) };
      })()
    : null;

  // Screen positions for each stamp (snapped to the nearest sample).
  const stampInfos = stamps.map((st, i) => {
    const sx = xsOf(st.trace);
    const idx = nearestIndex(st.t, sx);
    const sampleT = sx[idx];
    const value = seriesMap[st.trace]?.[idx] ?? NaN;
    return { i, trace: st.trace, sampleT, value, sx: toSx(sampleT), sy: mkToSy(groupOf(st.trace))(value), color: colorFor(st.trace), top: st.top, left: st.left };
  });

  // Build a standalone export SVG for this panel: a clone of the live plot SVG
  // (traces, grid, cursor/stamp markers) plus the cursor & stamp readout boxes
  // rendered as native SVG — the on-screen boxes are HTML overlays and would be
  // lost otherwise.
  const buildExportSvg = (): SVGSVGElement | null => {
    const src = document.getElementById(`osc-svg-${panel.id}`) as SVGSVGElement | null;
    if (!src) return null;
    const clone = src.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", SVG_NS);
    const doc = clone.ownerDocument;
    if (cursorInfo && isFinite(cursorInfo.sx)) {
      const autoTop = clampTop(isFinite(cursorInfo.sy) ? margin.top + cursorInfo.sy - READOUT_H / 2 : 4, dims.h);
      const boxTop = cursorManualTop ?? autoTop;
      const boxLeft = Math.min(dims.w - READOUT_W, margin.left + cursorInfo.sx + 8);
      clone.appendChild(svgReadoutBox(doc, boxLeft, boxTop, {
        color: cursorInfo.color, title: displayVar(cursor!.trace),
        xText: fmtX(cursorInfo.sampleT), yText: fmtVal(cursorInfo.value), dark: isDark,
      }));
    }
    for (const s of stampInfos) {
      if (!isFinite(s.sx)) continue;
      const sLeft = s.left ?? Math.min(dims.w - READOUT_W, margin.left + s.sx + 8);
      clone.appendChild(svgReadoutBox(doc, sLeft, s.top, {
        color: s.color, title: displayVar(s.trace),
        xText: fmtX(s.sampleT), yText: fmtVal(s.value), dark: isDark,
      }));
    }
    const svgText = (x: number, y: number, s: string, o: { fill: string; anchor?: string; weight?: string }) => {
      const t = doc.createElementNS(SVG_NS, "text");
      t.setAttribute("x", String(x)); t.setAttribute("y", String(y));
      t.setAttribute("fill", o.fill); t.setAttribute("font-size", "10");
      t.setAttribute("font-family", "ui-monospace, monospace");
      if (o.anchor) t.setAttribute("text-anchor", o.anchor);
      if (o.weight) t.setAttribute("font-weight", o.weight);
      t.textContent = s;
      return t;
    };
    // y-axis caption (manual, else derived from the primary unit).
    const yCap = panel.yLabel?.trim() || defaultAxisLabel(y0.unit);
    if (yCap) clone.appendChild(svgText(6, 12, yCap, { fill: th.axis, weight: "600" }));
    // Legend of probe names (colour swatch + name), top-right inside the plot.
    if (traces.length > 0) {
      const names = traces.map(displayVar);
      const legW = Math.max(60, ...names.map((n) => n.length * 6 + 24));
      const rightEdge = margin.left + plotW;
      const gx = rightEdge - legW - 8, gy = margin.top + 8;
      const g = doc.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `translate(${gx},${gy})`);
      const box = doc.createElementNS(SVG_NS, "rect");
      box.setAttribute("width", String(legW)); box.setAttribute("height", String(traces.length * 15 + 8));
      box.setAttribute("rx", "4"); box.setAttribute("fill", pt.plotBg);
      box.setAttribute("fill-opacity", "0.85"); box.setAttribute("stroke", th.frame);
      g.appendChild(box);
      traces.forEach((t, i) => {
        const ry = 8 + i * 15;
        const sw = doc.createElementNS(SVG_NS, "rect");
        sw.setAttribute("x", "7"); sw.setAttribute("y", String(ry)); sw.setAttribute("width", "10");
        sw.setAttribute("height", "3"); sw.setAttribute("rx", "1"); sw.setAttribute("fill", colorFor(t));
        g.appendChild(sw);
        g.appendChild(svgText(22, ry + 4, names[i], { fill: pt.text }));
      });
      clone.appendChild(g);
    }
    return clone;
  };

  // Export just this panel (readouts included).
  const handleExportSvg = () => {
    const svg = buildExportSvg();
    if (!svg) return;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
    downloadText(xml, `${(circuitName.trim() || "plot")}_Diagramm.svg`, "image/svg+xml");
  };

  // Keep the parent's exporter registry pointed at the latest closure so a
  // combined "export all" always serialises the current cursor/stamp state.
  const buildExportRef = useRef(buildExportSvg);
  buildExportRef.current = buildExportSvg;
  useEffect(() => {
    registerExport(panel.id, () => buildExportRef.current());
    return () => registerExport(panel.id, null);
  }, [panel.id, registerExport]);

  // Stamp the current cursor position (or the panel centre) for `trace`.
  // Initial top is positioned at the data value's y-coordinate.
  const stampCursor = (trace: string) => {
    const t = cursor?.trace === trace ? cursor.t : (vr.xMin + vr.xMax) / 2;
    const idx = nearestIndex(t);
    const value = seriesMap[trace]?.[idx] ?? NaN;
    const sy = mkToSy(groupOf(trace))(value);
    const top = clampTop(
      isFinite(sy) ? margin.top + sy - READOUT_H / 2 : 4,
      dims.h,
    );
    setStamps((prev) => [...prev, { trace, t, top, left: null }]);
  };

  /** Start dragging a readout box. Calls `onUpdate(newTop, newLeft)` on every move. */
  const startDragReadout = (
    e: React.PointerEvent,
    currentTop: number,
    currentLeft: number,
    onUpdate: (top: number, left: number) => void,
  ) => {
    if (!isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    trackPointerDrag(e, (ev) => onUpdate(currentTop + ev.clientY - startY, currentLeft + ev.clientX - startX));
  };

  // Drag the cursor horizontally (this is the only pointer interaction; axis
  // range is set exclusively through the settings menu).
  const startCursorDrag = (e: React.PointerEvent) => {
    if (!isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    trackPointerDrag(e, (ev) => {
      const px = ev.clientX - rect.left - margin.left;
      const frac = Math.max(0, Math.min(1, px / plotW));
      const t = logX ? 10 ** (lxMin + frac * (lxMax - lxMin)) : vr.xMin + frac * (vr.xMax - vr.xMin);
      setCursor((c) => (c ? { ...c, t } : c));
    });
  };

  const minPaneH = compact ? MIN_PANE_H_COMPACT : MIN_PANE_H;

  // Drag the bottom edge to set this panel's height (independent of the others).
  const startResize = (e: React.PointerEvent) => {
    if (!isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = panelRef.current?.getBoundingClientRect().height ?? dims.h;
    trackPointerDrag(e, (ev) => onUpdate({ height: Math.max(minPaneH, startH + (ev.clientY - startY)) }));
  };

  return (
    <div
      ref={panelRef}
      style={{
        flex: panel.height ? "0 0 auto" : "1 0 auto",
        height: panel.height, minHeight: minPaneH, display: "flex", flexDirection: "column",
        borderBottom: `1px solid ${pt.border}`,
        outline: dragOver ? "2px dashed #22d3ee" : "none", outlineOffset: -2,
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DND_MIME)) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const trace = e.dataTransfer.getData(DND_MIME);
        if (trace) { e.preventDefault(); onDropTrace(trace); }
      }}
    >
      {/* Panel header: legend chips + controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: pt.toolbarBg, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {traces.length === 0 && (
            <span style={{ fontSize: 10, color: pt.placeholder }}>Drag a probe here…</span>
          )}
          {traces.map((t) => (
            <span
              key={t}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DND_MIME, t)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ trace: t, x: e.clientX, y: e.clientY }); }}
              title="Right-click for cursor"
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "1px 6px", borderRadius: 10,
                background: cursor?.trace === t
                  ? (pt.borderStrong)
                  : (pt.border),
                fontSize: 10, fontFamily: "monospace", color: colorFor(t), cursor: "grab",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 4, background: colorFor(t) }} />
              {displayVar(t)}
              <button
                onClick={() => onRemoveTrace(t)}
                title="Remove from panel"
                style={{ border: "none", background: "transparent", color: pt.labelDim, cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
              >×</button>
            </span>
          ))}
        </div>
        <button onClick={toggleSvgLight} title={svgLight ? "Diagram: light — switch to dark" : "Diagram: dark — switch to light (print/beamer, white background)"} style={ctrlBtnStyle}>{svgLight ? "☀" : "🌙"}</button>
        <button onClick={() => setShowAxis((s) => !s)} title="Axis settings" style={ctrlBtnStyle}>⚙</button>
        <button onClick={onFit} title="Fit view" style={ctrlBtnStyle}>Fit</button>
        <button onClick={(e) => setPaneMenu({ x: e.clientX, y: e.clientY })} title="Pane menu" style={ctrlBtnStyle}>⋯</button>
      </div>

      {/* Axis configuration */}
      {showAxis && (
        <div style={{ display: "flex", gap: 16, padding: "4px 8px", background: pt.toolbarBg, borderTop: `1px solid ${pt.border}`, flexWrap: "wrap" }}>
          <AxisFields
            title="x-axis"
            min={panel.xMin} max={panel.xMax} ticks={panel.xTicks}
            autoMin={round6(vr.xMin)} autoMax={round6(vr.xMax)}
            minLabel="left" maxLabel="right"
            onMin={(v) => onUpdate({ xMin: v })}
            onMax={(v) => onUpdate({ xMax: v })}
            onTicks={(v) => onUpdate({ xTicks: v })}
            extra={
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#94a3b8" }}>
                  <input type="checkbox" checked={logX} onChange={(e) => onUpdate({ logX: e.target.checked })} />
                  logarithmic
                </label>
                <XQuantityField value={panel.xTrace} onChange={onSetXQuantity} />
              </>
            }
          />
          {(yGroups.length > 0 ? yGroups : [y0]).map((g, gi) => (
            <AxisFields
              key={g.unit || "y"}
              title={g.unit ? `y (${g.unit})` : "y-axis"}
              min={panel.yAxes?.[g.unit]?.min ?? (gi === 0 && !panel.yAxes?.[g.unit] ? panel.yMin : undefined)}
              max={panel.yAxes?.[g.unit]?.max ?? (gi === 0 && !panel.yAxes?.[g.unit] ? panel.yMax : undefined)}
              ticks={g.ticks}
              autoMin={round6(g.yMin)} autoMax={round6(g.yMax)}
              minLabel="bottom" maxLabel="top"
              onMin={(v) => setYAxis(g.unit, { min: v })}
              onMax={(v) => setYAxis(g.unit, { max: v })}
              onTicks={(v) => setYAxis(g.unit, { ticks: v })}
              extra={gi === 0 ? (
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#94a3b8" }}>
                  scale
                  <select
                    value={panel.yScale ?? "linear"}
                    onChange={(e) => onUpdate({ yScale: e.target.value as YScale })}
                    title="y-axis scale"
                    style={{
                      fontSize: 9, padding: "1px 2px",
                      background: pt.inputBg,
                      color: pt.text,
                      border: `1px solid ${pt.borderStrong}`, borderRadius: 3,
                    }}
                  >
                    <option value="linear">linear</option>
                    <option value="log">logarithmic</option>
                    <option value="db">decibel</option>
                  </select>
                </label>
              ) : undefined}
            />
          ))}
        </div>
      )}

      {/* Plot (axis range is set only via the settings menu — no zoom/pan) */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: "hidden", position: "relative" }}
        onContextMenu={(e) => { e.preventDefault(); setPaneMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <svg id={`osc-svg-${panel.id}`} width={dims.w} height={dims.h} style={{ display: "block" }}>
          <defs>
            <clipPath id={`osc-clip-${panel.id}`}>
              <rect x={0} y={0} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <rect width={dims.w} height={dims.h} fill={th.bg} />
          <rect x={margin.left} y={margin.top} width={plotW} height={plotH} fill={th.plot} rx={2} />
          <g transform={`translate(${margin.left},${margin.top})`}>
            {/* Minor gridlines (dashed) — drawn first so the major lines sit on top */}
            {xMinor.map((t) => { const x = toSx(t); return isFinite(x) ? (
              <line key={`xm-${t}`} x1={x} y1={0} x2={x} y2={plotH} stroke={th.grid} strokeWidth={1} strokeDasharray="3 3" />
            ) : null; })}
            {yMinor.map((v) => { const y = toSy(v); return isFinite(y) ? (
              <line key={`ym-${v}`} x1={0} y1={y} x2={plotW} y2={y} stroke={th.grid} strokeWidth={1} strokeDasharray="3 3" />
            ) : null; })}
            {xTicks.map((t) => (
              <g key={t}>
                <line x1={toSx(t)} y1={0} x2={toSx(t)} y2={plotH} stroke={th.grid} strokeWidth={1} />
                <text x={toSx(t)} y={plotH + 14} textAnchor="middle" fontSize={9} fill={th.axis}>{fmtX(t, tickStep(xTicks))}</text>
              </g>
            ))}
            {xLabel && (
              <text x={plotW / 2} y={plotH + 26} textAnchor="middle" fontSize={9} fontWeight={600} fill={th.axis}>{xLabel}</text>
            )}
            {/* Left y-axis (first unit group) with horizontal grid */}
            {yTicks.map(({ v, label }) => (
              <g key={v}>
                <line x1={0} y1={toSy(v)} x2={plotW} y2={toSy(v)} stroke={th.grid} strokeWidth={1} />
                <text x={-4} y={toSy(v) + 3} textAnchor="end" fontSize={9}
                  fill={yGroups.length > 1 ? colorFor(y0.traces[0]) : th.axis}>{label}</text>
              </g>
            ))}
            {y0.unit && yGroups.length > 1 && (
              <text x={-4} y={-4} textAnchor="end" fontSize={9} fill={colorFor(y0.traces[0])}>{y0.unit}</text>
            )}
            {yScale === "linear" && vr.yMin < 0 && vr.yMax > 0 && (
              <line x1={0} y1={toSy(0)} x2={plotW} y2={toSy(0)} stroke={th.line} strokeWidth={1} strokeDasharray="4 3" />
            )}

            {/* Additional y-axes (further unit groups), stacked to the right */}
            {yGroups.slice(1).map((g, r) => {
              const xLine = plotW + r * RIGHT_AXIS_W;
              const sy = mkToSy(g);
              const col = colorFor(g.traces[0]);
              return (
                <g key={g.unit || r}>
                  <line x1={xLine} y1={0} x2={xLine} y2={plotH} stroke={th.line} strokeWidth={1} />
                  {yTicksFor(g).map(({ v, label }) => (
                    <g key={v}>
                      <line x1={xLine} y1={sy(v)} x2={xLine + 3} y2={sy(v)} stroke={col} strokeWidth={1} />
                      <text x={xLine + 5} y={sy(v) + 3} textAnchor="start" fontSize={9} fill={col}>{label}</text>
                    </g>
                  ))}
                  {g.unit && <text x={xLine + 5} y={-4} textAnchor="start" fontSize={9} fill={col}>{g.unit}</text>}
                </g>
              );
            })}

            <g clipPath={`url(#osc-clip-${panel.id})`}>
              {traces.map((t) => {
                const d = seriesMap[t];
                // A Bode phase runs dashed, as LTSpice draws it: magnitude and
                // phase share the panel on two axes, and the line style says at
                // a glance which curve belongs to which. Keyed on the unit, so a
                // phase *difference* is dashed too.
                const dash = groupOf(t).unit === "°" ? "6 3" : undefined;
                return d ? <path key={t} d={buildPath(d, mkToSy(groupOf(t)), xsOf(t))} stroke={colorFor(t)} strokeWidth={1.5} strokeDasharray={dash} fill="none" vectorEffect="non-scaling-stroke" /> : null;
              })}
            </g>
            {/* Stamped cursor positions: dashed marker + dot (readout shown as HTML below SVG) */}
            {stampInfos.map((s) => isFinite(s.sx) ? (
              <g key={`stamp-${s.i}`} style={{ pointerEvents: "none" }}>
                <line x1={s.sx} y1={0} x2={s.sx} y2={plotH} stroke={s.color} strokeWidth={1} strokeDasharray="2 3" opacity={0.75} />
                {isFinite(s.value) && <circle cx={s.sx} cy={s.sy} r={3} fill={s.color} stroke={th.dot} strokeWidth={1} />}
              </g>
            ) : null)}
            {cursorInfo && isFinite(cursorInfo.sx) && (
              <g>
                <line x1={cursorInfo.sx} y1={0} x2={cursorInfo.sx} y2={plotH} stroke={cursorInfo.color} strokeWidth={1} strokeDasharray="4 3" />
                {isFinite(cursorInfo.value) && (
                  <circle cx={cursorInfo.sx} cy={mkToSy(groupOf(cursor!.trace))(cursorInfo.value)} r={3.5} fill={cursorInfo.color} stroke={th.dot} strokeWidth={1} style={{ pointerEvents: "none" }} />
                )}
                {/* Draggable handle + hit area */}
                <rect x={cursorInfo.sx - 5} y={0} width={10} height={plotH} fill="transparent" style={{ ...DRAG_TOUCH_ACTION, cursor: "ew-resize" }} onPointerDown={startCursorDrag} />
                <rect x={cursorInfo.sx - 4} y={2} width={8} height={9} rx={2} fill={cursorInfo.color} style={{ ...DRAG_TOUCH_ACTION, cursor: "ew-resize" }} onPointerDown={startCursorDrag} />
              </g>
            )}
            <rect x={0} y={0} width={plotW} height={plotH} fill="none" stroke={th.frame} strokeWidth={1} />
          </g>
        </svg>
        {/* Editable y-axis caption (top-left). Baked into the .svg on export. */}
        <input
          value={panel.yLabel ?? ""}
          onChange={(e) => onUpdate({ yLabel: e.target.value })}
          placeholder={defaultAxisLabel(y0.unit) || "y [Einheit]"}
          title="y-Achsen-Beschriftung (wird mit exportiert)"
          spellCheck={false}
          style={{
            position: "absolute", top: 2, left: 4, width: margin.left + 64,
            padding: "0 2px", fontSize: 10, fontFamily: "monospace", fontWeight: 600,
            background: "transparent", color: pt.axisText,
            border: "1px solid transparent", borderRadius: 3, outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = pt.borderStrong; e.currentTarget.style.background = pt.inputBg; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.background = "transparent"; }}
        />
        {cursorInfo && isFinite(cursorInfo.sx) && (() => {
          // Default: box centred on the data-value y; manual drag overrides.
          const autoTop = clampTop(
            isFinite(cursorInfo.sy) ? margin.top + cursorInfo.sy - READOUT_H / 2 : 4,
            dims.h,
          );
          const boxTop = cursorManualTop ?? autoTop;
          const boxLeft = Math.min(dims.w - READOUT_W, margin.left + cursorInfo.sx + 8);
          return (
            <div style={{
              position: "absolute", top: boxTop, left: boxLeft,
              padding: 6, background: pt.overlayBg, border: `1px solid ${cursorInfo.color}`,
              borderRadius: 4, fontSize: 10, pointerEvents: "none", minWidth: 96,
            }}>
              <div
                onPointerDown={(e) => {
                  if (!isDragPointer(e)) return;
                  e.preventDefault(); e.stopPropagation();
                  const startY = e.clientY, origTop = boxTop;
                  trackPointerDrag(e, (ev) => setCursorManualTop(origTop + ev.clientY - startY));
                }}
                style={{ ...DRAG_TOUCH_ACTION, position: "absolute", top: 2, right: 4, cursor: "ns-resize", fontSize: 11,
                  color: "#64748b", lineHeight: 1, userSelect: "none", pointerEvents: "auto" }}
                title="Vertikal verschieben"
              >⠿</div>
              <div style={{ color: cursorInfo.color, fontFamily: "monospace", marginBottom: 2, paddingRight: 14 }}>{displayVar(cursor!.trace)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>x</span>
                <span style={{ color: pt.text, fontFamily: "monospace" }}>{fmtX(cursorInfo.sampleT)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>y</span>
                <span style={{ color: pt.text, fontFamily: "monospace" }}>{fmtVal(cursorInfo.value)}</span>
              </div>
            </div>
          );
        })()}
        {/* Stamp readout boxes – HTML divs at their computed top positions. */}
        {stampInfos.map((s) => isFinite(s.sx) ? (() => {
          const sTop = s.top;
          const sLeft = s.left ?? Math.min(dims.w - READOUT_W, margin.left + s.sx + 8);
          return (
            <div key={`readout-${s.i}`} style={{
              position: "absolute", top: sTop, left: sLeft,
              padding: 6, background: pt.overlayBg,
              border: `1px solid ${s.color}`,
              borderRadius: 4, fontSize: 10, pointerEvents: "none", minWidth: 96, opacity: 0.9,
            }}>
              <div
                onPointerDown={(e) => startDragReadout(e, sTop, sLeft,
                  (top, left) => setStamps((prev) => prev.map((st, j) =>
                    j === s.i ? { ...st, top, left } : st)))}
                style={{ ...DRAG_TOUCH_ACTION, position: "absolute", top: 2, right: 4, cursor: "move", fontSize: 11,
                  color: "#64748b", lineHeight: 1, userSelect: "none", pointerEvents: "auto" }}
                title="Verschieben"
              >⠿</div>
              <div style={{ color: s.color, fontFamily: "monospace", marginBottom: 2, paddingRight: 14 }}>{displayVar(s.trace)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>x</span>
                <span style={{ color: pt.text, fontFamily: "monospace" }}>{fmtX(s.sampleT)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>y</span>
                <span style={{ color: pt.text, fontFamily: "monospace" }}>{fmtVal(s.value)}</span>
              </div>
            </div>
          );
        })() : null)}
        {/* One × per stamp to remove it individually. */}
        {stampInfos.map((s) => isFinite(s.sx) ? (
          <button
            key={`del-${s.i}`}
            onClick={() => setStamps((list) => list.filter((_, j) => j !== s.i))}
            title="Abdruck entfernen"
            style={{
              position: "absolute",
              top: margin.top + plotH - 14,
              left: Math.min(dims.w - 16, margin.left + s.sx - 6),
              width: 14, height: 14, lineHeight: "12px", padding: 0,
              borderRadius: 3, fontSize: 11, cursor: "pointer",
              background: pt.overlayBg2, color: s.color, border: `1px solid ${s.color}`,
            }}
          >×</button>
        ) : null)}
      </div>

      {/* Probe context menu: toggle the measurement cursor */}
      {menu && (
        <ClampedMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} zIndex={41} backdropZIndex={40} style={menuPopup}>
            <button
              onClick={() => {
                setCursor((c) => c?.trace === menu.trace ? null : { trace: menu.trace, t: (vr.xMin + vr.xMax) / 2 });
                setMenu(null);
              }}
              style={menuItemStyle}
            >
              {cursor?.trace === menu.trace ? "Cursor entfernen" : "Cursor anzeigen"}
            </button>
            <button
              onClick={() => { stampCursor(menu.trace); setMenu(null); }}
              style={menuItemStyle}
              title="Aktuelle Cursorposition dauerhaft auf das Diagramm drucken"
            >
              Position abdrucken
            </button>
        </ClampedMenu>
      )}

      {/* Pane context menu (LTSpice-style add/move/delete/sync) */}
      {paneMenu && (
        <ClampedMenu x={paneMenu.x} y={paneMenu.y} onClose={() => setPaneMenu(null)} zIndex={41} backdropZIndex={40} style={{ ...menuPopup, minWidth: 180 }}>
            <button style={menuItemStyle} onClick={() => { onAddRelative("above"); setPaneMenu(null); }}>Add Plot Pane Above</button>
            <button style={menuItemStyle} onClick={() => { onAddRelative("below"); setPaneMenu(null); }}>Add Plot Pane Below</button>
            <button style={{ ...menuItemStyle, color: index > 0 ? (pt.text) : "#475569", cursor: index > 0 ? "pointer" : "default" }} disabled={index === 0} onClick={() => { onMove("up"); setPaneMenu(null); }}>Move Plot Pane Up</button>
            <button style={{ ...menuItemStyle, color: index < count - 1 ? (pt.text) : "#475569", cursor: index < count - 1 ? "pointer" : "default" }} disabled={index === count - 1} onClick={() => { onMove("down"); setPaneMenu(null); }}>Move Plot Pane Down</button>
            <button style={{ ...menuItemStyle, color: canRemove ? "#f87171" : "#475569", cursor: canRemove ? "pointer" : "default" }} disabled={!canRemove} onClick={() => { onRemovePanel(); setPaneMenu(null); }}>Delete this Pane</button>
            <div style={menuDivider} />
            <button style={menuItemStyle} onClick={() => { onToggleSyncX(); setPaneMenu(null); }}>
              {syncX ? "☑" : "☐"} Sync. Horiz. Axes
            </button>
            {cursor && (
              <>
                <div style={menuDivider} />
                <button style={menuItemStyle} onClick={() => { stampCursor(cursor.trace); setPaneMenu(null); }}>Position abdrucken</button>
              </>
            )}
            {stamps.length > 0 && (
              <>
                <div style={menuDivider} />
                <button style={menuItemStyle} onClick={() => { setStamps([]); setCursorManualTop(null); setPaneMenu(null); }}>Alle Abdrücke entfernen</button>
              </>
            )}
            <div style={menuDivider} />
            {panel.height && (
              <button style={menuItemStyle} onClick={() => { onUpdate({ height: undefined }); setPaneMenu(null); }}>Reset height (auto)</button>
            )}
            <div style={menuDivider} />
            <button style={menuItemStyle} onClick={() => { onSavePlt(); setPaneMenu(null); }}>Save Plot Settings (.plt)</button>
            <button style={menuItemStyle} onClick={() => { onLoadPlt(); setPaneMenu(null); }}>Open Plot Settings (.plt)</button>
            <button style={menuItemStyle} onClick={() => { handleExportSvg(); setPaneMenu(null); }}>Export Diagram (.svg)</button>
            {count > 1 && (
              <button style={menuItemStyle} onClick={() => { onExportAll(); setPaneMenu(null); }}>Export All Diagrams (.svg)</button>
            )}
        </ClampedMenu>
      )}

      {/* Resize handle: drag the bottom edge to set this plot's height. The grip
          lines are decoration — the whole strip is the grab area. */}
      <div
        onPointerDown={startResize}
        title="Drag to resize this plot"
        style={{
          ...DRAG_TOUCH_ACTION, height: RESIZE_HANDLE_H, flexShrink: 0, cursor: "ns-resize",
          background: pt.toolbarBg, borderTop: `1px solid ${pt.border}`,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 14, height: 2, borderRadius: 1, background: pt.border }} />
        ))}
      </div>
    </div>
  );
}

/** Round for display so auto axis bounds don't show float noise. */
function round6(n: number): number {
  return isFinite(n) ? Number(n.toPrecision(6)) : n;
}

/* ─────────────────── Axis min/tick/max input group ─────────────────── */

interface AxisFieldsProps {
  title: string;
  /** The bound the user set explicitly; undefined = auto. */
  min?: number;
  max?: number;
  ticks?: number;
  /** What "auto" currently works out to — shown as the placeholder, not as a value. */
  autoMin?: number;
  autoMax?: number;
  minLabel: string;
  maxLabel: string;
  onMin: (v: number | undefined) => void;
  onMax: (v: number | undefined) => void;
  onTicks: (v: number | undefined) => void;
  extra?: React.ReactNode;
}

function AxisFields({ title, min, max, ticks, autoMin, autoMax, minLabel, maxLabel, onMin, onMax, onTicks, extra }: AxisFieldsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: "#64748b", width: 40 }}>{title}</span>
      <AxisInput label={minLabel} value={min} auto={autoMin} onChange={onMin} />
      <AxisInput label="tick" value={ticks} onChange={onTicks} />
      <AxisInput label={maxLabel} value={max} auto={autoMax} onChange={onMax} />
      {extra}
    </div>
  );
}

/**
 * The quantity plotted on the x-axis (LTSpice's "Quantity Plotted" / `Parametric:`).
 * Empty = the sweep base (time for a `.tran`). Anything else turns the panel
 * parametric: both axes are then functions of time and the panel draws the curve
 * they trace out — that is how a transistor characteristic Ic = f(Uce) comes out
 * of an ordinary transient run. Committed on blur / Enter so a half-typed name
 * never reaches the plot.
 */
function XQuantityField({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const pt = usePlotTheme();
  const [text, setText] = useState<string | null>(null);
  const commit = (raw: string) => {
    const v = raw.trim();
    setText(null);
    onChange(v === "" || v.toLowerCase() === "time" ? undefined : v);
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#94a3b8" }}>
      quantity
      <input
        value={text ?? value ?? ""}
        placeholder="time"
        title="x-axis quantity, e.g. Ic(Q1) or V(C) — empty = time (parametric plot)"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setText(null);
        }}
        style={{
          width: 78, fontSize: 10, padding: "1px 4px", background: pt.inputBg,
          color: pt.text, border: `1px solid ${pt.border}`, borderRadius: 3,
        }}
      />
    </label>
  );
}

/**
 * SI-aware axis field: shows the value in engineering notation (e.g. `1.5k`,
 * `10m`) and accepts SI-suffixed input (`1k`, `10meg`, `4.7µ`). No spinner
 * arrows; empty commits `undefined` (auto). A local buffer lets the user type
 * freely; the value is committed on blur / Enter.
 */
function AxisInput({ label, value, auto, onChange }: { label: string; value?: number; auto?: number; onChange: (v: number | undefined) => void }) {
  const pt = usePlotTheme();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === undefined || !isFinite(value) ? "" : siFormat(value));
  // An empty field *is* auto. The field used to be fed the auto-computed bound as
  // its value, so clearing it and pressing Enter looked as if the old number had
  // come back — it was the auto value, identical because the data had not changed.
  // The auto bound belongs in the placeholder, where it reads as "not set".
  const hint = auto === undefined || !isFinite(auto) ? "auto" : `auto: ${siFormat(auto)}`;

  const commit = () => {
    if (text === null) return;
    const t = text.trim();
    setText(null);
    if (t === "") { onChange(undefined); return; }
    const n = parseSpiceNumber(t);
    if (n !== undefined) onChange(n); // invalid input → revert to the shown value
  };

  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: 8, color: "#64748b" }}>
      {label}
      <input
        type="text"
        value={shown}
        placeholder={hint}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } }}
        style={{
          width: 52, padding: "2px 4px", fontSize: 9,
          background: pt.inputBg,
          color: pt.text,
          border: `1px solid ${pt.borderStrong}`, borderRadius: 3,
        }}
      />
    </label>
  );
}
