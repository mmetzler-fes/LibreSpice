import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useSimulationStore, type SimulationResult } from "@store/simulationStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { matchResultVariable, canonicalProbe, dedupeProbes } from "@core/circuit/probeUtils.js";
import { usePlotStore, PLOT_PALETTE, PLOT_PALETTE_LIGHT, type PlotPanel } from "./plotStore.js";
import { evalExpression, resolveSeries } from "./expression.js";
import { inferUnit } from "./units.js";
import { serializePlt, parsePlt, siPrefix, tickStep, type PltDoc, type PltAxis, type PltPane } from "./pltFormat.js";
import { parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";

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
function looksLikeExpression(name: string): boolean {
  return !/^\s*[@A-Za-z_][\w.]*\s*(\([^()]*\))?\s*$/.test(name);
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 56 };
const MARGIN_COMPACT = { top: 8, right: 8, bottom: 28, left: 48 };

/** Approximate dimensions of a cursor / stamp readout box (px). */
const READOUT_H = 72;
const READOUT_W = 130;

/** Clamp a readout box top so it stays within the container. */
function clampTop(top: number, containerH: number): number {
  return Math.max(4, Math.min(containerH - READOUT_H - 4, top));
}

const DND_MIME = "application/x-librespice-trace";

const SI_PREFIXES: { e: number; s: string }[] = [
  { e: 12, s: "T" }, { e: 9, s: "G" }, { e: 6, s: "M" }, { e: 3, s: "k" }, { e: 0, s: "" },
  { e: -3, s: "m" }, { e: -6, s: "µ" }, { e: -9, s: "n" }, { e: -12, s: "p" }, { e: -15, s: "f" },
];

/**
 * Engineering-notation number: scales by a power-of-1000 SI prefix so the
 * mantissa stays in [1, 1000) (e.g. 0.01 → "10m", 10 → "10", 10000 → "10k"),
 * with up to 4 significant digits and trailing zeros trimmed. No prefix is used
 * when the value is already in a readable range.
 */
function siFormat(v: number): string {
  if (!isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a < 1e-15 || a >= 1e15) return v.toExponential(2);
  const group = Math.max(-15, Math.min(12, Math.floor(Math.log10(a) / 3) * 3));
  const scaled = Number((v / 10 ** group).toPrecision(4));
  const prefix = SI_PREFIXES.find((p) => p.e === group)?.s ?? "";
  return `${scaled}${prefix}`;
}

function fmtTime(t: number): string {
  const s = siFormat(t);
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

function fmtVal(v: number, unit = ""): string {
  const s = siFormat(v);
  return s === "—" ? s : `${s}${unit}`;
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
function ticksFor(min: number, max: number, step: number | undefined, autoCount: number): number[] {
  if (step && isFinite(step) && step > 0 && max > min) {
    const ticks: number[] = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-6; v += step) {
      ticks.push(v);
      if (ticks.length > 500) break; // guard against a tiny step
    }
    return ticks;
  }
  return niceTicks(min, max, autoCount);
}

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

interface ViewRange { xMin: number; xMax: number; yMin: number; yMax: number }

/** A set of traces sharing one unit, with its own fitted y-range. */
interface UnitGroup { unit: string; traces: string[]; yMin: number; yMax: number }

/** Strip a `.step` tag suffix (" @Cvar=1m") to recover the base trace name. */
function stripStepTag(name: string): string {
  const i = name.lastIndexOf(" @");
  return i >= 0 ? name.slice(0, i) : name;
}

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
function applyYOverrides(groups: UnitGroup[], panel: PlotPanel): AxisGroup[] {
  return groups.map((g, gi) => {
    const o = panel.yAxes?.[g.unit] ?? (gi === 0 ? { min: panel.yMin, max: panel.yMax, ticks: panel.yTicks } : {});
    return { ...g, yMin: o.min ?? g.yMin, yMax: o.max ?? g.yMax, ticks: o.ticks };
  });
}

interface OscilloscopePlotProps {
  compact?: boolean;
}

export function OscilloscopePlot({ compact = false }: OscilloscopePlotProps) {
  const { result, selectedVariables, toggleVariable, setSelectedVariables } = useSimulationStore();
  const { autoProbeCurrent, toggleAutoProbeCurrent } = useUIStore();
  const analysisType = useCircuitStore((s) => s.simulationConfig.type);
  const circuitName = useCircuitStore((s) => s.circuitName);
  // Handle of the currently open .asc, used to start file dialogs in its folder.
  const fileHandle = useCircuitStore((s) => s.fileHandle);
  const {
    panels, traceToPanel, colors, expressions, syncX, svgLight,
    addPanelRelative, movePanel, removePanel, setTracePanel, updatePanel, fitPanel, setColor,
    addExpression, removeExpression, toggleSyncX, importSettings,
  } = usePlotStore();
  const isDark = !svgLight;
  // Active palette: bright for dark backgrounds, deep for light backgrounds.
  const palette = isDark ? PLOT_PALETTE : PLOT_PALETTE_LIGHT;

  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [exprInput, setExprInput] = useState("");
  const [exprError, setExprError] = useState<string | null>(null);

  const stepTags = result?.step?.values ?? null;

  // Every trace we can draw: selected raw probes + arithmetic expressions. For a
  // .step sweep, expressions expand to one trace per parameter value so a
  // function like V(a)-V(b) is drawn for every step.
  const allTraces = useMemo(() => {
    const exprTraces = stepTags ? expressions.flatMap((e) => stepTags.map((t) => `${e} @${t}`)) : expressions;
    return [...new Set([...selectedVariables, ...exprTraces])];
  }, [selectedVariables, expressions, stepTags]);

  // Resolve each trace to a data series (raw variable or evaluated expression).
  const seriesMap = useMemo(() => {
    const map: Record<string, Float64Array | null> = {};
    const errors: Record<string, string> = {};
    if (result) {
      // A single-step data view (base variable names) for per-step expressions.
      const stepView = (tag: string): SimulationResult => {
        const suffix = ` @${tag}`;
        const data: Record<string, Float64Array> = {};
        for (const k of Object.keys(result.data)) if (k.endsWith(suffix)) data[k.slice(0, -suffix.length)] = result.data[k];
        return { variables: Object.keys(data), data, time: result.time };
      };
      for (const trace of allTraces) {
        if (result.data[trace]) { map[trace] = result.data[trace]; continue; }
        const at = trace.lastIndexOf(" @");
        const tag = at >= 0 && stepTags?.includes(trace.slice(at + 2)) ? trace.slice(at + 2) : null;
        const base = tag ? trace.slice(0, at) : trace;
        if (expressions.includes(base)) {
          const r = evalExpression(tag ? stepView(tag) : result, base);
          map[trace] = r.values ?? null;
          if (r.error) errors[base] = r.error;
        } else {
          map[trace] = resolveSeries(result, trace);
        }
      }
    }
    return { map, errors };
  }, [result, allTraces, expressions, stepTags]);

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
    setExpandedGroups((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
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
    if (result) {
      const r = evalExpression(result, expr);
      if (r.error) { setExprError(r.error); return; }
    }
    addExpression(expr);
    setExprInput("");
    setExprError(null);
  };

  // `step` is the grid spacing (our tick model); fall back to ~5 divisions.
  const axisFrom = (low: number, high: number, step?: number): PltAxis =>
    ({ prefix: siPrefix(Math.max(Math.abs(low), Math.abs(high))), low, tick: step && step > 0 ? step : (high - low) / 5, high });

  // Save the plot configuration as an LTSpice-compatible `.plt` file, defaulting
  // to the current .asc's folder and base name.
  const handleSavePlt = async () => {
    const time = result!.time!;
    const doc: PltDoc = {
      analysis: ANALYSIS_LABEL[analysisType] ?? "Transient Analysis",
      panes: panels.map((panel): PltPane => {
        const traces = allTraces.filter((t) => panelForTrace(t) === panel.id);
        const groups = applyYOverrides(groupByUnit(traces, seriesMap.map), panel);
        const y = groups.map((g) => axisFrom(g.yMin, g.yMax, g.ticks ?? panel.yTicks));
        if (y.length === 0) y.push(axisFrom(panel.yMin ?? -1, panel.yMax ?? 1, panel.yTicks));
        const x = axisFrom(panel.xMin ?? time[0], panel.xMax ?? time[time.length - 1], panel.xTicks);
        return { traces, x, y, log: [!!panel.logX, false, false] };
      }),
    };
    const content = serializePlt(doc);
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

  // Parse a `.plt` document's text, rebuild the panels and re-plot the data.
  const applyPltText = useCallback((text: string) => {
    const doc = parsePlt(text);
    if (!doc) { alert("Invalid .plt file"); return; }

    // Resolve raw probe names to the actual result variable when possible.
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
      newPanels.push({
        id,
        xMin: pane.x.low, xMax: pane.x.high, xTicks: tickStep(pane.x), logX: pane.log[0],
        yMin: pane.y[0]?.low, yMax: pane.y[0]?.high, yTicks: tickStep(pane.y[0]),
        yAxes,
      });
      for (const t of pane.traces) {
        const name = resolveName(t);
        tracePanel[name] = id;
        if (looksLikeExpression(name)) exprs.add(name); else raw.add(name);
      }
    });

    importSettings({ version: 1, panels: newPanels, traceToPanel: tracePanel, colors: {}, expressions: [...exprs], syncX: false });
    // Make the referenced probes active so the traces are re-plotted.
    setSelectedVariables([...raw]);
  }, [result, importSettings, setSelectedVariables]);

  // Load an LTSpice `.plt` file, starting the picker in the current .asc's folder.
  const handleLoadPlt = async () => {
    if ("showOpenFilePicker" in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          startIn: fileHandle ?? undefined,
          types: [{ description: "LTSpice Plot Settings", accept: { "text/plain": [".plt"], "application/octet-stream": [".plt"] } }],
          multiple: false,
        });
        applyPltText(await (await handle.getFile()).text());
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
      if (file) applyPltText(await file.text());
    };
    input.click();
  };

  // No result, or a result without a usable time base (e.g. failed run, `.op`).
  if (!result || !result.time || result.time.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#64748b", background: isDark ? "#0f172a" : "#f8fafc" }}>
        <p style={{ margin: 0, fontSize: compact ? 12 : 14 }}>No simulation data</p>
        <p style={{ margin: 0, fontSize: 11, color: "#475569" }}>Run simulation — double-click a component to probe</p>
      </div>
    );
  }

  const sidebarW = compact ? 150 : 210;

  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden", background: isDark ? "#0f172a" : "#f8fafc" }}>
      {/* ── Sidebar: probes, colours, expressions ── */}
      <div style={{
        width: sidebarW, flexShrink: 0, borderRight: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}`,
        background: isDark ? undefined : "#fff",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: compact ? "6px 8px" : "10px 12px", borderBottom: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}`, background: isDark ? undefined : "#fff" }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: isDark ? "#64748b" : "#475569", textTransform: "uppercase" }}>Probes</span>
          <label
            title="Add a component's current to the probes when you click it in the schematic"
            style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer", color: isDark ? "#94a3b8" : "#64748b", fontSize: 10 }}
          >
            <input type="checkbox" checked={autoProbeCurrent} onChange={toggleAutoProbeCurrent} style={{ cursor: "pointer" }} />
            Current on click
          </label>
        </div>

        <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 2, flex: 1, overflow: "auto" }}>
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

          {expressions.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 9, fontWeight: 600, color: isDark ? "#64748b" : "#94a3b8", textTransform: "uppercase", padding: "2px 6px" }}>
              Functions
            </div>
          )}
          {expressions.map((expr) => (
            <ProbeRow
              key={expr}
              label={expr}
              color={colorFor(expr)}
              active
              draggable
              error={seriesMap.errors[expr]}
              onToggle={() => removeExpression(expr)}
              onDragStart={(e) => e.dataTransfer.setData(DND_MIME, expr)}
              onSwatch={() => setColorPickerFor(colorPickerFor === expr ? null : expr)}
              showPicker={colorPickerFor === expr}
              onPick={(c) => { setColor(expr, c); setColorPickerFor(null); }}
              onRemove={() => removeExpression(expr)}
            />
          ))}
        </div>

        {/* Expression builder (requirement: arithmetic on probe variables) */}
        <div style={{ padding: 6, borderTop: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}`, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: isDark ? "#64748b" : "#94a3b8", textTransform: "uppercase" }}>Add function</div>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              value={exprInput}
              onChange={(e) => { setExprInput(e.target.value); setExprError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddExpression(); }}
              placeholder="V(a)-V(b)"
              style={{
                flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 10, fontFamily: "monospace",
                background: isDark ? "#0b1120" : "#fff",
                color: isDark ? "#e2e8f0" : "#1e293b",
                border: `1px solid ${isDark ? "#334155" : "#cbd5e1"}`,
                borderRadius: 4,
              }}
            />
            <button
              onClick={handleAddExpression}
              style={{ padding: "3px 8px", fontSize: 10, background: isDark ? "#1e293b" : "#e2e8f0", color: isDark ? "#94a3b8" : "#475569", border: `1px solid ${isDark ? "#334155" : "#cbd5e1"}`, borderRadius: 4, cursor: "pointer" }}
            >
              +
            </button>
          </div>
          {exprError && <div style={{ fontSize: 9, color: "#f87171" }}>{exprError}</div>}
        </div>
      </div>

      {/* ── Panels (stacked; add/move/delete via right-click menu, drag targets) ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
        {panels.map((panel, i) => {
          const traces = allTraces.filter((t) => panelForTrace(t) === panel.id);
          return (
            <PlotPanelView
              key={panel.id}
              panel={panel}
              traces={traces}
              seriesMap={seriesMap.map}
              time={result.time!}
              xLabel={result.xLabel}
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
            />
          );
        })}
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
}

function ProbeRow({ label, color, active, draggable, error, onToggle, onDragStart, onSwatch, showPicker, onPick, onRemove }: ProbeRowProps) {
  const svgLight = usePlotStore((s) => s.svgLight);
  const isDark = !svgLight;
  const palette = isDark ? PLOT_PALETTE : PLOT_PALETTE_LIGHT;
  return (
    <div style={{ position: "relative" }}>
      <div
        draggable={draggable}
        onDragStart={onDragStart}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 6px", borderRadius: 4,
          background: active ? (isDark ? "#1e293b" : "#e2e8f0") : "transparent",
          cursor: draggable ? "grab" : "pointer",
        }}
        title={draggable ? "Drag into a panel" : undefined}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onSwatch(); }}
          title="Change colour"
          style={{
            width: 12, height: 12, borderRadius: 3, flexShrink: 0, padding: 0,
            border: "1px solid #00000040", cursor: "pointer",
            background: active ? color : (isDark ? "#334155" : "#94a3b8"),
          }}
        />
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
        {onRemove && (
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
          background: isDark ? "#1e293b" : "#fff",
          border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
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
  /** When set, the x-axis is a swept parameter (not time) — used for labels. */
  xLabel?: string;
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
}

/** Diagram colours for the on-screen (dark) and print/beamer (light) looks. */
const PLOT_THEME = {
  dark:  { bg: "#0f172a", plot: "#0b1120", grid: "#1e293b", axis: "#475569", line: "#334155", dot: "#0f172a", frame: "#334155" },
  light: { bg: "#ffffff", plot: "#ffffff", grid: "#e2e8f0", axis: "#475569", line: "#94a3b8", dot: "#ffffff", frame: "#cbd5e1" },
};

function PlotPanelView(props: PlotPanelViewProps) {
  const { panel, traces, seriesMap, time, xLabel, colorFor, compact, index, count, syncX,
    onDropTrace, onRemoveTrace, onAddRelative, onMove, onRemovePanel, onFit, onToggleSyncX, onSavePlt, onLoadPlt, onUpdate } = props;
  const margin = compact ? MARGIN_COMPACT : MARGIN;
  // The x-axis is time by default; for a parameter sweep (`.op` + `.step`) it is
  // the swept param, so format the ticks as a plain SI value instead of seconds.
  const fmtX = (t: number) => (xLabel ? fmtVal(t) : fmtTime(t));
  const canRemove = count > 1;
  const circuitName = useCircuitStore((s) => s.circuitName);
  const svgLight = usePlotStore((s) => s.svgLight);
  const toggleSvgLight = usePlotStore((s) => s.toggleSvgLight);
  const isDark = !svgLight;
  const th = svgLight ? PLOT_THEME.light : PLOT_THEME.dark;

  // Serialise this panel's SVG to a downloadable standalone file.
  const handleExportSvg = () => {
    const svg = document.getElementById(`osc-svg-${panel.id}`);
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
    downloadText(xml, `${(circuitName.trim() || "plot")}_Diagramm.svg`, "image/svg+xml");
  };

  /** Merge a manual override into one unit's y-axis. */
  const setYAxis = (unit: string, patch: { min?: number; max?: number; ticks?: number }) =>
    onUpdate({ yAxes: { ...panel.yAxes, [unit]: { ...panel.yAxes?.[unit], ...patch } } });

  const ctrlBtnStyle: React.CSSProperties = {
    padding: "2px 8px", fontSize: 10,
    background: isDark ? "#1e293b" : "#f1f5f9",
    color: isDark ? "#94a3b8" : "#475569",
    border: `1px solid ${isDark ? "#334155" : "#cbd5e1"}`,
    borderRadius: 4, cursor: "pointer", flexShrink: 0,
  };
  const menuItemStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "4px 10px", textAlign: "left",
    border: "none", background: "transparent",
    color: isDark ? "#e2e8f0" : "#1e293b",
    cursor: "pointer", fontSize: 11, borderRadius: 4, whiteSpace: "nowrap",
  };
  const menuDivider = { height: 1, background: isDark ? "#334155" : "#e2e8f0", margin: "4px 0" };
  const menuPopup: React.CSSProperties = {
    position: "fixed", zIndex: 41,
    background: isDark ? "#1e293b" : "#fff",
    border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
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

  // x defaults to the saved-data window (tstart..tstop).
  const vr: ViewRange = {
    xMin: panel.xMin ?? time[0],
    xMax: panel.xMax ?? time[time.length - 1],
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
  const mkToSy = (g: { yMin: number; yMax: number }) =>
    (v: number): number => plotH - ((v - g.yMin) / (g.yMax - g.yMin)) * plotH;
  const toSy = mkToSy(y0); // left axis
  const groupOf = (t: string) => yGroups.find((g) => g.traces.includes(t)) ?? y0;

  const buildPath = (data: Float64Array, sy: (v: number) => number): string => {
    let d = "";
    let first = true;
    for (let i = 0; i < time.length; i++) {
      const x = toSx(time[i]);
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
  const xTicks = logX ? logTicks(xLo, vr.xMax) : ticksFor(vr.xMin, vr.xMax, panel.xTicks, autoXCount);
  const yTicks = ticksFor(y0.yMin, y0.yMax, y0.ticks, autoYCount);

  const nearestIndex = (t: number): number => {
    let lo = 0, hi = time.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (time[mid] < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(time[lo - 1] - t) < Math.abs(time[lo] - t)) return lo - 1;
    return lo;
  };

  // Snap the cursor to the nearest sample and read its x/y.
  const cursorInfo = cursor
    ? (() => {
        const idx = nearestIndex(cursor.t);
        const sampleT = time[idx];
        const value = seriesMap[cursor.trace]?.[idx] ?? NaN;
        const sy = mkToSy(groupOf(cursor.trace))(value);
        return { idx, sampleT, value, sx: toSx(sampleT), sy, color: colorFor(cursor.trace) };
      })()
    : null;

  // Screen positions for each stamp (snapped to the nearest sample).
  const stampInfos = stamps.map((st, i) => {
    const idx = nearestIndex(st.t);
    const sampleT = time[idx];
    const value = seriesMap[st.trace]?.[idx] ?? NaN;
    return { i, trace: st.trace, sampleT, value, sx: toSx(sampleT), sy: mkToSy(groupOf(st.trace))(value), color: colorFor(st.trace), top: st.top, left: st.left };
  });

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

  /** Start dragging a readout box. Calls `onUpdate(newTop, newLeft)` on every mousemove. */
  const startDragReadout = (
    e: React.MouseEvent,
    currentTop: number,
    currentLeft: number,
    onUpdate: (top: number, left: number) => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const move = (ev: MouseEvent) =>
      onUpdate(currentTop + ev.clientY - startY, currentLeft + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag the cursor horizontally (this is the only mouse interaction; axis
  // range is set exclusively through the settings menu).
  const startCursorDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const px = ev.clientX - rect.left - margin.left;
      const frac = Math.max(0, Math.min(1, px / plotW));
      const t = logX ? 10 ** (lxMin + frac * (lxMax - lxMin)) : vr.xMin + frac * (vr.xMax - vr.xMin);
      setCursor((c) => (c ? { ...c, t } : c));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag the bottom edge to set this panel's height (independent of the others).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = panelRef.current?.getBoundingClientRect().height ?? dims.h;
    const move = (ev: MouseEvent) => onUpdate({ height: Math.max(120, startH + (ev.clientY - startY)) });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      ref={panelRef}
      style={{
        flex: panel.height ? "0 0 auto" : "1 0 auto",
        height: panel.height, minHeight: compact ? 150 : 200, display: "flex", flexDirection: "column",
        borderBottom: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}`,
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
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: isDark ? "#0b1120" : "#f1f5f9", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {traces.length === 0 && (
            <span style={{ fontSize: 10, color: isDark ? "#475569" : "#94a3b8" }}>Drag a probe here…</span>
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
                  ? (isDark ? "#334155" : "#cbd5e1")
                  : (isDark ? "#1e293b" : "#e2e8f0"),
                fontSize: 10, fontFamily: "monospace", color: colorFor(t), cursor: "grab",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 4, background: colorFor(t) }} />
              {displayVar(t)}
              <button
                onClick={() => onRemoveTrace(t)}
                title="Remove from panel"
                style={{ border: "none", background: "transparent", color: isDark ? "#64748b" : "#94a3b8", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
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
        <div style={{ display: "flex", gap: 16, padding: "4px 8px", background: isDark ? "#0b1120" : "#f1f5f9", borderTop: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}`, flexWrap: "wrap" }}>
          <AxisFields
            title="x-axis"
            min={panel.xMin ?? round6(vr.xMin)} max={panel.xMax ?? round6(vr.xMax)} ticks={panel.xTicks}
            minLabel="left" maxLabel="right"
            onMin={(v) => onUpdate({ xMin: v })}
            onMax={(v) => onUpdate({ xMax: v })}
            onTicks={(v) => onUpdate({ xTicks: v })}
            extra={
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#94a3b8" }}>
                <input type="checkbox" checked={logX} onChange={(e) => onUpdate({ logX: e.target.checked })} />
                log
              </label>
            }
          />
          {(yGroups.length > 0 ? yGroups : [y0]).map((g) => (
            <AxisFields
              key={g.unit || "y"}
              title={g.unit ? `y (${g.unit})` : "y-axis"}
              min={round6(g.yMin)} max={round6(g.yMax)} ticks={g.ticks}
              minLabel="bottom" maxLabel="top"
              onMin={(v) => setYAxis(g.unit, { min: v })}
              onMax={(v) => setYAxis(g.unit, { max: v })}
              onTicks={(v) => setYAxis(g.unit, { ticks: v })}
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
            {xTicks.map((t) => (
              <g key={t}>
                <line x1={toSx(t)} y1={0} x2={toSx(t)} y2={plotH} stroke={th.grid} strokeWidth={1} />
                <text x={toSx(t)} y={plotH + 14} textAnchor="middle" fontSize={9} fill={th.axis}>{fmtX(t)}</text>
              </g>
            ))}
            {xLabel && (
              <text x={plotW / 2} y={plotH + 26} textAnchor="middle" fontSize={9} fontWeight={600} fill={th.axis}>{xLabel}</text>
            )}
            {/* Left y-axis (first unit group) with horizontal grid */}
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={0} y1={toSy(v)} x2={plotW} y2={toSy(v)} stroke={th.grid} strokeWidth={1} />
                <text x={-4} y={toSy(v) + 3} textAnchor="end" fontSize={9}
                  fill={yGroups.length > 1 ? colorFor(y0.traces[0]) : th.axis}>{fmtVal(v)}</text>
              </g>
            ))}
            {y0.unit && yGroups.length > 1 && (
              <text x={-4} y={-4} textAnchor="end" fontSize={9} fill={colorFor(y0.traces[0])}>{y0.unit}</text>
            )}
            {vr.yMin < 0 && vr.yMax > 0 && (
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
                  {ticksFor(g.yMin, g.yMax, g.ticks, autoYCount).map((v) => (
                    <g key={v}>
                      <line x1={xLine} y1={sy(v)} x2={xLine + 3} y2={sy(v)} stroke={col} strokeWidth={1} />
                      <text x={xLine + 5} y={sy(v) + 3} textAnchor="start" fontSize={9} fill={col}>{fmtVal(v)}</text>
                    </g>
                  ))}
                  {g.unit && <text x={xLine + 5} y={-4} textAnchor="start" fontSize={9} fill={col}>{g.unit}</text>}
                </g>
              );
            })}

            <g clipPath={`url(#osc-clip-${panel.id})`}>
              {traces.map((t) => {
                const d = seriesMap[t];
                return d ? <path key={t} d={buildPath(d, mkToSy(groupOf(t)))} stroke={colorFor(t)} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" /> : null;
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
                <rect x={cursorInfo.sx - 5} y={0} width={10} height={plotH} fill="transparent" style={{ cursor: "ew-resize" }} onMouseDown={startCursorDrag} />
                <rect x={cursorInfo.sx - 4} y={2} width={8} height={9} rx={2} fill={cursorInfo.color} style={{ cursor: "ew-resize" }} onMouseDown={startCursorDrag} />
              </g>
            )}
            <rect x={0} y={0} width={plotW} height={plotH} fill="none" stroke={th.frame} strokeWidth={1} />
          </g>
        </svg>
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
              padding: 6, background: isDark ? "#1e293be6" : "#ffffffee", border: `1px solid ${cursorInfo.color}`,
              borderRadius: 4, fontSize: 10, pointerEvents: "none", minWidth: 96,
            }}>
              <div
                onMouseDown={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  const startY = e.clientY, origTop = boxTop;
                  const move = (ev: MouseEvent) => setCursorManualTop(origTop + ev.clientY - startY);
                  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
                  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
                }}
                style={{ position: "absolute", top: 2, right: 4, cursor: "ns-resize", fontSize: 11,
                  color: "#64748b", lineHeight: 1, userSelect: "none", pointerEvents: "auto" }}
                title="Vertikal verschieben"
              >⠿</div>
              <div style={{ color: cursorInfo.color, fontFamily: "monospace", marginBottom: 2, paddingRight: 14 }}>{displayVar(cursor!.trace)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>x</span>
                <span style={{ color: isDark ? "#e2e8f0" : "#1e293b", fontFamily: "monospace" }}>{fmtX(cursorInfo.sampleT)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>y</span>
                <span style={{ color: isDark ? "#e2e8f0" : "#1e293b", fontFamily: "monospace" }}>{fmtVal(cursorInfo.value)}</span>
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
              padding: 6, background: isDark ? "#1e293be6" : "#ffffffee",
              border: `1px solid ${s.color}`,
              borderRadius: 4, fontSize: 10, pointerEvents: "none", minWidth: 96, opacity: 0.9,
            }}>
              <div
                onMouseDown={(e) => startDragReadout(e, sTop, sLeft,
                  (top, left) => setStamps((prev) => prev.map((st, j) =>
                    j === s.i ? { ...st, top, left } : st)))}
                style={{ position: "absolute", top: 2, right: 4, cursor: "move", fontSize: 11,
                  color: "#64748b", lineHeight: 1, userSelect: "none", pointerEvents: "auto" }}
                title="Verschieben"
              >⠿</div>
              <div style={{ color: s.color, fontFamily: "monospace", marginBottom: 2, paddingRight: 14 }}>{displayVar(s.trace)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>x</span>
                <span style={{ color: isDark ? "#e2e8f0" : "#1e293b", fontFamily: "monospace" }}>{fmtX(s.sampleT)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "#64748b" }}>y</span>
                <span style={{ color: isDark ? "#e2e8f0" : "#1e293b", fontFamily: "monospace" }}>{fmtVal(s.value)}</span>
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
              background: isDark ? "#0f172acc" : "#ffffffdd", color: s.color, border: `1px solid ${s.color}`,
            }}
          >×</button>
        ) : null)}
      </div>

      {/* Probe context menu: toggle the measurement cursor */}
      {menu && (
        <>
          <div
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div style={{
            position: "fixed", left: menu.x, top: menu.y, zIndex: 41,
            ...menuPopup,
          }}>
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
          </div>
        </>
      )}

      {/* Pane context menu (LTSpice-style add/move/delete/sync) */}
      {paneMenu && (
        <>
          <div
            onClick={() => setPaneMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setPaneMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div style={{
            position: "fixed", left: paneMenu.x, top: paneMenu.y, zIndex: 41,
            ...menuPopup, minWidth: 180,
          }}>
            <button style={menuItemStyle} onClick={() => { onAddRelative("above"); setPaneMenu(null); }}>Add Plot Pane Above</button>
            <button style={menuItemStyle} onClick={() => { onAddRelative("below"); setPaneMenu(null); }}>Add Plot Pane Below</button>
            <button style={{ ...menuItemStyle, color: index > 0 ? (isDark ? "#e2e8f0" : "#1e293b") : "#475569", cursor: index > 0 ? "pointer" : "default" }} disabled={index === 0} onClick={() => { onMove("up"); setPaneMenu(null); }}>Move Plot Pane Up</button>
            <button style={{ ...menuItemStyle, color: index < count - 1 ? (isDark ? "#e2e8f0" : "#1e293b") : "#475569", cursor: index < count - 1 ? "pointer" : "default" }} disabled={index === count - 1} onClick={() => { onMove("down"); setPaneMenu(null); }}>Move Plot Pane Down</button>
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
          </div>
        </>
      )}

      {/* Resize handle: drag the bottom edge to set this plot's height */}
      <div
        onMouseDown={startResize}
        title="Drag to resize this plot"
        style={{ height: 7, flexShrink: 0, cursor: "ns-resize", background: isDark ? "#0b1120" : "#f1f5f9", borderTop: `1px solid ${isDark ? "#1e293b" : "#e2e8f0"}` }}
      />
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
  min?: number;
  max?: number;
  ticks?: number;
  minLabel: string;
  maxLabel: string;
  onMin: (v: number | undefined) => void;
  onMax: (v: number | undefined) => void;
  onTicks: (v: number | undefined) => void;
  extra?: React.ReactNode;
}

function AxisFields({ title, min, max, ticks, minLabel, maxLabel, onMin, onMax, onTicks, extra }: AxisFieldsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: "#64748b", width: 40 }}>{title}</span>
      <AxisInput label={minLabel} value={min} onChange={onMin} />
      <AxisInput label="tick" value={ticks} onChange={onTicks} />
      <AxisInput label={maxLabel} value={max} onChange={onMax} />
      {extra}
    </div>
  );
}

/**
 * SI-aware axis field: shows the value in engineering notation (e.g. `1.5k`,
 * `10m`) and accepts SI-suffixed input (`1k`, `10meg`, `4.7µ`). No spinner
 * arrows; empty commits `undefined` (auto). A local buffer lets the user type
 * freely; the value is committed on blur / Enter.
 */
function AxisInput({ label, value, onChange }: { label: string; value?: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === undefined || !isFinite(value) ? "" : siFormat(value));

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
        placeholder="auto"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } }}
        style={{ width: 52, padding: "2px 4px", fontSize: 9, background: "#0b1120", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 3 }}
      />
    </label>
  );
}
