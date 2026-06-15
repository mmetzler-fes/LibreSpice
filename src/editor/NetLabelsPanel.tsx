import { useCircuitStore } from "@store/circuitStore.js";

export function NetLabelsPanel() {
  // netVersion causes re-render on every net rename
  const { circuit, renameNet, netVersion } = useCircuitStore();
  void netVersion;

  // Collect all nets except ground ("0")
  const nets = Array.from(circuit.nets.entries()).filter(([id]) => id !== "0");

  if (nets.length === 0) {
    return (
      <div style={{ padding: "10px 16px", fontSize: 11, color: "#64748b", borderTop: "1px solid #e2e8f0" }}>
        <strong style={{ display: "block", marginBottom: 4, color: "#475569" }}>Net Labels</strong>
        No nets yet – connect components to create nets.
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 16px", borderTop: "1px solid #e2e8f0" }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: "#475569" }}>
        Net Labels
      </strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {nets.map(([id, net]) => (
          <label key={id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace" }}>
              id: {id}
            </span>
            <input
              type="text"
              defaultValue={net.nodeLabel}
              placeholder={id}
              onBlur={(e) => renameNet(id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              style={{
                padding: "3px 6px",
                border: "1px solid #cbd5e1",
                borderRadius: 4,
                fontSize: 12,
                fontFamily: "monospace",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
          </label>
        ))}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        Labels appear in the netlist and oscilloscope probe names.
      </p>
    </div>
  );
}
