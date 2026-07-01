import { OscilloscopePlot } from "./OscilloscopePlot.js";
import { useSimulationStore } from "@store/simulationStore.js";

export function OscilloscopeView() {
  const { result } = useSimulationStore();

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#0f172a", overflow: "hidden" }}>
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
      <div style={{ flex: 1, overflow: "hidden" }}>
        <OscilloscopePlot />
      </div>
    </div>
  );
}
