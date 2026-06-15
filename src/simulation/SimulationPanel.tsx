import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import type { SimulationConfig } from "@core/circuit/NetlistGenerator.js";

export function SimulationPanel() {
  const { netlist, simulationConfig, setSimulationConfig } = useCircuitStore();
  const { status, result, errorMessage, selectedVariables, toggleVariable, setStatus, setResult, setErrorMessage } =
    useSimulationStore();

  const cfg = simulationConfig;

  const handleRun = async () => {
    if (!netlist) return;
    setStatus("running");
    try {
      const { runSimulation } = await import("./simulationEngine.js");
      const res = await runSimulation(netlist);
      setResult(res);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Unknown simulation error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, flex: 1, overflowY: "auto" }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Simulation</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 12, fontWeight: 500 }}>Analysis Type</label>
        <select
          value={cfg.type}
          onChange={(e) => {
            const type = e.target.value as SimulationConfig["type"];
            if (type === "tran") setSimulationConfig({ type: "tran", stepTime: 1e-6, stopTime: 1e-3 });
            else if (type === "dc") setSimulationConfig({ type: "dc", sourceName: "V1", start: 0, stop: 5, step: 0.1 });
            else if (type === "ac") setSimulationConfig({ type: "ac", variation: "DEC", points: 10, startFreq: 1, stopFreq: 1e6 });
            else setSimulationConfig({ type: "op" });
          }}
          style={{ padding: "4px 8px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12 }}
        >
          <option value="tran">Transient (.tran)</option>
          <option value="dc">DC Sweep (.dc)</option>
          <option value="ac">AC Analysis (.ac)</option>
          <option value="op">Operating Point (.op)</option>
        </select>
      </div>

      {cfg.type === "tran" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldRow
            label="Stop Time (s)"
            value={cfg.stopTime}
            onChange={(v) => setSimulationConfig({ ...cfg, stopTime: v })}
          />
          <FieldRow
            label="Step Time (s)"
            value={cfg.stepTime}
            onChange={(v) => setSimulationConfig({ ...cfg, stepTime: v })}
          />
        </div>
      )}

      {cfg.type === "dc" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 12 }}>
            Source Name
            <input
              value={cfg.sourceName}
              onChange={(e) => setSimulationConfig({ ...cfg, sourceName: e.target.value })}
              style={inputStyle}
            />
          </label>
          <FieldRow label="Start (V)" value={cfg.start} onChange={(v) => setSimulationConfig({ ...cfg, start: v })} />
          <FieldRow label="Stop (V)" value={cfg.stop} onChange={(v) => setSimulationConfig({ ...cfg, stop: v })} />
          <FieldRow label="Step (V)" value={cfg.step} onChange={(v) => setSimulationConfig({ ...cfg, step: v })} />
        </div>
      )}

      {cfg.type === "ac" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldRow label="Start Freq (Hz)" value={cfg.startFreq} onChange={(v) => setSimulationConfig({ ...cfg, startFreq: v })} />
          <FieldRow label="Stop Freq (Hz)" value={cfg.stopFreq} onChange={(v) => setSimulationConfig({ ...cfg, stopFreq: v })} />
          <FieldRow label="Points/Decade" value={cfg.points} onChange={(v) => setSimulationConfig({ ...cfg, points: v })} />
        </div>
      )}

      <button
        onClick={handleRun}
        disabled={status === "running" || !netlist}
        style={{
          padding: "8px 16px",
          background: status === "running" ? "#94a3b8" : "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: status === "running" ? "not-allowed" : "pointer",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        {status === "running" ? "Running..." : "▶ Run Simulation"}
      </button>

      {errorMessage && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4, padding: 8, fontSize: 12, color: "#dc2626" }}>
          {errorMessage}
        </div>
      )}

      {result && (
        <div>
          <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Variables</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {result.variables.map((v) => (
              <label key={v} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selectedVariables.includes(v)}
                  onChange={() => toggleVariable(v)}
                />
                {v}
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Generated Netlist</h4>
        <pre
          style={{
            background: "#1e293b",
            color: "#e2e8f0",
            padding: 12,
            borderRadius: 4,
            fontSize: 11,
            overflowX: "auto",
            maxHeight: 200,
            margin: 0,
          }}
        >
          {netlist || "* (empty – add components and connect them)"}
        </pre>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  marginTop: 3,
  padding: "3px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  width: "100%",
  fontSize: 12,
  boxSizing: "border-box",
};

function FieldRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ fontSize: 12 }}>
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        style={inputStyle}
      />
    </label>
  );
}
