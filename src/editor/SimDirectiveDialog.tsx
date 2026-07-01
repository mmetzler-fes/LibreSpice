import { useEffect, useState } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { formatAnalysisDirective, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";

/** Default config when switching to a given analysis type. */
function defaultConfig(type: SimulationConfig["type"]): SimulationConfig {
  switch (type) {
    case "tran": return { type: "tran", stepTime: 1e-6, stopTime: 1e-3 };
    case "dc": return { type: "dc", sourceName: "V1", start: 0, stop: 5, step: 0.1 };
    case "ac": return { type: "ac", variation: "DEC", points: 10, startFreq: 1, stopFreq: 1e6 };
    case "op": return { type: "op" };
  }
}

const TYPE_LABEL: Record<SimulationConfig["type"], string> = {
  tran: "Transient (.tran)",
  dc: "DC Sweep (.dc)",
  ac: "AC Analysis (.ac)",
  op: "Operating Point (.op)",
};

/**
 * Modal editor for the simulation directive. Opened by right-clicking the
 * `.tran …` directive; shows every parameter of the active analysis type and
 * writes them back on OK (Cancel leaves the current settings untouched).
 */
export function SimDirectiveDialog() {
  const { simulationConfig, setSimulationConfig } = useCircuitStore();
  const { showSimConfigDialog, setSimConfigDialog } = useUIStore();
  const [cfg, setCfg] = useState<SimulationConfig>(simulationConfig);

  // Seed a fresh working copy whenever the dialog opens.
  useEffect(() => {
    if (showSimConfigDialog) setCfg(simulationConfig);
  }, [showSimConfigDialog, simulationConfig]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showSimConfigDialog) setSimConfigDialog(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showSimConfigDialog, setSimConfigDialog]);

  if (!showSimConfigDialog) return null;

  const close = () => setSimConfigDialog(false);
  const apply = () => { setSimulationConfig(cfg); close(); };
  const patch = (p: Partial<SimulationConfig>) => setCfg((c) => ({ ...c, ...p } as SimulationConfig));

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, width: 420, maxWidth: "92vw", boxShadow: "0 25px 50px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #334155", background: "#0f172a" }}>
          <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>Edit Simulation Parameters</span>
          <button onClick={close} title="Close (Esc)" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Analysis Type">
            <select value={cfg.type} onChange={(e) => setCfg(defaultConfig(e.target.value as SimulationConfig["type"]))} style={selectStyle}>
              {(Object.keys(TYPE_LABEL) as SimulationConfig["type"][]).map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
          </Field>

          {cfg.type === "tran" && (
            <>
              <NumField label="Step Time (s)" value={cfg.stepTime} onChange={(v) => patch({ stepTime: v ?? 0 })} />
              <NumField label="Stop Time (s)" value={cfg.stopTime} onChange={(v) => patch({ stopTime: v ?? 0 })} />
              <NumField label="Start Time (save data) (s)" value={cfg.startTime} optional onChange={(v) => patch({ startTime: v })} />
              <NumField label="Max Timestep (s)" value={cfg.maxStep} optional onChange={(v) => patch({ maxStep: v })} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#cbd5e1", cursor: "pointer" }}>
                <input type="checkbox" checked={!!cfg.uic} onChange={(e) => patch({ uic: e.target.checked })} />
                Use initial conditions (uic)
              </label>
            </>
          )}

          {cfg.type === "dc" && (
            <>
              <Field label="Source Name">
                <input value={cfg.sourceName} onChange={(e) => patch({ sourceName: e.target.value })} style={inputStyle} />
              </Field>
              <NumField label="Start (V/A)" value={cfg.start} onChange={(v) => patch({ start: v ?? 0 })} />
              <NumField label="Stop (V/A)" value={cfg.stop} onChange={(v) => patch({ stop: v ?? 0 })} />
              <NumField label="Increment (V/A)" value={cfg.step} onChange={(v) => patch({ step: v ?? 0 })} />
            </>
          )}

          {cfg.type === "ac" && (
            <>
              <Field label="Variation">
                <select value={cfg.variation} onChange={(e) => patch({ variation: e.target.value as "DEC" | "OCT" | "LIN" })} style={selectStyle}>
                  <option value="DEC">Decade (DEC)</option>
                  <option value="OCT">Octave (OCT)</option>
                  <option value="LIN">Linear (LIN)</option>
                </select>
              </Field>
              <NumField label="Points per Decade/Octave" value={cfg.points} onChange={(v) => patch({ points: v ?? 0 })} />
              <NumField label="Start Frequency (Hz)" value={cfg.startFreq} onChange={(v) => patch({ startFreq: v ?? 0 })} />
              <NumField label="Stop Frequency (Hz)" value={cfg.stopFreq} onChange={(v) => patch({ stopFreq: v ?? 0 })} />
            </>
          )}

          {cfg.type === "op" && (
            <p style={{ margin: 0, fontSize: 12, color: "#94a3b8" }}>Operating point analysis has no parameters.</p>
          )}

          <div style={{ fontSize: 11, color: "#64748b" }}>
            Directive:{" "}
            <code style={{ color: "#67e8f9", background: "#0f172a", padding: "2px 6px", borderRadius: 3 }}>
              {formatAnalysisDirective(cfg)}
            </code>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={close} style={{ padding: "6px 14px", border: "1px solid #475569", background: "transparent", color: "#94a3b8", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            <button onClick={apply} style={{ padding: "6px 16px", border: "none", background: "#2563eb", color: "#fff", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: 12 }}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 12,
  background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4,
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "#cbd5e1" }}>
      {label}
      {children}
    </label>
  );
}

function NumField({ label, value, optional, onChange }: {
  label: string; value?: number; optional?: boolean; onChange: (v: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value ?? ""}
        placeholder={optional ? "auto" : ""}
        onChange={(e) => {
          const s = e.target.value;
          if (s.trim() === "") { onChange(undefined); return; }
          const n = parseFloat(s);
          onChange(isFinite(n) ? n : undefined);
        }}
        style={inputStyle}
      />
    </Field>
  );
}
