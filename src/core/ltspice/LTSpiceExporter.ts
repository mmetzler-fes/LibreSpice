import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import type { PortType } from "@core/components/special/Special.js";
import {
  CENTER, TYPE_TO_SYMBOL, GROUND_PIN, rotStr, offsetsForNode, nodeToSymbol, centeringFor,
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

/**
 * The SYMATTR lines that carry a component's parameters. LTSpice splits them:
 * the waveform/value in `Value`, the small-signal AC magnitude in `Value2`, and
 * a source's parasitics in `SpiceLine` (`Rser=… Cpar=…`). `LibreSpice` is our
 * own attribute for state LTSpice has no slot for (currently only display
 * flags); LTSpice ignores attributes it doesn't know.
 */
interface SymAttrs { value?: string; value2?: string; spiceLine?: string; extra?: string }

/** LTSpice source spec. Same fields as the netlist, but LTSpice spells it SINE, not SIN. */
function sourceSpec(c: any): string {
  if (c.rawSpec) return String(c.rawSpec).replace(/^(\s*)sin(?=\s*\()/i, "$1SINE");
  // SINE's Ncycles is an LTSpice-only 7th field; ngspice's SIN takes six. It is
  // persisted in the LibreSpice attribute instead, so re-importing our own file
  // doesn't smuggle a 7th field into the netlist via the verbatim rawSpec.
  if (c.sourceType === "Sine") {
    return `SINE(${c.sOffset} ${c.sAmpl} ${c.sFreq} ${c.sTd} ${c.sTheta} ${c.sPhi})`;
  }
  if (c.sourceType === "Pulse") {
    const ncyc = c.pNp > 0 ? ` ${c.pNp}` : "";
    return `PULSE(${c.pV1} ${c.pV2} ${c.pTd} ${c.pTr} ${c.pTf} ${c.pPw} ${c.pPer}${ncyc})`;
  }
  return `DC ${c.dcValue ?? 0}`;
}

/**
 * A library part / `.subckt` instance. `Value` names the subcircuit (LTSpice's
 * own convention), and the external pin order — which the `.asc` has no slot for
 * — goes into our attribute, so the handles are rebuilt exactly. The subcircuit
 * *body* is not embedded: like LTSpice, the file references the model by name
 * and it is re-linked from the loaded library (see circuitStore.loadFromASC).
 */
function subcircuitAttrs(comp: any, data: { subName?: string; pins?: string[]; label: string }): SymAttrs {
  const subckt =
    data.subName ||
    String(comp?.spiceModel ?? "").match(/\.subckt\s+(\S+)/i)?.[1] ||
    "";
  const pins = data.pins ?? comp?.portNames ?? [];
  return {
    ...(subckt ? { value: subckt } : {}),
    ...(pins.length ? { extra: `pins=${pins.join(",")}` } : {}),
  };
}

/**
 * Every parameter a component holds, as `.asc` attributes — so a saved file can
 * rebuild it exactly. Previously only a bare number (or a 3-field SINE) was
 * written, which silently dropped the source type, phase, AC amplitude,
 * parasitics and semiconductor model on every save.
 */
function symbolAttrs(comp: any, type: ComponentType, fallback: string): SymAttrs {
  if (!comp) return { value: fallback };
  if (comp.valueExpr) return { value: comp.valueExpr };

  // Legacy import-only source types (a plain 3-/7-field waveform, no AC or
  // parasitics); the generalized V/I source below is what the editor places.
  if (type === "sinesource") {
    return { value: comp.rawSpec ? sourceSpec(comp) : `SINE(${comp.offset} ${comp.amplitude} ${comp.frequency})` };
  }
  if (type === "pulsesource") {
    return {
      value: comp.rawSpec ? sourceSpec(comp)
        : `PULSE(${comp.initialValue} ${comp.pulsedValue} ${comp.delay} ${comp.riseTime} ${comp.fallTime} ${comp.pulseWidth} ${comp.period})`,
    };
  }

  if (comp.sourceType !== undefined) {
    const a: SymAttrs = { value: sourceSpec(comp) };
    if (comp.acAmplitude) a.value2 = `AC ${comp.acAmplitude}`;
    const par: string[] = [];
    if (comp.seriesR > 0) par.push(`Rser=${comp.seriesR}`);
    if (comp.parallelC > 0) par.push(`Cpar=${comp.parallelC}`);
    if (par.length) a.spiceLine = par.join(" ");
    const extra: string[] = [];
    if (comp.showParasitics === "yes") extra.push("showParasitics=yes");
    if (comp.sourceType === "Sine" && comp.sNcycles > 0) extra.push(`sNcycles=${comp.sNcycles}`);
    if (extra.length) a.extra = extra.join(";");
    return a;
  }

  // Semiconductors and the op-amp carry a model name instead of a value.
  if (typeof comp.model === "string") {
    return { value: comp.model, ...(comp.color ? { extra: `color=${comp.color}` } : {}) };
  }
  if (comp.resistance !== undefined) return { value: String(comp.resistance) };
  if (comp.capacitance !== undefined) return { value: String(comp.capacitance) };
  if (comp.inductance !== undefined) return { value: String(comp.inductance) };
  if (comp.dcValue !== undefined) return { value: String(comp.dcValue) };
  return { value: fallback };
}

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

/** Point at parametric position `t` (0..1 of total length) along a polyline —
 *  mirrors WireTool.pointAtT, kept local so `core` needn't import the editor. */
function dockPoint(verts: Pt[], t: number): Pt {
  if (verts.length === 0) return { x: 0, y: 0 };
  if (verts.length === 1) return verts[0];
  let total = 0;
  for (let i = 0; i < verts.length - 1; i++) total += Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
  if (total === 0) return verts[0];
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < verts.length - 1; i++) {
    const segLen = Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
    if (target <= segLen || i === verts.length - 2) {
      const f = segLen === 0 ? 0 : target / segLen;
      return { x: verts[i].x + (verts[i + 1].x - verts[i].x) * f, y: verts[i].y + (verts[i + 1].y - verts[i].y) * f };
    }
    target -= segLen;
  }
  return verts[verts.length - 1];
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
        /** Horizontally flipped about the symbol origin → LTSpice's `M` prefix. */
        mirrored?: boolean;
        labelOffset?: { x: number; y: number }; valueOffset?: { x: number; y: number };
        /** Net-connector direction → the LTSpice IOPIN that follows its FLAG. */
        portType?: PortType;
        /** Library part / `.subckt`: its own `.asy` symbol, subcircuit name and pin order. */
        symbolName?: string; subName?: string; pins?: string[];
        /** The SYMBOL name this component was imported under (see LTSpiceParser). */
        ascSymbol?: string;
      };

      if (data.componentType === "ground") {
        const fx = Math.round(node.position.x + GROUND_PIN.dx);
        const fy = Math.round(node.position.y + GROUND_PIN.dy);
        flagLines.push(`FLAG ${fx} ${fy} 0`);
        pinCoord.set(`${node.id}-${GROUND_PIN.handle}`, { x: fx, y: fy });
        continue;
      }

      // Net label → LTSpice `FLAG x y name` at its single pin. A net connector
      // writes the same FLAG plus the `IOPIN x y In|Out|BiDir` line LTSpice pairs
      // with it, exactly as it stores a flag whose Port Type is set. Port type
      // `None` is a bare FLAG — LTSpice writes no IOPIN for it either, so such a
      // connector round-trips back as a plain net label.
      if (data.componentType === "netlabel" || data.componentType === "netconnector") {
        const fx = Math.round(node.position.x + CENTER);
        const fy = Math.round(node.position.y + CENTER);
        const fallback = data.componentType === "netconnector" ? "PORT" : "NET";
        flagLines.push(`FLAG ${fx} ${fy} ${String(data.label ?? fallback).trim() || fallback}`);
        const portType = data.componentType === "netconnector" ? data.portType ?? "BiDir" : "None";
        if (portType !== "None") flagLines.push(`IOPIN ${fx} ${fy} ${portType}`);
        pinCoord.set(`${node.id}-t`, { x: fx, y: fy });
        continue;
      }

      const deg = data.rotation ?? 0;
      const mirrored = !!data.mirrored;
      // A library part / `.subckt` has no fixed symbol: it carries its own `.asy`
      // name and pin list. Writing it as "res" (the old fallback) turned it into
      // a resistor on reload and dropped every wire attached to it.
      const isSub = data.componentType === "subcircuit";
      const subSymbol = data.symbolName || data.subName || data.label;
      const rotated = offsetsForNode(data.componentType, deg, data.pins, isSub ? subSymbol : undefined, mirrored);
      const { x: symX, y: symY } = nodeToSymbol(node.position.x, node.position.y, rotated, centeringFor(data.componentType));
      for (const p of rotated) pinCoord.set(`${node.id}-${p.handle}`, { x: symX + p.dx, y: symY + p.dy });

      // Keep the symbol the file was imported with (the IEC/European set, a
      // localized variant, …); only a freshly placed part falls back to the
      // default symbol for its type.
      const symName = isSub ? subSymbol : (data.ascSymbol || TYPE_TO_SYMBOL[data.componentType] || "res");
      symbolLines.push(`SYMBOL ${symName} ${symX} ${symY} ${rotStr(deg, mirrored)}`);

      // Persist caption positions so LTSpice (and our own re-import) keep them.
      const lw = winCoord(LABEL_DEFAULT, data.labelOffset);
      symbolLines.push(`WINDOW 0 ${lw.x} ${lw.y} Right 2`);
      if (data.valueLabel) {
        const vw = winCoord(VALUE_DEFAULT, data.valueOffset);
        symbolLines.push(`WINDOW 3 ${vw.x} ${vw.y} Right 2`);
      }

      symbolLines.push(`SYMATTR InstName ${data.label}`);

      const attrs = isSub
        ? subcircuitAttrs(circuit.components.get(node.id), data)
        : symbolAttrs(circuit.components.get(node.id), data.componentType, data.valueLabel || "");
      if (attrs.value) symbolLines.push(`SYMATTR Value ${attrs.value}`);
      if (attrs.value2) symbolLines.push(`SYMATTR Value2 ${attrs.value2}`);
      if (attrs.spiceLine) symbolLines.push(`SYMATTR SpiceLine ${attrs.spiceLine}`);
      if (attrs.extra) symbolLines.push(`SYMATTR LibreSpice ${attrs.extra}`);
    }

    // Wires: route each edge through its stored waypoints (the original path
    // from import), made orthogonal, so re-importing matches the pins back to
    // these wires and rebuilds the same nets. Following the waypoints keeps the
    // route off other terminals — a naive L-bend can cross a neighbouring pin.
    // Overlapping edges (a tap, a wire re-drawn over another) yield the very same
    // segment twice. Emit each one once — duplicates piled up with every save, so
    // the file grew on every round-trip.
    const wireSeen = new Set<string>();
    const wireLines: string[] = [];
    for (const edge of edges) {
      const a = pinCoord.get(`${edge.source}-${edge.sourceHandle}`);
      const b = pinCoord.get(`${edge.target}-${edge.targetHandle}`);
      if (!a || !b) continue;
      const wps = ((edge.data?.waypoints as Pt[] | undefined) ?? []).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      // A wire imported along a diagonal LTSpice segment keeps its exact path:
      // orthogonalising it would insert a right-angle leg that can overlap a
      // neighbouring net's leg and merge the two on re-import (see LTSpiceParser).
      const verts = edge.data?.diagonal ? [a, ...wps, b] : orthoVertices([a, ...wps, b]);
      for (let i = 0; i < verts.length - 1; i++) {
        const p = verts[i], q = verts[i + 1];
        if (p.x === q.x && p.y === q.y) continue;
        // A segment and its reverse are the same wire.
        const fwd = `${p.x} ${p.y} ${q.x} ${q.y}`, rev = `${q.x} ${q.y} ${p.x} ${p.y}`;
        if (wireSeen.has(fwd) || wireSeen.has(rev)) continue;
        wireSeen.add(fwd);
        wireLines.push(`WIRE ${fwd}`);
      }
    }

    // Wire-carried net *names* (the editor's `visible` label on a wire) → a
    // `FLAG` at the label's dock point. LTSpice has no notion of a label owned by
    // a wire, so this is its faithful representation: a flag sitting on the wire.
    // Ports are not wire attributes here — a net connector is its own node and
    // wrote its FLAG/IOPIN above. Records the net so the named-net fallback below
    // doesn't add a second flag for it.
    const labelledNets = new Set<string>();
    for (const node of nodes) {
      const t = (node.data as { componentType?: ComponentType }).componentType;
      if (t !== "netlabel" && t !== "netconnector") continue;
      const netId = circuit?.components?.get(node.id)?.ports?.[0]?.netId;
      if (netId) labelledNets.add(netId);
    }
    if (circuit?.nets) {
      for (const edge of edges) {
        const d = edge.data as { showLabel?: boolean; labelT?: number; waypoints?: Pt[] } | undefined;
        if (!d?.showLabel) continue;
        const netId = circuit.components.get(edge.source)?.ports?.find((p: { id: string; netId?: string }) => p.id === `${edge.source}-${edge.sourceHandle}`)?.netId;
        if (!netId || netId === "0" || labelledNets.has(netId)) continue;
        const rawName = circuit.nets.get(netId)?.nodeLabel;
        const name = (rawName ?? netId).trim();
        if (!name) continue;
        const a = pinCoord.get(`${edge.source}-${edge.sourceHandle}`);
        const b = pinCoord.get(`${edge.target}-${edge.targetHandle}`);
        if (!a || !b) continue;
        const wps = (d.waypoints ?? []).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
        const dock = dockPoint(orthoVertices([a, ...wps, b]), typeof d.labelT === "number" ? d.labelT : 0.5);
        flagLines.push(`FLAG ${Math.round(dock.x)} ${Math.round(dock.y)} ${name}`);
        labelledNets.add(netId);
      }
    }

    // Named nets → FLAGs, for a net whose name is *not* already carried by a
    // net-label terminal or a wire label (both wrote their own FLAG above).
    // Emitting one here as well gave every labelled net two flags, and each
    // save/load cycle stacked another label on the same spot — the file grew and
    // the schematic collected invisible duplicates.
    if (circuit?.nets) {
      for (const [netId, net] of circuit.nets as Map<string, { nodeLabel: string; connectedPortIds: Set<string> }>) {
        if (netId === "0" || net.nodeLabel === netId || labelledNets.has(netId)) continue;
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
