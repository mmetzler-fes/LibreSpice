import { useRef, useState, useCallback, useEffect } from "react";
import { useSimulationStore } from "@store/simulationStore.js";

const TRACE_COLORS = [
  "#22d3ee", "#a78bfa", "#34d399", "#fb923c",
  "#f472b6", "#facc15", "#60a5fa", "#f87171",
];

const MARGIN = { top: 24, right: 24, bottom: 48, left: 72 };

/** Format a number with an appropriate SI prefix */
function fmtTime(t: number): string {
  if (t === 0) return "0";
  const a = Math.abs(t);
  if (a >= 1) return `${t.toFixed(3)}s`;
  if (a >= 1e-3) return `${(t * 1e3).toFixed(3)}ms`;
  if (a >= 1e-6) return `${(t * 1e6).toFixed(3)}µs`;
  if (a >= 1e-9) return `${(t * 1e9).toFixed(3)}ns`;
  return `${t.toExponential(2)}s`;
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

/** Nice tick values for an axis range */
function niceTicks(min: number, max: number, count = 6): number[] {
  const range = max - min;
  if (range === 0) return [min];
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

interface ViewRange { xMin: number; xMax: number; yMin: number; yMax: number }

export function OscilloscopeView() {
  const { result, selectedVariables, toggleVariable } = useSimulationStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 480 });
  const [viewRange, setViewRange] = useState<ViewRange | null>(null);
  const [cursor, setCursor] = useState<{ px: number; py: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ px: number; vr: ViewRange } | null>(null);

  // Track container size
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Auto-fit when result changes
  useEffect(() => {
    if (!result?.time || result.time.length === 0) { setViewRange(null); return; }

    const times = result.time;
    let xMin = times[0], xMax = times[times.length - 1];
    let yMin = Infinity, yMax = -Infinity;

    for (const name of result.variables) {
      const d = result.data[name];
      if (!d) continue;
      for (const v of d) {
        if (isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
      }
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.12;
    setViewRange({ xMin, xMax, yMin: yMin - yPad, yMax: yMax + yPad });
  }, [result]);

  const plotW = dims.w - MARGIN.left - MARGIN.right;
  const plotH = dims.h - MARGIN.top - MARGIN.bottom;

  const toSx = useCallback((t: number, vr: ViewRange) =>
    ((t - vr.xMin) / (vr.xMax - vr.xMin)) * plotW, [plotW]);
  const toSy = useCallback((v: number, vr: ViewRange) =>
    plotH - ((v - vr.yMin) / (vr.yMax - vr.yMin)) * plotH, [plotH]);

  // Build SVG paths for each selected variable
  const buildPath = useCallback((varName: string, vr: ViewRange): string => {
    if (!result?.time) return "";
    const times = result.time;
    const data = result.data[varName];
    if (!data) return "";

    let d = "";
    let first = true;
    for (let i = 0; i < times.length; i++) {
      const x = toSx(times[i], vr);
      const y = toSy(data[i], vr);
      if (!isFinite(x) || !isFinite(y)) { first = true; continue; }
      d += first ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
      first = false;
    }
    return d;
  }, [result, toSx, toSy]);

  // Cursor interpolated values
  const cursorValues = useCallback(() => {
    if (!cursor || !result?.time || !viewRange) return [];
    const t = viewRange.xMin + (cursor.px / plotW) * (viewRange.xMax - viewRange.xMin);
    const times = result.time;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return selectedVariables.map((name, i) => ({
      name,
      value: result.data[name]?.[lo] ?? NaN,
      color: TRACE_COLORS[i % TRACE_COLORS.length],
    }));
  }, [cursor, result, viewRange, plotW, selectedVariables]);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (!viewRange) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - MARGIN.left;
    const pxFrac = Math.max(0, Math.min(1, px / plotW));
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const xMid = viewRange.xMin + pxFrac * (viewRange.xMax - viewRange.xMin);
    const newW = (viewRange.xMax - viewRange.xMin) * factor;
    setViewRange((vr) => vr ? {
      ...vr,
      xMin: xMid - pxFrac * newW,
      xMax: xMid + (1 - pxFrac) * newW,
    } : vr);
  }, [viewRange, plotW]);

  // Pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!viewRange) return;
    setIsPanning(true);
    panStart.current = { px: e.clientX, vr: { ...viewRange } };
  }, [viewRange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - MARGIN.left;
    const py = e.clientY - rect.top - MARGIN.top;
    setCursor(px >= 0 && px <= plotW && py >= 0 && py <= plotH ? { px, py } : null);

    if (isPanning && panStart.current && viewRange) {
      const dx = e.clientX - panStart.current.px;
      const xRange = panStart.current.vr.xMax - panStart.current.vr.xMin;
      const shift = -(dx / plotW) * xRange;
      setViewRange({ ...panStart.current.vr, xMin: panStart.current.vr.xMin + shift, xMax: panStart.current.vr.xMax + shift });
    }
  }, [isPanning, viewRange, plotW, plotH]);

  const handleMouseUp = useCallback(() => { setIsPanning(false); panStart.current = null; }, []);

  // Placeholder when no result
  if (!result) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#0f172a" }}>
        <OscHeader />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, color: "#475569" }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 12 L9 8 L11 13 L13 9 L16 12" strokeLinecap="round" />
          </svg>
          <p style={{ margin: 0, fontSize: 14, color: "#475569" }}>Keine Simulationsdaten</p>
          <p style={{ margin: 0, fontSize: 12, color: "#334155" }}>Simulation im Netlist-Tab starten</p>
        </div>
      </div>
    );
  }

  const vr = viewRange ?? { xMin: 0, xMax: 1, yMin: -1, yMax: 1 };
  const xTicks = niceTicks(vr.xMin, vr.xMax, Math.max(4, Math.floor(plotW / 80)));
  const yTicks = niceTicks(vr.yMin, vr.yMax, Math.max(3, Math.floor(plotH / 60)));
  const cVals = cursorValues();

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#0f172a", overflow: "hidden" }}>
      <OscHeader />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Probe selector ── */}
        <div style={{
          width: 200, flexShrink: 0, background: "#0f172a",
          borderRight: "1px solid #1e293b", display: "flex", flexDirection: "column", overflow: "auto",
        }}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid #1e293b" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Probes</span>
          </div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
            {result.variables.map((name, i) => {
              const active = selectedVariables.includes(name);
              const color = TRACE_COLORS[i % TRACE_COLORS.length];
              return (
                <button
                  key={name}
                  onClick={() => toggleVariable(name)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 8px", border: "none", borderRadius: 4,
                    background: active ? "#1e293b" : "transparent",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                    background: active ? color : "#334155",
                  }} />
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: active ? color : "#475569", wordBreak: "break-all" }}>
                    {name}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Cursor readout */}
          {cVals.length > 0 && cursor && (
            <div style={{ marginTop: "auto", padding: 10, borderTop: "1px solid #1e293b" }}>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6, textTransform: "uppercase" }}>Cursor</div>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                t = {fmtTime(vr.xMin + (cursor.px / plotW) * (vr.xMax - vr.xMin))}
              </div>
              {cVals.map(({ name, value, color }) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 80 }}>{name}</span>
                  <span style={{ color: "#e2e8f0", fontFamily: "monospace" }}>{fmtVal(value)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Fit / Reset button */}
          <div style={{ padding: 10 }}>
            <button
              onClick={() => {
                if (!result?.time) return;
                const times = result.time;
                let yMin = Infinity, yMax = -Infinity;
                for (const name of selectedVariables.length > 0 ? selectedVariables : result.variables) {
                  const d = result.data[name];
                  if (!d) continue;
                  for (const v of d) { if (isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; } }
                }
                if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
                if (yMin === yMax) { yMin -= 1; yMax += 1; }
                const yPad = (yMax - yMin) * 0.12;
                setViewRange({ xMin: times[0], xMax: times[times.length - 1], yMin: yMin - yPad, yMax: yMax + yPad });
              }}
              style={{ width: "100%", padding: "5px 0", background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
            >↩ Fit View</button>
          </div>
        </div>

        {/* ── Plot area ── */}
        <div
          ref={containerRef}
          style={{ flex: 1, overflow: "hidden", cursor: isPanning ? "grabbing" : "crosshair" }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setCursor(null); handleMouseUp(); }}
        >
          <svg
            width={dims.w}
            height={dims.h}
            style={{ display: "block" }}
          >
            <defs>
              <clipPath id="osc-clip">
                <rect x={0} y={0} width={plotW} height={plotH} />
              </clipPath>
            </defs>

            {/* Background */}
            <rect width={dims.w} height={dims.h} fill="#0f172a" />
            <rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} fill="#0b1120" rx={2} />

            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {/* Grid X */}
              {xTicks.map((t) => {
                const sx = toSx(t, vr);
                return (
                  <g key={t}>
                    <line x1={sx} y1={0} x2={sx} y2={plotH} stroke="#1e293b" strokeWidth={1} />
                    <text x={sx} y={plotH + 16} textAnchor="middle" fontSize={10} fill="#475569">{fmtTime(t)}</text>
                  </g>
                );
              })}

              {/* Grid Y */}
              {yTicks.map((v) => {
                const sy = toSy(v, vr);
                return (
                  <g key={v}>
                    <line x1={0} y1={sy} x2={plotW} y2={sy} stroke="#1e293b" strokeWidth={1} />
                    <text x={-6} y={sy + 4} textAnchor="end" fontSize={10} fill="#475569">{fmtVal(v)}</text>
                  </g>
                );
              })}

              {/* Zero line if visible */}
              {vr.yMin < 0 && vr.yMax > 0 && (
                <line x1={0} y1={toSy(0, vr)} x2={plotW} y2={toSy(0, vr)} stroke="#334155" strokeWidth={1} strokeDasharray="4 3" />
              )}

              {/* Traces */}
              <g clipPath="url(#osc-clip)">
                {selectedVariables.map((name, i) => (
                  <path
                    key={name}
                    d={buildPath(name, vr)}
                    stroke={TRACE_COLORS[i % TRACE_COLORS.length]}
                    strokeWidth={1.5}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>

              {/* Cursor crosshair */}
              {cursor && (
                <g style={{ pointerEvents: "none" }}>
                  <line x1={cursor.px} y1={0} x2={cursor.px} y2={plotH} stroke="#ffffff30" strokeWidth={1} />
                  <line x1={0} y1={cursor.py} x2={plotW} y2={cursor.py} stroke="#ffffff20" strokeWidth={1} />
                  {/* Trace intersection dots */}
                  {cVals.map(({ name, value, color }) => (
                    <circle
                      key={name}
                      cx={cursor.px}
                      cy={toSy(value, vr)}
                      r={3}
                      fill={color}
                      stroke="#0f172a"
                      strokeWidth={1}
                    />
                  ))}
                </g>
              )}

              {/* Axes borders */}
              <rect x={0} y={0} width={plotW} height={plotH} fill="none" stroke="#334155" strokeWidth={1} />
            </g>

            {/* Axis labels */}
            <text x={MARGIN.left + plotW / 2} y={dims.h - 4} textAnchor="middle" fontSize={11} fill="#64748b">Time</text>
          </svg>
        </div>
      </div>
    </div>
  );
}

function OscHeader() {
  const { result } = useSimulationStore();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "6px 16px", background: "#1e293b",
      borderBottom: "1px solid #334155", flexShrink: 0,
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 12 L9 8 L11 13 L13 9 L16 12" />
      </svg>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>Oscilloscope</span>
      {result && (
        <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>
          {result.variables.length} variable{result.variables.length !== 1 ? "s" : ""} · scroll to zoom · drag to pan
        </span>
      )}
    </div>
  );
}
