import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";

// Default caption anchors (node-local px) and symbol centre — must match the
// LABEL_POS/VALUE_POS/centre used by ComponentNode and LTSpiceParser so that a
// zero offset maps to our default layout and the round-trip is exact.
const CENTER = 40;
const LABEL_DEFAULT = { left: -6, top: 30 };
const VALUE_DEFAULT = { left: -6, top: 48 };
type Offset = { x: number; y: number } | undefined;
const winCoord = (def: { left: number; top: number }, off: Offset) => ({
  x: Math.round(def.left - CENTER + (off?.x ?? 0)),
  y: Math.round(def.top - CENTER + (off?.y ?? 0)),
});

const TYPE_TO_SYMBOL: Record<string, string> = {
  resistor: "res",
  capacitor: "cap",
  inductor: "ind",
  diode: "diode",
  led: "LED",
  bjt_npn: "npn",
  bjt_pnp: "pnp",
  mosfet_n: "nmos",
  mosfet_p: "pmos",
  vsource: "voltage",
  isource: "current",
  sinesource: "voltage",
  pulsesource: "voltage",
};

export class LTSpiceExporter {
  static export(nodes: Node[], edges: Edge[], directives: string, circuit: any): string {
    const lines: string[] = [];
    lines.push("Version 4");
    lines.push("SHEET 1 880 680");

    // We will just draw direct wires between node centers for simplicity in this prototype.
    // In a full implementation, we'd calculate orthogonal paths and exact pin offsets.
    for (const edge of edges) {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (sourceNode && targetNode) {
        // approximate center (assuming position is top-left, add 40 for 80x80 node)
        const sx = Math.round(sourceNode.position.x + 40);
        const sy = Math.round(sourceNode.position.y + 40);
        const tx = Math.round(targetNode.position.x + 40);
        const ty = Math.round(targetNode.position.y + 40);
        lines.push(`WIRE ${sx} ${sy} ${tx} ${sy}`); // horizontal
        lines.push(`WIRE ${tx} ${sy} ${tx} ${ty}`); // vertical
      }
    }

    // Export components
    for (const node of nodes) {
      const data = node.data as {
        componentType: ComponentType; label: string; valueLabel?: string; rotation?: number;
        labelOffset?: { x: number; y: number }; valueOffset?: { x: number; y: number };
      };
      const x = Math.round(node.position.x + 40);
      const y = Math.round(node.position.y + 40);

      if (data.componentType === "ground") {
        lines.push(`FLAG ${x} ${y} 0`);
        continue;
      }

      const symName = TYPE_TO_SYMBOL[data.componentType] || "res";
      let rotStr = "R0";
      if (data.rotation === 90) rotStr = "R90";
      if (data.rotation === 180) rotStr = "R180";
      if (data.rotation === 270) rotStr = "R270";

      lines.push(`SYMBOL ${symName} ${x} ${y} ${rotStr}`);

      // Persist caption positions so LTSpice (and our own re-import) keep them.
      // Right-justified: text extends left of the anchor, like our rendering.
      const lw = winCoord(LABEL_DEFAULT, data.labelOffset);
      lines.push(`WINDOW 0 ${lw.x} ${lw.y} Right 2`);
      if (data.valueLabel) {
        const vw = winCoord(VALUE_DEFAULT, data.valueOffset);
        lines.push(`WINDOW 3 ${vw.x} ${vw.y} Right 2`);
      }

      lines.push(`SYMATTR InstName ${data.label}`);

      let val = data.valueLabel || "";
      
      // If it's a special source, we might need to extract the actual value string from the circuit store
      const comp = circuit.components.get(node.id);
      if (comp) {
        if (data.componentType === "sinesource") {
          val = `SINE(${comp.offset || 0} ${comp.amplitude || 1} ${comp.frequency || 1000})`;
        } else if (data.componentType === "pulsesource") {
          val = `PULSE(${comp.initialValue || 0} ${comp.pulsedValue || 5} 0 1n 1n ${comp.pulseWidth || 0.0005} ${comp.period || 0.001})`;
        } else if (comp.resistance !== undefined) {
          val = comp.resistance.toString();
        } else if (comp.capacitance !== undefined) {
          val = comp.capacitance.toString();
        } else if (comp.inductance !== undefined) {
          val = comp.inductance.toString();
        } else if (comp.dcValue !== undefined) {
          val = comp.dcValue.toString();
        }
      }

      if (val) {
        lines.push(`SYMATTR Value ${val}`);
      }
    }

    // Directives
    if (directives) {
      const textLines = directives.split("\n");
      let ty = 100;
      for (const t of textLines) {
        if (t.trim()) {
          lines.push(`TEXT 10 ${ty} Left 2 !${t.trim()}`);
          ty += 32;
        }
      }
    }

    return lines.join("\n");
  }
}
