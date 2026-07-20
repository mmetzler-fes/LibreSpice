import { useState, useEffect } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { getProbeCandidates, netLabel } from "@core/circuit/probeUtils.js";
import { isParametricValue, parseValueInput, valueFieldText } from "@core/components/base/componentValue.js";
import { parsePwlFile } from "@core/components/sources/pwlFile.js";

/**
 * Text input for a component value: an SI-prefixed number (`4.7k`) or a
 * parametric expression in braces (`{RM}`), emitted verbatim so the component
 * stores it as its `valueExpr`.
 *
 * The same field serves both, on purpose. Rendering a number input and a text
 * input depending on the *current* value would swap the element mid-word — the
 * moment `{` is typed — and take the focus with it.
 *
 * A number commits as you type (as before); an expression only on Enter or blur,
 * since a half-typed `{R` is not yet meaningful.
 */
function ValueField({ value, onChange }: { value: string | number; onChange: (v: number | string) => void }) {
  const [text, setText] = useState(() => valueFieldText(value));
  const [focused, setFocused] = useState(false);
  const theme = useTheme();
  // Reflect external changes while not actively editing.
  useEffect(() => {
    if (!focused) setText(valueFieldText(value));
  }, [value, focused]);

  /** Commit the current text; restore the stored value when it is not usable. */
  const commit = () => {
    const parsed = parseValueInput(text);
    if (parsed) onChange(parsed.value);
    else setText(valueFieldText(value));
  };

  const dynFieldStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    width: "100%",
    boxSizing: "border-box",
    background: theme.inputBg,
    color: theme.text,
  };

  return (
    <input
      type="text"
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      onChange={(e) => {
        setText(e.target.value);
        // Live-commit plain numbers (as before); an expression waits for Enter/blur.
        const parsed = parseValueInput(e.target.value);
        if (parsed?.kind === "number") onChange(parsed.value);
      }}
      style={dynFieldStyle}
    />
  );
}

/**
 * Load PWL breakpoints from a measurement file.
 *
 * ngspice's `PWL file=…` is out of reach here — the simulator is WebAssembly
 * with no filesystem of its own — so the file is read in the browser and its
 * points are written into the source. The data then lives in the circuit, which
 * also means a shared or saved schematic still carries its waveform.
 */
function PwlFileButton({ onLoad }: { onLoad: (points: string) => void }) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const theme = useTheme();

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.csv,.dat,.tsv,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { points, count } = parsePwlFile(await file.text());
        onLoad(points);
        setStatus({ ok: true, text: `${count} Stützstellen aus ${file.name}` });
      } catch (e) {
        setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
      }
    };
    input.click();
  };

  return (
    <>
      <button
        type="button"
        onClick={pick}
        style={{
          padding: "4px 6px",
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          background: theme.inputBg,
          color: theme.text,
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        Aus Datei laden…
      </button>
      {status && (
        <span style={{ fontSize: 10, color: status.ok ? theme.textMuted : "#dc2626" }}>
          {status.text}
        </span>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const { circuit, selectedComponentId, updateComponentProperty, propertyVersion } = useCircuitStore();
  const { addProbeCandidates } = useSimulationStore();
  const { setDockTab } = useUIStore();
  const theme = useTheme();
  void propertyVersion;

  const component = selectedComponentId ? circuit.components.get(selectedComponentId) : null;

  if (!component) {
    return (
      <aside
        style={{
          width: 220,
          borderLeft: `1px solid ${theme.borderMuted}`,
          padding: 16,
          background: theme.panelBg,
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

  const dynBorder = theme.borderMuted;
  const dynFieldStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    width: "100%",
    boxSizing: "border-box",
    background: theme.inputBg,
    color: theme.text,
  };
  const dynProbeBtnStyle: React.CSSProperties = {
    padding: "5px 8px",
    fontSize: 11,
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    background: theme.inputBg,
    color: theme.text,
    cursor: "pointer",
    textAlign: "left",
  };

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
        borderLeft: `1px solid ${dynBorder}`,
        padding: 16,
        background: theme.panelBg,
        overflowY: "auto",
        fontSize: 12,
        color: theme.text,
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
        Properties — {component.label}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {properties.map((prop) => (
          <label key={prop.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: theme.textMuted, fontWeight: 500 }}>
              {prop.label}
              {prop.unit && <span style={{ color: "#94a3b8" }}> ({prop.unit})</span>}
            </span>
            {prop.type === "select" && prop.options ? (
              <select
                value={String(prop.value)}
                onChange={(e) => updateComponentProperty(component.id, prop.key, e.target.value)}
                style={{
                  padding: "4px 6px",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  background: theme.inputBg,
                  color: theme.text,
                }}
              >
                {prop.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : prop.type === "number" || isParametricValue(prop.value) ? (
              // A parametric value arrives typed as a string; it is still the
              // component's value field, so it keeps the same editor.
              <ValueField
                value={prop.value}
                onChange={(n) => updateComponentProperty(component.id, prop.key, n)}
              />
            ) : (
              <input
                type="text"
                value={String(prop.value)}
                onChange={(e) => updateComponentProperty(component.id, prop.key, e.target.value)}
                style={dynFieldStyle}
              />
            )}
            {prop.key === "pwlPoints" && (
              <PwlFileButton
                onLoad={(points) => updateComponentProperty(component.id, "pwlPoints", points)}
              />
            )}
          </label>
        ))}
      </div>

      {!isGround && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${dynBorder}` }}>
          <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: theme.heading }}>Probes</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              onClick={handleProbeAll}
              style={dynProbeBtnStyle}
            >
              Add all probes
            </button>
            <button type="button" onClick={handleProbeVoltage} style={dynProbeBtnStyle}>
              Probe voltage
            </button>
            {component.ports.length >= 2 && (
              <button type="button" onClick={handleProbeCurrent} style={dynProbeBtnStyle}>
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

