import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import {
  CENTER, TYPE_TO_SYMBOL, GROUND_PIN, rotStr, rotatedOffsets, nodeToSymbol, centeringFor,
} from "./ltspiceGeometry.js";

// Default caption anchors (node-local px) — must match ComponentNode and the
// LTSpiceParser so that a zero offset maps to our default layout and the
// WINDOW round-trip is exact.
const LABEL_DEFAULT = { left: 8, top: 30 };
const VALUE_DEFAULT = { left: 8, top: 48 };
type Offset = { x: number; y: number } | undefined;
const winCoord = (def: { left: number; top: number }, off: Offset) => ({
  x: Math.round(def.left - CENTER + (off?.x ?? 0)),
  y: Math.round(def.top - CENTER + (off?.y ?? 0)),
});

interface Pt { x: number; y: number }

/** Expand a vertex list into an orthogonal (right-angle) path — mirrors WireTool. */
function orthoVertices(points: Pt[]): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    if (a.x !== b.x && a.y !== b.y) {
      const corner = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      out.push(corner);
    }
    out.push(b);
  }
  return out;
}

export class LTSpiceExporter {
  static export(nodes: Node[], edges: Edge[], directives: string, circuit: any, dataFlags: DataFlag[] = []): string {
    const header = ["Version 4", "SHEET 1 880 680"];
    const symbolLines: string[] = [];
    const flagLines: string[] = [];
    // Pin coordinates in LTSpice space, keyed by port id `${compId}-${handle}`,
    // so wires and net-label flags attach exactly to the terminals.
    const pinCoord = new Map<string, Pt>();

    for (const node of nodes) {
      const data = node.data as {
        componentType: ComponentType; label: string; valueLabel?: string; rotation?: number;
        labelOffset?: { x: number; y: number }; valueOffset?: { x: number; y: number };
      };

      if (data.componentType === "ground") {
        const fx = Math.round(node.position.x + GROUND_PIN.dx);
        const fy = Math.round(node.position.y + GROUND_PIN.dy);
        flagLines.push(`FLAG ${fx} ${fy} 0`);
        pinCoord.set(`${node.id}-${GROUND_PIN.handle}`, { x: fx, y: fy });
        continue;
      }

      // Net-label terminal → LTSpice `FLAG x y name` at its single pin.
      if (data.componentType === "netlabel") {
        const fx = Math.round(node.position.x + CENTER);
        const fy = Math.round(node.position.y + CENTER);
        flagLines.push(`FLAG ${fx} ${fy} ${String(data.label ?? "NET").trim() || "NET"}`);
        pinCoord.set(`${node.id}-t`, { x: fx, y: fy });
        continue;
      }

      const deg = data.rotation ?? 0;
      const rotated = rotatedOffsets(data.componentType, deg);
      const { x: symX, y: symY } = nodeToSymbol(node.position.x, node.position.y, rotated, centeringFor(data.componentType));
      for (const p of rotated) pinCoord.set(`${node.id}-${p.handle}`, { x: symX + p.dx, y: symY + p.dy });

      const symName = TYPE_TO_SYMBOL[data.componentType] || "res";
      symbolLines.push(`SYMBOL ${symName} ${symX} ${symY} ${rotStr(deg)}`);

      // Persist caption positions so LTSpice (and our own re-import) keep them.
      const lw = winCoord(LABEL_DEFAULT, data.labelOffset);
      symbolLines.push(`WINDOW 0 ${lw.x} ${lw.y} Right 2`);
      if (data.valueLabel) {
        const vw = winCoord(VALUE_DEFAULT, data.valueOffset);
        symbolLines.push(`WINDOW 3 ${vw.x} ${vw.y} Right 2`);
      }

      symbolLines.push(`SYMATTR InstName ${data.label}`);

      let val = data.valueLabel || "";
      const comp = circuit.components.get(node.id);
      if (comp?.valueExpr) {
        val = comp.valueExpr;
      } else if (comp) {
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
      if (val) symbolLines.push(`SYMATTR Value ${val}`);
    }

    // Wires: route each edge through its stored waypoints (the original path
    // from import), made orthogonal, so re-importing matches the pins back to
    // these wires and rebuilds the same nets. Following the waypoints keeps the
    // route off other terminals — a naive L-bend can cross a neighbouring pin.
    const wireLines: string[] = [];
    for (const edge of edges) {
      const a = pinCoord.get(`${edge.source}-${edge.sourceHandle}`);
      const b = pinCoord.get(`${edge.target}-${edge.targetHandle}`);
      if (!a || !b) continue;
      const wps = ((edge.data?.waypoints as Pt[] | undefined) ?? []).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      const verts = orthoVertices([a, ...wps, b]);
      for (let i = 0; i < verts.length - 1; i++) {
        const p = verts[i], q = verts[i + 1];
        if (p.x !== q.x || p.y !== q.y) wireLines.push(`WIRE ${p.x} ${p.y} ${q.x} ${q.y}`);
      }
    }

    // Named nets → FLAGs, placed on a terminal of the net so LTSpice (and our
    // re-import) label the same node. Skip ground and unlabelled nets.
    if (circuit?.nets) {
      for (const [netId, net] of circuit.nets as Map<string, { nodeLabel: string; connectedPortIds: Set<string> }>) {
        if (netId === "0" || net.nodeLabel === netId) continue;
        for (const portId of net.connectedPortIds) {
          const c = pinCoord.get(portId);
          if (c) { flagLines.push(`FLAG ${c.x} ${c.y} ${net.nodeLabel}`); break; }
        }
      }
    }

    const dataflagLines = dataFlags.map((df) => `DATAFLAG ${Math.round(df.x)} ${Math.round(df.y)} "${df.expr}"`);

    const directiveLines: string[] = [];
    if (directives) {
      let ty = 100;
      for (const t of directives.split("\n")) {
        if (t.trim()) { directiveLines.push(`TEXT 10 ${ty} Left 2 !${t.trim()}`); ty += 32; }
      }
    }

    return [...header, ...wireLines, ...flagLines, ...symbolLines, ...dataflagLines, ...directiveLines].join("\n");
  }
}
