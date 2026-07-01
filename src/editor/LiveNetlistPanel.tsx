import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";

export function LiveNetlistPanel() {
  const { netlist, spiceDirectives, setSpiceDirectives } = useCircuitStore();
  const { darkMode } = useUIStore();

  const bg = darkMode ? "#0f172a" : "#1e293b";
  const fg = darkMode ? "#e2e8f0" : "#e2e8f0";
  const border = darkMode ? "#334155" : "#334155";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        <pre
          style={{
            margin: 0,
            fontFamily: "'Cascadia Code', 'Fira Code', monospace",
            fontSize: 11,
            lineHeight: 1.5,
            background: bg,
            color: fg,
            padding: 10,
            borderRadius: 4,
            border: `1px solid ${border}`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {netlist || "* Empty circuit – add components on the canvas"}
        </pre>
      </div>
      <div style={{ padding: "8px 8px 0", flexShrink: 0 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: "#64748b", display: "block", marginBottom: 4 }}>
          Custom SPICE Directives
        </label>
        <textarea
          value={spiceDirectives}
          onChange={(e) => setSpiceDirectives(e.target.value)}
          placeholder=".model ...&#10;.save V(out) I(R1)"
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "'Cascadia Code', 'Fira Code', monospace",
            fontSize: 11,
            padding: 8,
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            resize: "vertical",
            background: darkMode ? "#1e293b" : "#fff",
            color: darkMode ? "#e2e8f0" : "#1e293b",
          }}
        />
        <p style={{ margin: "4px 0 8px", fontSize: 10, color: "#94a3b8" }}>
          Live-synced with schematic. Directives are appended to the netlist above.
        </p>
      </div>
    </div>
  );
}
