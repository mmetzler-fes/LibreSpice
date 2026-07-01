import { useSimulationStore } from "@store/simulationStore.js";

/** Shows the raw ngspice log (stdout/stderr) from the last simulation run. */
export function LogPanel() {
  const { log, status, errorMessage } = useSimulationStore();

  const copy = () => {
    if (log) navigator.clipboard?.writeText(log).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0f172a", color: "#e2e8f0" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px", borderBottom: "1px solid #1e293b", flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Simulation Log</span>
        {status === "error" && (
          <span style={{ fontSize: 11, color: "#f87171" }}>● error</span>
        )}
        <button
          onClick={copy}
          disabled={!log}
          style={{
            marginLeft: "auto", fontSize: 11, padding: "2px 8px",
            background: "#1e293b", color: "#94a3b8", border: "1px solid #334155",
            borderRadius: 4, cursor: log ? "pointer" : "default",
          }}
        >
          Copy
        </button>
      </div>
      {errorMessage && (
        <div style={{ padding: "6px 12px", background: "#7f1d1d", color: "#fecaca", fontSize: 12, flexShrink: 0 }}>
          {errorMessage}
        </div>
      )}
      <pre
        style={{
          margin: 0, padding: 12, flex: 1, overflow: "auto",
          fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word",
          color: "#cbd5e1",
        }}
      >
        {log || "No log yet — run a simulation to see ngspice output here."}
      </pre>
    </div>
  );
}
