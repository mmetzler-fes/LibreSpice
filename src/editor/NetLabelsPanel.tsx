import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";

// 1. Eine eigene Unterkomponente für das einzelne Eingabefeld
function NetLabelInput({ id, initialLabel, onRename }: {
  id: string;
  initialLabel: string;
  onRename: (id: string, value: string) => void
}) {
  const [localValue, setLocalValue] = React.useState(initialLabel);
  const theme = useTheme();

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
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: "monospace",
          width: "100%",
          boxSizing: "border-box",
          background: theme.inputBg,
          color: theme.text,
        }}
      />
    </label>
  );
}

// 2. Die Hauptkomponente
export function NetLabelsPanel() {
  const { circuit, selectedComponentId, renameNet, netVersion, edges } = useCircuitStore();
  const theme = useTheme();
  const borderTop = theme.borderMuted;
  const heading = theme.heading;
  void netVersion;

  const selectedEdge = edges.find((e) => e.selected);

  const nets = React.useMemo(() => {
    // A selected wire belongs to exactly one net — show that one and nothing
    // else, so the field on screen is the label of the wire in hand.
    if (selectedEdge) {
      const comp = circuit.components.get(selectedEdge.source);
      const netId = comp?.ports.find((p) => p.id === `${selectedEdge.source}-${selectedEdge.sourceHandle}`)?.netId;
      const net = netId ? circuit.nets.get(netId) : undefined;
      return net && netId !== "0" ? [[netId, net] as [string, typeof net]] : [];
    }
    // A selected component: only the nets on its own pins.
    if (selectedComponentId) {
      const comp = circuit.components.get(selectedComponentId);
      if (comp) {
        const netIds = new Set(
          comp.ports.map((p) => p.netId).filter((id): id is string => !!id && id !== "0")
        );
        return Array.from(circuit.nets.entries()).filter(([id]) => netIds.has(id));
      }
    }
    // Nothing selected: every net (except GND).
    return Array.from(circuit.nets.entries()).filter(([id]) => id !== "0");
  }, [circuit, selectedComponentId, selectedEdge, netVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (nets.length === 0) {
    return (
      <div style={{ padding: "10px 16px", fontSize: 11, color: theme.textMuted, borderTop: `1px solid ${borderTop}` }}>
        <strong style={{ display: "block", marginBottom: 4, color: heading }}>Net Labels</strong>
        No nets yet – connect components to create nets.
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 16px", borderTop: `1px solid ${borderTop}` }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: heading }}>
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