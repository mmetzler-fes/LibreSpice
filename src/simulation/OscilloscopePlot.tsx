import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useSimulationStore } from "@store/simulationStore.js";
import { useUIStore } from "@store/uiStore.js";
import { usePlotStore, PLOT_PALETTE, type PlotPanel } from "./plotStore.js";
import { evalExpression, resolveSeries } from "./expression.js";

const MARGIN = { top: 16, right: 16, bottom: 36, left: 56 };
const MARGIN_COMPACT = { top: 8, right: 8, bottom: 28, left: 48 };

const DND_MIME = "application/x-librespice-trace";

function fmtTime(t: number): string {
  if (t === 0) return "0";
  const a = Math.abs(t);
  if (a >= 1) return `${t.toFixed(3)}s`;
  if (a >= 1e-3) return `${(t * 1e3).toFixed(3)}ms`;
  if (a >= 1e-6) return `${(t * 1e6).toFixed(3)}µs`;
  if (a >= 1e-9) return `${(t * 1e9).toFixed(3)}ns`;
  return `${t.toExponential(2)}s`;
}

/** Pretty-print ngspice vector names: `@r1[i]` → `I(R1)`, `@r1[p]` → `P(R1)`. */
function displayVar(name: string): string {
  const m = name.match(/^@(.+)\[(\w)\]$/i);
  if (!m) return name;
  const fn = m[2].toLowerCase() === "i" ? "I" : m[2].toLowerCase() === "p" ? "P" : m[2].toUpperCase();
  return `${fn}(${m[1].toUpperCase()})`;
}

