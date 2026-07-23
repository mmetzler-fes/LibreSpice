import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { PORT_TYPES, type PortType } from "@core/components/special/Special.js";
import { resolveAnchors } from "./anchorNets.js";

/**
 * Properties of the selected name: what it says, and whether it also declares an
 * interface direction.
 *
 * Net label and net connector are the same thing here, because they are the same
 * thing in the file: a `FLAG`, optionally followed by an `IOPIN`. The port type
 * is that second line — `None` writes no `IOPIN`, which is exactly how LTSpice
 * stores a plain label — so the two are one control, not two kinds of object
 * with separate panels.
 *
 * There is deliberately no panel for a *wire*. A wire has no properties the file
 * can hold: its name is a flag at a point, which is this.
 */
export function NetAnchorPanel() {
  const anchors = useCircuitStore((s) => s.netAnchors);
  const nodes = useCircuitStore((s) => s.nodes);
  const edges = useCircuitStore((s) => s.edges);
  const circuit = useCircuitStore((s) => s.circuit);
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const update = useCircuitStore((s) => s.updateNetAnchor);
  const remove = useCircuitStore((s) => s.removeNetAnchor);
  const selectedId = useUIStore((s) => s.selectedAnchorId);
  const setSelected = useUIStore((s) => s.setSelectedAnchorId);
  const theme = useTheme();
  useCircuitStore((s) => s.netVersion);

  const anchor = anchors.find((a) => a.id === selectedId);

  if (!anchor) return null;

  // Which net this name is actually sitting on — the question a name raises and
  // the node model never had to answer, so it is worth showing rather than
  // leaving the user to guess from the drawing.
  const netId = resolveAnchors({ nodes, edges, netAnchors: [anchor], circuit }, symbolNorm).get(anchor.id);
  const net = netId ? circuit.nets.get(netId) : undefined;

  const portType: PortType = anchor.portType ?? "None";
  const fieldStyle: React.CSSProperties = {
    padding: "4px 6px", border: `1px solid ${theme.border}`, borderRadius: 4,
    width: "100%", boxSizing: "border-box", background: theme.inputBg, color: theme.text,
    fontFamily: "monospace", fontSize: 12,
  };

  return (
    <div style={{ padding: "10px 16px", borderTop: `1px solid ${theme.borderMuted}` }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: theme.heading }}>
        {portType === "None" ? "Netzname" : "Net Connector"}
      </strong>

      <label style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>Name</span>
        {/* Uncontrolled, re-keyed per name: the field holds what is being typed
            and commits on blur, so a half-typed name is not pushed through the
            store (which would re-resolve every net on each keystroke). The key
            makes it adopt the new value when a different name is selected. */}
        <input
          key={`${anchor.id}:${anchor.name}`}
          type="text"
          defaultValue={anchor.name}
          onBlur={(e) => update(anchor.id, { name: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={fieldStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>Port-Typ</span>
        <select
          value={portType}
          onChange={(e) => update(anchor.id, { portType: e.target.value as PortType })}
          style={{ ...fieldStyle, fontFamily: "inherit" }}
        >
          {PORT_TYPES.map((t) => (
            <option key={t} value={t}>{t === "None" ? "None (einfaches Netzlabel)" : t}</option>
          ))}
        </select>
      </label>

      <p style={{ margin: "8px 0 0", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        {net
          ? <>Liegt auf Netz <code>{net.nodeLabel}</code>. Gleiche Namen sind elektrisch verbunden.</>
          : <>Liegt auf keiner Leitung — dieser Name benennt zurzeit nichts.</>}
      </p>

      <button
        onClick={() => { remove(anchor.id); setSelected(null); }}
        style={{
          marginTop: 8, padding: "4px 8px", fontSize: 11, cursor: "pointer",
          border: `1px solid ${theme.border}`, borderRadius: 4,
          background: "transparent", color: "#dc2626",
        }}
      >
        Namen entfernen
      </button>
    </div>
  );
}
