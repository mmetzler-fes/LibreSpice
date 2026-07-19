import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";

/**
 * Properties for a selected wire: whether its net name is shown permanently
 * ("visible") rather than only while the wire is selected.
 *
 * A wire carries a *name*, never a port. Net connectors are their own part (see
 * NetConnector / NetTerminalNode) because LTSpice stores them as a `FLAG` plus an
 * `IOPIN` at a point — there is no such thing as a wire attribute for it, so
 * putting one here could not round-trip.
 */
export function WirePropertiesPanel() {
  const { edges, updateEdgeData, circuit } = useCircuitStore();
  const theme = useTheme();

  const edge = edges.find((e) => e.selected);
  if (!edge) return null;

  const data = (edge.data ?? {}) as { showLabel?: boolean };
  const showLabel = !!data.showLabel;

  const port = edge.source ? circuit.components.get(edge.source)?.ports.find((p) => p.id === `${edge.source}-${edge.sourceHandle}`) : undefined;
  const netName = port?.netId ? (circuit.nets.get(port.netId)?.nodeLabel ?? port.netId) : "";

  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };

  return (
    <div style={{ padding: "10px 16px", borderTop: `1px solid ${theme.borderMuted}` }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: theme.heading }}>
        Wire
      </strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={rowStyle}>
          <input type="checkbox" checked={showLabel} onChange={(e) => updateEdgeData(edge.id, { showLabel: e.target.checked })} />
          <span>visible (Netzname anzeigen{netName ? `: ${netName}` : ""})</span>
        </label>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        Label lässt sich entlang der Leitung ziehen. Für einen Port das Bauteil
        „Net Connector“ aus der Palette setzen.
      </p>
    </div>
  );
}