function fmtVal(v: number, unit = ""): string {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return `0${unit}`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(3)}G${unit}`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(3)}M${unit}`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(3)}k${unit}`;
  if (a >= 1) return `${v.toFixed(5)}${unit}`;
  if (a >= 1e-3) return `${(v * 1e3).toFixed(3)}m${unit}`;
  if (a >= 1e-6) return `${(v * 1e6).toFixed(3)}µ${unit}`;
  if (a >= 1e-9) return `${(v * 1e9).toFixed(3)}n${unit}`;
  return `${v.toExponential(3)}${unit}`;
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

interface OscilloscopePlotProps {
  compact?: boolean;
}

export function OscilloscopePlot({ compact = false }: OscilloscopePlotProps) {
  const { result, selectedVariables, toggleVariable } = useSimulationStore();
  const { autoProbeCurrent, toggleAutoProbeCurrent } = useUIStore();
  const {
    panels, traceToPanel, colors, expressions,
    addPanel, removePanel, setTracePanel, updatePanel, fitPanel, setColor,
    addExpression, removeExpression,
  } = usePlotStore();

  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [exprInput, setExprInput] = useState("");
  const [exprError, setExprError] = useState<string | null>(null);

  // Every trace we can draw: selected raw probes + persisted arithmetic traces.
  const allTraces = useMemo(
    () => [...new Set([...selectedVariables, ...expressions])],
    [selectedVariables, expressions],
  );

  // Resolve each trace to a data series (raw variable or evaluated expression).
  const seriesMap = useMemo(() => {
    const map: Record<string, Float64Array | null> = {};
    const errors: Record<string, string> = {};
    if (result) {
      for (const trace of allTraces) {
        if (expressions.includes(trace)) {
          const r = evalExpression(result, trace);
          map[trace] = r.values ?? null;
          if (r.error) errors[trace] = r.error;
        } else {
          map[trace] = resolveSeries(result, trace);
        }
      }
    }
    return { map, errors };
  }, [result, allTraces, expressions]);

  // Stable default colour per trace; explicit overrides win.
  const colorFor = useCallback(
    (trace: string): string => {
      if (colors[trace]) return colors[trace];
      const rawIdx = result?.variables.indexOf(trace) ?? -1;
      const idx = rawIdx >= 0
        ? rawIdx
        : (result?.variables.length ?? 0) + Math.max(0, expressions.indexOf(trace));
      return PLOT_PALETTE[idx % PLOT_PALETTE.length];
    },
    [colors, result, expressions],
  );

  const panelForTrace = useCallback(
    (trace: string) => traceToPanel[trace] ?? panels[0]?.id,
    [traceToPanel, panels],
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

  if (!result) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#64748b", background: "#0f172a" }}>
        <p style={{ margin: 0, fontSize: compact ? 12 : 14 }}>No simulation data</p>
        <p style={{ margin: 0, fontSize: 11, color: "#475569" }}>Run simulation — double-click a component to probe</p>
      </div>
    );
  }

  const sidebarW = compact ? 150 : 210;

  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden", background: "#0f172a" }}>
      {/* ── Sidebar: probes, colours, expressions ── */}
      <div style={{
        width: sidebarW, flexShrink: 0, borderRight: "1px solid #1e293b",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: compact ? "6px 8px" : "10px 12px", borderBottom: "1px solid #1e293b" }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase" }}>Probes</span>
          <label
            title="Add a component's current to the probes when you click it in the schematic"
            style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer", color: "#94a3b8", fontSize: 10 }}
          >
            <input type="checkbox" checked={autoProbeCurrent} onChange={toggleAutoProbeCurrent} style={{ cursor: "pointer" }} />
            Current on click
          </label>
        </div>

        <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 2, flex: 1, overflow: "auto" }}>
          {result.variables.map((name) => {
            const active = selectedVariables.includes(name);
            const color = colorFor(name);
            return (
              <ProbeRow
                key={name}
                label={displayVar(name)}
                color={color}
                active={active}
                draggable={active}
                onToggle={() => toggleVariable(name)}
                onDragStart={(e) => e.dataTransfer.setData(DND_MIME, name)}
                onSwatch={() => setColorPickerFor(colorPickerFor === name ? null : name)}
                showPicker={colorPickerFor === name}
                onPick={(c) => { setColor(name, c); setColorPickerFor(null); }}
              />
            );
          })}

          {expressions.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 9, fontWeight: 600, color: "#64748b", textTransform: "uppercase", padding: "2px 6px" }}>
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
        <div style={{ padding: 6, borderTop: "1px solid #1e293b", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#64748b", textTransform: "uppercase" }}>Add function</div>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              value={exprInput}
              onChange={(e) => { setExprInput(e.target.value); setExprError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddExpression(); }}
              placeholder="V(a)-V(b)"
              style={{
                flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 10, fontFamily: "monospace",
                background: "#0b1120", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4,
              }}
            />
            <button
              onClick={handleAddExpression}
              style={{ padding: "3px 8px", fontSize: 10, background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 4, cursor: "pointer" }}
            >
              +
            </button>
          </div>
          {exprError && <div style={{ fontSize: 9, color: "#f87171" }}>{exprError}</div>}
        </div>
      </div>

      {/* ── Panels (stacked, add/remove, drag targets) ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
        {panels.map((panel) => {
          const traces = allTraces.filter((t) => panelForTrace(t) === panel.id);
          return (
            <PlotPanelView
              key={panel.id}
              panel={panel}
              traces={traces}
              seriesMap={seriesMap.map}
              time={result.time!}
              colorFor={colorFor}
              compact={compact}
              canRemove={panels.length > 1}
              onDropTrace={(trace) => setTracePanel(trace, panel.id)}
              onRemoveTrace={(trace) =>
                expressions.includes(trace) ? removeExpression(trace) : toggleVariable(trace)}
              onRemovePanel={() => removePanel(panel.id)}
              onFit={() => fitPanel(panel.id)}
              onUpdate={(patch) => updatePanel(panel.id, patch)}
            />
          );
        })}
        <div style={{ padding: 8, flexShrink: 0 }}>
          <button
            onClick={addPanel}
            style={{ width: "100%", padding: "6px 0", background: "#1e293b", color: "#94a3b8", border: "1px dashed #334155", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
          >
            + Add diagram panel
          </button>
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
}

function ProbeRow({ label, color, active, draggable, error, onToggle, onDragStart, onSwatch, showPicker, onPick, onRemove }: ProbeRowProps) {
  return (
    <div style={{ position: "relative" }}>
      <div
        draggable={draggable}
        onDragStart={onDragStart}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 6px", borderRadius: 4,
          background: active ? "#1e293b" : "transparent",
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
            background: active ? color : "#334155",
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
          padding: 6, background: "#1e293b", border: "1px solid #334155", borderRadius: 6,
          boxShadow: "0 4px 12px #00000060",
        }}>
          {PLOT_PALETTE.map((c) => (
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
  colorFor: (trace: string) => string;
  compact: boolean;
  canRemove: boolean;
  onDropTrace: (trace: string) => void;
  onRemoveTrace: (trace: string) => void;
  onRemovePanel: () => void;
  onFit: () => void;
  onUpdate: (patch: Partial<PlotPanel>) => void;
}

function PlotPanelView(props: PlotPanelViewProps) {
  const { panel, traces, seriesMap, time, colorFor, compact, canRemove, onDropTrace, onRemoveTrace, onRemovePanel, onFit, onUpdate } = props;
  const margin = compact ? MARGIN_COMPACT : MARGIN;

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: compact ? 180 : 260 });
  const [cursor, setCursor] = useState<{ px: number; py: number } | null>(null);
  const [showAxis, setShowAxis] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const panStart = useRef<{ px: number; vr: ViewRange } | null>(null);
  const rangeRef = useRef<ViewRange>({ xMin: 0, xMax: 1, yMin: -1, yMax: 1 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const plotW = dims.w - margin.left - margin.right;
  const plotH = dims.h - margin.top - margin.bottom;

  // Auto range from the panel's own traces; explicit axis bounds override it.
  const auto = useMemo<ViewRange>(() => {
    let yMin = Infinity, yMax = -Infinity;
    for (const t of traces) {
      const d = seriesMap[t];
      if (!d) continue;
      for (const v of d) { if (isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; } }
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.12;
    return { xMin: time[0], xMax: time[time.length - 1], yMin: yMin - yPad, yMax: yMax + yPad };
  }, [traces, seriesMap, time]);

  const vr: ViewRange = {
    xMin: panel.xMin ?? auto.xMin,
    xMax: panel.xMax ?? auto.xMax,
    yMin: panel.yMin ?? auto.yMin,
    yMax: panel.yMax ?? auto.yMax,
  };
  rangeRef.current = vr;

  const logX = !!panel.logX;
  const xLo = logX ? Math.max(vr.xMin, 1e-30) : vr.xMin;
  const lxMin = logX ? Math.log10(xLo) : vr.xMin;
  const lxMax = logX ? Math.log10(Math.max(vr.xMax, xLo * 10)) : vr.xMax;

  const toSx = (t: number): number => {
    if (logX) return t <= 0 ? NaN : ((Math.log10(t) - lxMin) / (lxMax - lxMin)) * plotW;
    return ((t - vr.xMin) / (vr.xMax - vr.xMin)) * plotW;
  };
  const toSy = (v: number): number => plotH - ((v - vr.yMin) / (vr.yMax - vr.yMin)) * plotH;

  const buildPath = (data: Float64Array): string => {
    let d = "";
    let first = true;
    for (let i = 0; i < time.length; i++) {
      const x = toSx(time[i]);
      const y = toSy(data[i]);
      if (!isFinite(x) || !isFinite(y)) { first = true; continue; }
      d += first ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
      first = false;
    }
    return d;
  };

  const xTicks = logX
    ? logTicks(xLo, vr.xMax)
    : niceTicks(vr.xMin, vr.xMax, panel.xTicks ?? Math.max(4, Math.floor(plotW / 80)));
  const yTicks = niceTicks(vr.yMin, vr.yMax, panel.yTicks ?? Math.max(3, Math.floor(plotH / 60)));

  // Cursor readout: nearest sample by x.
  const cursorT = cursor
    ? (logX ? 10 ** (lxMin + (cursor.px / plotW) * (lxMax - lxMin)) : vr.xMin + (cursor.px / plotW) * (vr.xMax - vr.xMin))
    : null;
  const cVals = useMemo(() => {
    if (cursorT === null) return [];
    let lo = 0, hi = time.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (time[mid] < cursorT) lo = mid + 1; else hi = mid; }
    return traces.map((t) => ({ name: t, value: seriesMap[t]?.[lo] ?? NaN, color: colorFor(t) }));
  }, [cursorT, time, traces, seriesMap, colorFor]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - margin.left;
    const pxFrac = Math.max(0, Math.min(1, px / plotW));
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const r = rangeRef.current;
    const xMid = r.xMin + pxFrac * (r.xMax - r.xMin);
    const newW = (r.xMax - r.xMin) * factor;
    onUpdate({ xMin: xMid - pxFrac * newW, xMax: xMid + (1 - pxFrac) * newW });
  }, [plotW, margin.left, onUpdate]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsPanning(true);
    panStart.current = { px: e.clientX, vr: { ...rangeRef.current } };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - margin.left;
    const py = e.clientY - rect.top - margin.top;
    setCursor(px >= 0 && px <= plotW && py >= 0 && py <= plotH ? { px, py } : null);
    if (isPanning && panStart.current) {
      const dx = e.clientX - panStart.current.px;
      const xRange = panStart.current.vr.xMax - panStart.current.vr.xMin;
      const shift = -(dx / plotW) * xRange;
      onUpdate({ xMin: panStart.current.vr.xMin + shift, xMax: panStart.current.vr.xMax + shift });
    }
  }, [isPanning, plotW, plotH, margin.left, margin.top, onUpdate]);

  const handleMouseUp = useCallback(() => { setIsPanning(false); panStart.current = null; }, []);

  return (
    <div
      style={{
        flex: "1 0 auto", minHeight: compact ? 150 : 200, display: "flex", flexDirection: "column",
        borderBottom: "1px solid #1e293b",
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
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#0b1120", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {traces.length === 0 && (
            <span style={{ fontSize: 10, color: "#475569" }}>Drag a probe here…</span>
          )}
          {traces.map((t) => (
            <span
              key={t}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DND_MIME, t)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "1px 6px", borderRadius: 10, background: "#1e293b",
                fontSize: 10, fontFamily: "monospace", color: colorFor(t), cursor: "grab",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 4, background: colorFor(t) }} />
              {displayVar(t)}
              <button
                onClick={() => onRemoveTrace(t)}
                title="Remove from panel"
                style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
              >×</button>
            </span>
          ))}
        </div>
        <button onClick={() => setShowAxis((s) => !s)} title="Axis settings" style={ctrlBtn}>⚙</button>
        <button onClick={onFit} title="Fit view" style={ctrlBtn}>Fit</button>
        {canRemove && <button onClick={onRemovePanel} title="Remove panel" style={{ ...ctrlBtn, color: "#f87171" }}>✕</button>}
      </div>

      {/* Axis configuration */}
      {showAxis && (
        <div style={{ display: "flex", gap: 16, padding: "4px 8px", background: "#0b1120", borderTop: "1px solid #1e293b", flexWrap: "wrap" }}>
          <AxisFields
            title="x-axis"
            min={panel.xMin} max={panel.xMax} ticks={panel.xTicks}
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
          <AxisFields
            title="y-axis"
            min={panel.yMin} max={panel.yMax} ticks={panel.yTicks}
            minLabel="bottom" maxLabel="top"
            onMin={(v) => onUpdate({ yMin: v })}
            onMax={(v) => onUpdate({ yMax: v })}
            onTicks={(v) => onUpdate({ yTicks: v })}
          />
        </div>
      )}

      {/* Plot */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: "hidden", cursor: isPanning ? "grabbing" : "crosshair", position: "relative" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setCursor(null); handleMouseUp(); }}
      >
        <svg width={dims.w} height={dims.h} style={{ display: "block" }}>
          <defs>
            <clipPath id={`osc-clip-${panel.id}`}>
              <rect x={0} y={0} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <rect width={dims.w} height={dims.h} fill="#0f172a" />
          <rect x={margin.left} y={margin.top} width={plotW} height={plotH} fill="#0b1120" rx={2} />
          <g transform={`translate(${margin.left},${margin.top})`}>
            {xTicks.map((t) => (
              <g key={t}>
                <line x1={toSx(t)} y1={0} x2={toSx(t)} y2={plotH} stroke="#1e293b" strokeWidth={1} />
                <text x={toSx(t)} y={plotH + 14} textAnchor="middle" fontSize={9} fill="#475569">{fmtTime(t)}</text>
              </g>
            ))}
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={0} y1={toSy(v)} x2={plotW} y2={toSy(v)} stroke="#1e293b" strokeWidth={1} />
                <text x={-4} y={toSy(v) + 3} textAnchor="end" fontSize={9} fill="#475569">{fmtVal(v)}</text>
              </g>
            ))}
            {vr.yMin < 0 && vr.yMax > 0 && (
              <line x1={0} y1={toSy(0)} x2={plotW} y2={toSy(0)} stroke="#334155" strokeWidth={1} strokeDasharray="4 3" />
            )}
            <g clipPath={`url(#osc-clip-${panel.id})`}>
              {traces.map((t) => {
                const d = seriesMap[t];
                return d ? <path key={t} d={buildPath(d)} stroke={colorFor(t)} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" /> : null;
              })}
            </g>
            {cursor && (
              <g style={{ pointerEvents: "none" }}>
                <line x1={cursor.px} y1={0} x2={cursor.px} y2={plotH} stroke="#ffffff30" strokeWidth={1} />
                {cVals.map(({ name, value, color }) => (
                  <circle key={name} cx={cursor.px} cy={toSy(value)} r={3} fill={color} stroke="#0f172a" strokeWidth={1} />
                ))}
              </g>
            )}
            <rect x={0} y={0} width={plotW} height={plotH} fill="none" stroke="#334155" strokeWidth={1} />
          </g>
        </svg>
        {cursor && cVals.length > 0 && cursorT !== null && (
          <div style={{
            position: "absolute", top: 4, right: 4, padding: 6, background: "#1e293bd0",
            border: "1px solid #334155", borderRadius: 4, fontSize: 10, pointerEvents: "none",
          }}>
            <div style={{ color: "#64748b", marginBottom: 2 }}>t = {fmtTime(cursorT)}</div>
            {cVals.map(({ name, value, color }) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color, fontFamily: "monospace" }}>{displayVar(name)}</span>
                <span style={{ color: "#e2e8f0", fontFamily: "monospace" }}>{fmtVal(value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  padding: "2px 8px", fontSize: 10, background: "#1e293b", color: "#94a3b8",
  border: "1px solid #334155", borderRadius: 4, cursor: "pointer", flexShrink: 0,
};

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
  const parse = (s: string): number | undefined => {
    if (s.trim() === "") return undefined;
    const n = parseFloat(s);
    return isFinite(n) ? n : undefined;
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: "#64748b", width: 40 }}>{title}</span>
      <AxisInput label={minLabel} value={min} onChange={(s) => onMin(parse(s))} />
      <AxisInput label="tick" value={ticks} onChange={(s) => onTicks(parse(s))} />
      <AxisInput label={maxLabel} value={max} onChange={(s) => onMax(parse(s))} />
      {extra}
    </div>
  );
}

function AxisInput({ label, value, onChange }: { label: string; value?: number; onChange: (s: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: 8, color: "#64748b" }}>
      {label}
      <input
        type="number"
        value={value ?? ""}
        placeholder="auto"
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 52, padding: "2px 4px", fontSize: 9, background: "#0b1120", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 3 }}
      />
    </label>
  );
}
