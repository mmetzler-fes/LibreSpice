import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";

export function LiveNetlistPanel() {
  const { netlist, spiceDirectives, setSpiceDirectives } = useCircuitStore();
  const theme = useTheme();

  const bg = theme.codeBg;
  const fg = theme.codeText;
  const border = theme.codeBorder;

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
        <label style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, display: "block", marginBottom: 4 }}>
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
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            resize: "vertical",
            background: theme.modalBg,
            color: theme.text,
          }}
        />
        <p style={{ margin: "4px 0 8px", fontSize: 10, color: "#94a3b8" }}>
          Live-synced with schematic. Directives are appended to the netlist above.
        </p>
      </div>
    </div>
  );
}
