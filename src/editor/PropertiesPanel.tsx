import { useState, useEffect } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useUIStore } from "@store/uiStore.js";
import { getProbeCandidates, netLabel } from "@core/circuit/probeUtils.js";

const SI_MULT: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, "": 1,
};

/** Parse a number with an optional SI prefix (e.g. "4.7k", "10n", "1.5M"). */
function parseSI(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([pnuµmkKMGT]?)/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!isFinite(base)) return null;
  return base * (SI_MULT[m[2]] ?? 1);
}

/** Format a number with a compact SI prefix (no unit), e.g. 1000 → "1k". */
function fmtSIShort(v: number): string {
  if (!isFinite(v)) return "0";
  if (v === 0) return "0";
  const a = Math.abs(v);
  const steps: [number, string][] = [
    [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
    [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
  ];
  for (const [f, suffix] of steps) {
    if (a >= f) return `${+(v / f).toPrecision(4)}${suffix}`;
  }
  return `${+(v * 1e12).toPrecision(4)}p`;
}

const fieldStyle: React.CSSProperties = {
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  width: "100%",
  boxSizing: "border-box",
};

/** Text input that accepts SI-prefixed values and emits a plain number. */
function SIInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(() => fmtSIShort(value));
  const [focused, setFocused] = useState(false);
  // Reflect external changes while not actively editing.
  useEffect(() => {
    if (!focused) setText(fmtSIShort(value));
  }, [value, focused]);

  return (
    <input
      type="text"
      value={text}
      inputMode="decimal"
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setText(fmtSIShort(value)); }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseSI(e.target.value);
        if (n !== null) onChange(n);
      }}
      style={fieldStyle}
    />
  );
}

export function PropertiesPanel() {
  const { circuit, selectedComponentId, updateComponentProperty, propertyVersion } = useCircuitStore();
  const { addProbeCandidates } = useSimulationStore();
  const { setDockTab } = useUIStore();
  void propertyVersion;

  const component = selectedComponentId ? circuit.components.get(selectedComponentId) : null;

  if (!component) {
    return (
      <aside
        style={{
          width: 220,
          borderLeft: "1px solid #e2e8f0",
          padding: 16,
          background: "#fafafa",
          fontSize: 12,
          color: "#94a3b8",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Select a component to edit its properties
      </aside>
    );
  }

  const properties = component.getProperties();
  const isGround = component.id.startsWith("ground_");

  const handleProbeAll = () => {
    addProbeCandidates(getProbeCandidates(component, circuit));
    setDockTab("waveform");
  };

  const handleProbeCurrent = () => {
    addProbeCandidates([`I(${component.label})`, `i(${component.label})`]);
    setDockTab("waveform");
  };

  const handleProbeVoltage = () => {
    const port = component.ports.find((p) => p.netId);
    if (!port) return;
    const name = netLabel(circuit, port.netId);
    if (!name) return;
    addProbeCandidates([`V(${name})`, `v(${name})`]);
    setDockTab("waveform");
  };

  return (
    <aside
      style={{
        width: 220,
        borderLeft: "1px solid #e2e8f0",
        padding: 16,
        background: "#fafafa",
        overflowY: "auto",
        fontSize: 12,
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
        Properties — {component.label}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {properties.map((prop) => (
          <label key={prop.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: "#64748b", fontWeight: 500 }}>
              {prop.label}
              {prop.unit && <span style={{ color: "#94a3b8" }}> ({prop.unit})</span>}
            </span>
            {prop.type === "select" && prop.options ? (
              <select
                value={String(prop.value)}
                onChange={(e) => updateComponentProperty(component.id, prop.key, e.target.value)}
                style={{ padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 4 }}
              >
                {prop.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : prop.type === "number" ? (
              <SIInput
                value={Number(prop.value)}
                onChange={(n) => updateComponentProperty(component.id, prop.key, n)}
              />
            ) : (
              <input
                type="text"
                value={String(prop.value)}
                onChange={(e) => updateComponentProperty(component.id, prop.key, e.target.value)}
                style={fieldStyle}
              />
            )}
          </label>
        ))}
      </div>

      {!isGround && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
          <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: "#475569" }}>Probes</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              onClick={handleProbeAll}
              style={probeBtnStyle}
            >
              Add all probes
            </button>
            <button type="button" onClick={handleProbeVoltage} style={probeBtnStyle}>
              Probe voltage
            </button>
            {component.ports.length >= 2 && (
              <button type="button" onClick={handleProbeCurrent} style={probeBtnStyle}>
                Probe current I({component.label})
              </button>
            )}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8" }}>
            Or double-click component on canvas
          </p>
        </div>
      )}
    </aside>
  );
}

const probeBtnStyle: React.CSSProperties = {
  padding: "5px 8px",
  fontSize: 11,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  textAlign: "left",
};
