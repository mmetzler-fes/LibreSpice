import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";
import type { ArrowDir } from "./WireTool.js";

const ARROW_DIRS: ArrowDir[] = ["up", "down", "left", "right"];
const ARROW_GLYPH: Record<ArrowDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/**
 * Properties for a selected wire: whether its net name is shown permanently
 * ("visible"), whether it also draws a net-connector symbol, and the arrow
 * direction of that connector. Mirrors the LTSpice net-label/flag idea, but the
 * label/connector lives on the wire itself rather than on a separate node.
 */
export function WirePropertiesPanel() {
  const { edges, updateEdgeData } = useCircuitStore();
  const theme = useTheme();

  const edge = edges.find((e) => e.selected);
  if (!edge) return null;

  const data = (edge.data ?? {}) as { showLabel?: boolean; connector?: boolean; arrowDir?: ArrowDir };
  const showLabel = !!data.showLabel;
  const connector = !!data.connector;
  const arrowDir = data.arrowDir ?? "right";

  const setVisible = (v: boolean) => {
    // Turning the label off also drops the connector (which needs a label).
    updateEdgeData(edge.id, v ? { showLabel: true } : { showLabel: false, connector: false });
  };
  const setConnector = (v: boolean) => {
    // A connector always shows its label, so enabling it implies "visible".
    updateEdgeData(edge.id, v ? { connector: true, showLabel: true } : { connector: false });
  };

  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };

  return (
    <div style={{ padding: "10px 16px", borderTop: `1px solid ${theme.borderMuted}` }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: theme.heading }}>
        Wire / Net connector
      </strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={rowStyle}>
          <input type="checkbox" checked={showLabel} onChange={(e) => setVisible(e.target.checked)} />
          <span>visible (Netzname anzeigen)</span>
        </label>
        <label style={rowStyle}>
          <input type="checkbox" checked={connector} onChange={(e) => setConnector(e.target.checked)} />
          <span>Net connector (Symbol)</span>
        </label>
        {connector && (
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: theme.textMuted, fontWeight: 500 }}>Pfeilrichtung</span>
            <select
              value={arrowDir}
              onChange={(e) => updateEdgeData(edge.id, { arrowDir: e.target.value as ArrowDir })}
              style={{
                padding: "4px 6px",
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                background: theme.inputBg,
                color: theme.text,
              }}
            >
              {ARROW_DIRS.map((d) => (
                <option key={d} value={d}>{ARROW_GLYPH[d]} {d}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        Label lässt sich entlang der Leitung ziehen. Strg-R dreht den Connector-Pfeil.
      </p>
    </div>
  );
}
