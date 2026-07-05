import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";

// 1. Eine eigene Unterkomponente für das einzelne Eingabefeld
function NetLabelInput({ id, initialLabel, onRename }: { 
  id: string; 
  initialLabel: string; 
  onRename: (id: string, value: string) => void 
}) {
  const [localValue, setLocalValue] = React.useState(initialLabel);

  // Synchronisiert das Feld, falls sich der Wert von außen ändert
  React.useEffect(() => {
    setLocalValue(initialLabel);
  }, [initialLabel]);

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace" }}>
        id: {id}
      </span>
      <input
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        placeholder={id}
        onBlur={() => onRename(id, localValue)}
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
  );
}

// 2. Die Hauptkomponente
export function NetLabelsPanel() {
  const { circuit, selectedComponentId, renameNet, netVersion } = useCircuitStore();
  void netVersion;

  // Collect only the nets connected to the selected component's pins.
  // Fall back to all nets (except GND "0") when nothing is selected.
  const nets = React.useMemo(() => {
    if (selectedComponentId) {
      const comp = circuit.components.get(selectedComponentId);
      if (comp) {
        const netIds = new Set(
          comp.ports.map((p) => p.netId).filter((id): id is string => !!id && id !== "0")
        );
        return Array.from(circuit.nets.entries()).filter(([id]) => netIds.has(id));
      }
    }
    return Array.from(circuit.nets.entries()).filter(([id]) => id !== "0");
  }, [circuit, selectedComponentId, netVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <NetLabelInput 
            key={id} 
            id={id} 
            initialLabel={net.nodeLabel || ""} 
            onRename={renameNet} 
          />
        ))}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        Labels appear in the netlist and oscilloscope probe names.
      </p>
    </div>
  );
}