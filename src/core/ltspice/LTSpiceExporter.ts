import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import type { PortType } from "@core/components/special/Special.js";
import {
  CENTER, TYPE_TO_SYMBOL, GROUND_PIN, rotStr, offsetsForNode, nodeToSymbol, centeringFor,
} from "./ltspiceGeometry.js";
import { outwardAxis, type Axis } from "@core/geometry/ortho.js";
import { wireRoutes, routeOf, type PinLookup } from "@core/geometry/wireRoutes.js";
import { encodeTextBox, type TextBox } from "@core/circuit/textBox.js";
import { formatSheetShape, type SheetShape } from "@core/circuit/sheetShape.js";
import { sameAttrValue, shiftWindowLine, formatEng, type AscRaw, type AscPreserved } from "./ascPreserve.js";

// Default caption anchors (node-local px) — must match ComponentNode and the
// LTSpiceParser so that a zero offset maps to our default layout and the
// WINDOW round-trip is exact.


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
  if (c.sourceType === "PWL") {
    return `PWL(${String(c.pwlPoints ?? "").trim()})`;
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

  // A logic gate: LTSpice has no notion of a variable-input behavioural gate,
  // so the gate kind picks the closest Digital symbol and everything that
  // defines its behaviour goes into our own attribute.
  if (comp.gateType !== undefined) {
    const pins = comp.ports.map((p: any) => p.name).join(",");
    const extra = [
      `gate=${comp.gateType}`, `inputs=${comp.inputs}`,
      `vth=${comp.threshold}`, `vhigh=${comp.vHigh}`, `pins=${pins}`,
    ].join(";");
    return { value: String(comp.gateType).toUpperCase(), extra };
  }

  // A D flip-flop, likewise: LTSpice's `dflop` symbol carries no polarity, so
  // trigger edge, set/reset sense and the levels ride in our own attribute.
  if (type === "dff") {
    const pins = comp.ports.map((p: any) => p.name).join(",");
    const extra = [
      `kind=${comp.kind}`, `edge=${comp.edge}`, `async=${comp.asyncPolarity}`,
      `vth=${comp.threshold}`, `vhigh=${comp.vHigh}`, `pins=${pins}`,
    ].join(";");
    const mark = { dff: "DFF", tff: "TFF", dlatch: "DLATCH" }[String(comp.kind)] ?? "DFF";
    return { value: comp.kind === "dlatch" ? mark : `${mark}${comp.edge === "falling" ? "-" : "+"}`, extra };
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
  // Engineering notation, not `String(number)`: a capacitance held as 1e-7 was
  // written out as `1.0000000000000001e-7`, which LTSpice renders literally and
  // which no longer reads as the `100nF` the file was authored with. An unedited
  // value never reaches this point at all — the exporter hands back the original
  // attribute line (see ascPreserve.sameAttrValue).
  if (comp.resistance !== undefined) return { value: formatEng(comp.resistance) };
  if (comp.capacitance !== undefined) return { value: formatEng(comp.capacitance) };
  if (comp.inductance !== undefined) return { value: formatEng(comp.inductance) };
  if (comp.dcValue !== undefined) return { value: formatEng(comp.dcValue) };
  return { value: fallback };
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

/**
 * Wire routes with the pass-through net labels taken out of them.
 *
 * A net label / net connector is a node with one pin here, so a label dropped
 * onto an existing wire is imported as *two* edges — part → label, label → part
 * — and the label's coordinate becomes a wire endpoint. That is not what the
 * label means, and not what LTSpice stores: there a `FLAG` is a free-standing
 * marker and the wire runs on unbroken underneath. The consequence was that
 * nudging a label bent the wire it named.
 *
 * So a label is spliced out when it sits *on* the route between its two
 * neighbours: the two edges become one neighbour-to-neighbour route carrying
 * both edges' waypoints, and the label's own position leaves the path. It still
 * gets its `FLAG` at wherever the user put it.
 *
 * The test is geometric, not a count of edges. Two edges alone means nothing
 * here: the importer wires each net as a star from its first pin, so a label
 * terminating a stub (`U2` in 06-2-2_RC_HP1, a connector hanging off the R/C
 * junction) also has two. Splicing that one deleted its wire outright. Only a
 * label whose removal leaves the wire's shape intact is a pass-through; one that
 * is the end of the wire stays an endpoint, exactly as in LTSpice, and moving it
 * is meant to move the wire.
 */
function spliceAnnotations(nodes: Node[], edges: Edge[], pins: PinLookup): Edge[] {
  const annot = new Set(
    nodes
      .filter((n) => {
        const t = (n.data as { componentType?: ComponentType }).componentType;
        return t === "netlabel" || t === "netconnector";
      })
      .map((n) => n.id),
  );
  if (annot.size === 0) return edges;

  // Keyed by id and rebuilt at the end: splicing an array while iterating other
  // labels' indices into it is how a second label on the same net gets merged
  // into the wrong wire.
  const byId = new Map(edges.map((e) => [e.id, e]));
  for (const id of annot) {
    const inc = [...byId.values()].filter((e) => e.source === id || e.target === id);
    // Only a label *between* two things is a pass-through. One edge means it
    // terminates the wire; more than two means it is a junction, where removing
    // it would silently rewire the net.
    if (inc.length !== 2) continue;
    const [p, q] = [{ e: inc[0] }, { e: inc[1] }];
    // Orient both away from the label so the waypoints join up in path order.
    const far = (e: Edge) => (e.source === id
      ? { node: e.target, handle: e.targetHandle, flip: true }
      : { node: e.source, handle: e.sourceHandle, flip: false });
    const A = far(p.e), B = far(q.e);
    if (!A.node || !B.node) continue;
    const wps = (e: Edge, flip: boolean) => {
      const w = ((e.data?.waypoints as Pt[] | undefined) ?? []).slice();
      return flip ? w : w.reverse();
    };
    const merged: Edge = {
      ...p.e,
      id: `${p.e.id}+${q.e.id}`,
      source: A.node, sourceHandle: A.handle,
      target: B.node, targetHandle: B.handle,
      data: {
        ...p.e.data,
        // A → (A-side waypoints) → (B-side waypoints) → B, with the label's own
        // coordinate deliberately absent.
        waypoints: [...wps(p.e, !A.flip), ...wps(q.e, B.flip)],
        diagonal: !!(p.e.data?.diagonal || q.e.data?.diagonal),
        sourceTap: A.flip ? p.e.data?.targetTap : p.e.data?.sourceTap,
        targetTap: B.flip ? q.e.data?.targetTap : q.e.data?.sourceTap,
      },
    };

    // Is this label a marker *on* a wire, or the end of one?
    //
    // For an imported label the file already answered that (`ascPassThrough`,
    // set by the parser from the wire directions around the flag), and that
    // answer is kept however far the user then drags the label — which is the
    // whole point: moving a mid-wire label must not reshape its wire.
    //
    // A freshly placed label has no such record, so fall back to geometry: it is
    // a pass-through only while it actually lies on the route between its two
    // neighbours. The tolerance is deliberately under one grid step, so a label
    // on a stub is not mistaken for one on the wire.
    const marked = (nodes.find((n) => n.id === id)?.data as { ascPassThrough?: boolean })?.ascPassThrough;
    if (marked === false) continue;
    if (marked === undefined) {
      const label = pins.at(id, "t");
      const ca = pins.at(A.node, A.handle), cb = pins.at(B.node, B.handle);
      if (!label || !ca || !cb) continue;
      const verts = routeOf(merged, ca, cb, pins);
      if (!projectsInside(label, verts, 6)) continue;
    }

    byId.delete(q.e.id);
    byId.set(p.e.id, merged);
  }
  return [...byId.values()];
}

/**
 * Does `p` sit *along* the polyline `verts` rather than beyond one of its ends?
 *
 * Interiority, not distance, is what separates a label marking a wire from a
 * label terminating one. `UA2` in OP-nicht_inv_Verstärker hangs off a 16px stub
 * past a junction: it is only one grid step from the route, so any tolerance
 * loose enough to be useful also swallows it — and splicing it deleted its wire.
 * Its nearest point on the route is the route's *endpoint*; a genuine mid-wire
 * label's is not. Measured along the whole polyline's arc length, so a label
 * sitting exactly on an interior corner still counts as interior.
 *
 * The distance tolerance stays generous on top of that: a label may be dropped
 * near its wire rather than exactly on it, which is what lets the user move one
 * without the wire following.
 */
function projectsInside(p: Pt, verts: Pt[], tol = 16, endEps = 4): boolean {
  let best = Infinity, bestS = 0, run = 0, total = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    total += Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
  }
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    if (d < best) { best = d; bestS = run + t * len; }
    run += len;
  }
  return best <= tol && bestS > endEps && bestS < total - endEps;
}

/**
 * Split a wire segment at every flag lying strictly inside it, returning the
 * pieces in order. Reproduces LTSpice's own convention — it stores a wire that
 * passes under a `FLAG` as two wires meeting at the flag's coordinate — so a
 * label spliced out of the routing (see {@link spliceAnnotations}) still writes
 * the same lines the file was read with.
 */
function splitAtFlags(p: Pt, q: Pt, flags: Pt[]): [Pt, Pt][] {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [];
  const on = flags
    .map((f) => ({ f, t: ((f.x - p.x) * dx + (f.y - p.y) * dy) / len2 }))
    // Strictly interior, and actually *on* the line rather than merely beside it.
    .filter(({ f, t }) => t > 1e-9 && t < 1 - 1e-9 &&
      Math.abs((f.x - p.x) * dy - (f.y - p.y) * dx) < 1e-6 * Math.sqrt(len2))
    .sort((a, b) => a.t - b.t);
  const pts = [p, ...on.map(({ f }) => f), q];
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].x !== pts[i + 1].x || pts[i].y !== pts[i + 1].y) segs.push([pts[i], pts[i + 1]]);
  }
  return segs;
}

export class LTSpiceExporter {
  static export(nodes: Node[], edges: Edge[], directives: string, circuit: any, dataFlags: DataFlag[] = [], textBoxes: TextBox[] = [], sheetShapes: SheetShape[] = [], preserved: AscPreserved = {}): string {
    const directiveRaw = preserved.directiveRaw ?? [];
    // The file's own header, not a fixed one: hardcoding `Version 4` downgraded
    // every 4.1 file, and hardcoding `SHEET 1 880 680` shrank the sheet of any
    // schematic drawn larger, leaving parts outside the page in LTSpice.
    const header = [
      preserved.header?.["Version"] ?? "Version 4",
      preserved.header?.["SHEET"] ?? "SHEET 1 880 680",
    ];
    const symbolLines: string[] = [];
    const flagLines: string[] = [];
    // Pin coordinates in LTSpice space, keyed by port id `${compId}-${handle}`,
    // so wires and net-label flags attach exactly to the terminals.
    const pinCoord = new Map<string, Pt>();
    // Which way each pin faces, so a wire leaves the symbol squarely instead of
    // running along its flank — the same routing the canvas draws.
    const pinAxis = new Map<string, Axis>();

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
        /** The `WINDOW`/`SYMATTR` lines this component was imported with, kept
         *  verbatim so an unchanged value is written back exactly (ascPreserve). */
        ascRaw?: AscRaw;
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
      const pts = rotated.map((p) => ({ x: symX + p.dx, y: symY + p.dy }));
      rotated.forEach((p, i) => {
        pinCoord.set(`${node.id}-${p.handle}`, pts[i]);
        const ax = outwardAxis(pts[i], pts);
        if (ax) pinAxis.set(`${node.id}-${p.handle}`, ax);
      });

      // Keep the symbol the file was imported with (the IEC/European set, a
      // localized variant, …); only a freshly placed part falls back to the
      // default symbol for its type.
      // Pick the Digital symbol matching the gate so the file also *looks*
      // right in LTSpice; the behaviour is restored from our own attribute.
      const gateSym = data.componentType === "logicgate"
        ? `Digital\\${({ not: "inv", buffer: "buf" } as Record<string, string>)[String((data as { gateType?: string }).gateType)] ?? String((data as { gateType?: string }).gateType ?? "and")}`
        : null;
      const symName = isSub ? subSymbol : (gateSym || data.ascSymbol || TYPE_TO_SYMBOL[data.componentType] || "res");
      symbolLines.push(`SYMBOL ${symName} ${symX} ${symY} ${rotStr(deg, mirrored)}`);

      // ── Caption windows ────────────────────────────────────────────────────
      // Never invent a WINDOW. LTSpice stores caption positions in the symbol's
      // own frame and rotates them — justification included — with the part, and
      // a symbol with no WINDOW line simply uses the defaults from its `.asy`.
      // The exporter used to write `WINDOW 0/3 … Right 2` for *every* symbol in
      // our own coordinate convention, which stacked every caption of a file onto
      // one line and turned the captions of a rotated part vertical. Original
      // lines are handed back untouched, all window ids included: `WINDOW 123`
      // (Value2) and `WINDOW 39` (SpiceLine) have no counterpart in our model and
      // were being dropped outright.
      const rawWin = (data.ascRaw?.windows ?? {}) as Record<number, string>;
      const dragged = (o?: { x: number; y: number }) => !!o && (o.x !== 0 || o.y !== 0);
      const drag: Record<number, { x: number; y: number } | undefined> = {
        0: dragged(data.labelOffset) ? data.labelOffset : undefined,
        3: dragged(data.valueOffset) ? data.valueOffset : undefined,
      };
      for (const [idStr, rawLine] of Object.entries(rawWin)) {
        const d = drag[Number(idStr)];
        // A caption the user has dragged moves its *existing* line by the drag
        // delta, so the file keeps its justification and its symbol-local frame.
        symbolLines.push((d && shiftWindowLine(rawLine, d.x, d.y, deg, mirrored)) || rawLine);
      }
      // A caption dragged on a symbol the file gave no WINDOW line for has no
      // anchor to shift: LTSpice's default caption spot lives in the `.asy`, not
      // in our model, so any coordinate we synthesised would be a guess and would
      // move the caption in LTSpice rather than leave it alone. The drag is still
      // kept in our own snapshot format; only the `.asc` stays silent about it.

      symbolLines.push(`SYMATTR InstName ${data.label}`);

      const attrs = isSub
        ? subcircuitAttrs(circuit.components.get(node.id), data)
        : symbolAttrs(circuit.components.get(node.id), data.componentType, data.valueLabel || "");

      // ── Attributes ─────────────────────────────────────────────────────────
      // Hand back the file's own spelling whenever it still encodes the value we
      // hold (`100nF` vs `1e-7`, `15.915k` vs `15915`, `AC 1V` vs `AC 1`, `""` vs
      // `DC 0`), and only write a fresh line where the value genuinely changed.
      // `pristine` means this component still carries the attribute set the file
      // gave it — no property has been edited since (updateComponentProperty drops
      // it). An attribute the file left out is then left out again: LTSpice fills
      // it from the symbol's own default, and writing our value for it changed 31
      // op-amps across the examples from "no Value" to `SYMATTR Value level2`.
      const rawAttrs = (data.ascRaw?.attrs ?? {}) as Record<string, string>;
      const pristine = !!data.ascRaw?.attrs;
      const emit = (name: string, generated: string) => {
        const r = rawAttrs[name];
        if (r === undefined) {
          // Absent from a pristine file → keep it absent. On an edited or freshly
          // placed part there is nothing to preserve, so write what we hold.
          if (!pristine) symbolLines.push(`SYMATTR ${name} ${generated}`);
          return;
        }
        // The file's spelling wins while it still encodes what we hold. If the
        // two genuinely disagree, the model is authoritative — that is the
        // fallback for any edit path that failed to clear `pristine`, and it
        // errs towards a file that matches what the user sees on screen.
        symbolLines.push(`SYMATTR ${name} ${sameAttrValue(r, generated) ? r : generated}`);
      };
      if (attrs.value) emit("Value", attrs.value);
      if (attrs.value2) emit("Value2", attrs.value2);
      if (attrs.spiceLine) emit("SpiceLine", attrs.spiceLine);
      if (attrs.extra) emit("LibreSpice", attrs.extra);
      // An attribute we decline to generate but the file carried is kept, as long
      // as it still says what we hold. A source with `Rser=0` is the common case:
      // we skip a zero parasitic, so the line would vanish from a file that had
      // it. `sameAttrValue` is what stops this from resurrecting a value the user
      // has since cleared — that compares unequal and the line stays dropped.
      for (const [name, gen] of [["Value", attrs.value], ["Value2", attrs.value2], ["SpiceLine", attrs.spiceLine]] as const) {
        if (!gen && rawAttrs[name] !== undefined && sameAttrValue(rawAttrs[name], "")) {
          symbolLines.push(`SYMATTR ${name} ${rawAttrs[name]}`);
        }
      }
      // Anything else the file carried (`SpiceLine2`, `ModelFile`, `Description`,
      // a manufacturer part number …). We have no model for these, which is
      // precisely why they must survive a save rather than be silently discarded.
      const written = new Set(["InstName", "Value", "Value2", "SpiceLine", "LibreSpice"]);
      for (const [name, val] of Object.entries(rawAttrs)) {
        if (!written.has(name)) symbolLines.push(`SYMATTR ${name} ${val}`);
      }
    }

    // Wires: route each edge through its stored waypoints (the original path
    // from import), made orthogonal, so re-importing matches the pins back to
    // these wires and rebuilds the same nets. Following the waypoints keeps the
    // route off other terminals — a naive L-bend can cross a neighbouring pin.
    // Overlapping edges (a tap, a wire re-drawn over another) yield the very same
    // segment twice. Emit each one once — duplicates piled up with every save, so
    // the file grew on every round-trip.
    //
    // A net label sitting *on* a wire is spliced out of the route first: in
    // LTSpice a `FLAG` is a marker at a coordinate that happens to touch a wire,
    // not a joint in it. Our model gives the label a pin and wires the two
    // neighbours to it, so dragging the label used to drag the wire's endpoint
    // with it — moving `U1` in 06-2-2_RC_HP1 by 40px turned a straight wire into
    // a diagonal. Routing neighbour-to-neighbour and letting the flag land on the
    // result keeps the label free to move anywhere along (or near) the wire
    // without touching it.
    // Pins measured in LTSpice symbol space — *not* the canvas's `getNodePins`,
    // which differs by a few pixels (see wireRoutes for why that matters).
    const symbolPins: PinLookup = {
      at: (nodeId, handle) => pinCoord.get(`${nodeId}-${handle}`),
      axis: (nodeId, handle) => pinAxis.get(`${nodeId}-${handle}`),
    };

    const routes = spliceAnnotations(nodes, edges, symbolPins);
    // Flag coordinates written so far (grounds, net labels, connectors), used to
    // break wires the way LTSpice does. Wire *labels* are placed further down —
    // they are docked onto a wire that already exists, so they cannot split it.
    const flagPoints: Pt[] = flagLines
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[0] === "FLAG")
      .map((p) => ({ x: parseInt(p[1], 10), y: parseInt(p[2], 10) }))
      .filter((p) => !isNaN(p.x) && !isNaN(p.y));

    const wireSeen = new Set<string>();
    const wireLines: string[] = [];
    for (const { verts } of wireRoutes(routes, symbolPins)) {
      for (let i = 0; i < verts.length - 1; i++) {
        const p = verts[i], q = verts[i + 1];
        if (p.x === q.x && p.y === q.y) continue;
        // Break the segment wherever a flag sits on it. LTSpice stores a wire
        // under a `FLAG` as two wires meeting at the flag, and reproducing that
        // is what lets a label be spliced out of the route above and still come
        // back as the same file — the label marks the split, it no longer bends
        // the wire.
        for (const [s, t] of splitAtFlags(p, q, flagPoints)) {
          // A segment and its reverse are the same wire.
          const fwd = `${s.x} ${s.y} ${t.x} ${t.y}`, rev = `${t.x} ${t.y} ${s.x} ${s.y}`;
          if (wireSeen.has(fwd) || wireSeen.has(rev)) continue;
          wireSeen.add(fwd);
          wireLines.push(`WIRE ${fwd}`);
        }
      }
    }

    // Segments the edge model never held (see LTSpiceParser.orphanWires): a stub
    // ending in mid-air, a spur. They go back out exactly as they came in, and
    // through the same dedupe, so one that a re-route has since covered isn't
    // written twice.
    for (const raw of preserved.orphanWires ?? []) {
      const m = raw.trim().match(/^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/i);
      if (!m) continue;
      const [x1, y1, x2, y2] = m.slice(1, 5);
      const fwd = `${x1} ${y1} ${x2} ${y2}`, rev = `${x2} ${y2} ${x1} ${y1}`;
      if (wireSeen.has(fwd) || wireSeen.has(rev)) continue;
      wireSeen.add(fwd);
      wireLines.push(`WIRE ${fwd}`);
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
        const dock = dockPoint(routeOf(edge, a, b, symbolPins), typeof d.labelT === "number" ? d.labelT : 0.5);
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

    // Text boxes go out as LTSpice sheet comments, so a file written here still
    // reads there — and a comment written there comes back as a text box.
    const textBoxLines = textBoxes.map(
      (t) => `TEXT ${Math.round(t.x)} ${Math.round(t.y)} Left 2 ;${encodeTextBox(t)}`,
    );

    // Directives keep the position and spelling they had in the source file. The
    // old layout put every directive at a hardcoded (10, 100 + 32i), so merely
    // opening and saving a schematic dragged its directives across the sheet and
    // normalised `.ac dec 100 1 1MEGHz` into `.ac DEC 100 1 1MEG`. Only a
    // directive that is new or edited gets a generated line, placed below the
    // ones already on the sheet so it doesn't land on top of them.
    // A single `TEXT` can carry several directives separated by literal `\n`
    // (LTSpice's own multi-line directive box). The store flattens those into
    // separate lines, so match the *whole block* first — otherwise a three-line
    // `.param`/`.step`/`.op` box was torn into three separate text boxes strewn
    // down the sheet on every save.
    const rawByText = new Map(directiveRaw.map((d) => [d.text.trim(), d.raw]));
    const maxBlockLines = Math.max(1, ...directiveRaw.map((d) => d.text.split("\n").length));
    const directiveLines: string[] = [];
    if (directives) {
      const used = [...rawByText.values()]
        .map((l) => parseInt(l.trim().split(/\s+/)[2] ?? "", 10))
        .filter((n) => !isNaN(n));
      let ty = used.length ? Math.max(...used) + 32 : 100;
      // An *edited* directive keeps the position of the one it replaces, matched
      // by its leading keyword (`.ac`, `.tran`, …). Changing `.ac dec 100 …` to
      // `.ac oct 50 …` should move the text, not the text box.
      const rawByKind = new Map<string, string>();
      for (const d of directiveRaw) {
        const kind = d.text.trim().split(/\s+/)[0]?.toLowerCase();
        if (kind && !rawByKind.has(kind)) rawByKind.set(kind, d.raw);
      }
      const reused = new Set<string>();
      const pending = directives.split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < pending.length; i++) {
        // Greedily re-form the longest run of consecutive directives that came
        // from one `TEXT` line, so the box is written back as the single line it
        // was rather than exploded into one box per directive.
        // Bounded by the longest block the file actually had — an inline
        // `.SUBCKT` can run to well over a hundred lines (see LM317), and a fixed
        // cap tore the tail of it into one text box per line down the sheet.
        let block: string | undefined, span = 0;
        for (let n = Math.min(pending.length - i, maxBlockLines); n >= 1; n--) {
          const joined = pending.slice(i, i + n).join("\n");
          if (rawByText.has(joined)) { block = joined; span = n; break; }
        }
        if (block) { directiveLines.push(rawByText.get(block)!); reused.add(rawByText.get(block)!); i += span - 1; continue; }
        const text = pending[i];
        const kind = text.split(/\s+/)[0]?.toLowerCase();
        const sameKind = kind ? rawByKind.get(kind) : undefined;
        const pos = sameKind && !reused.has(sameKind)
          ? sameKind.trim().match(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)/i)
          : null;
        if (pos && sameKind) {
          directiveLines.push(`TEXT ${pos[1]} ${pos[2]} ${pos[3]} ${pos[4]} !${text}`);
          reused.add(sameKind);
        } else { directiveLines.push(`TEXT 10 ${ty} Left 2 !${text}`); ty += 32; }
      }
    }

    return [...header, ...wireLines, ...flagLines, ...symbolLines, ...dataflagLines, ...directiveLines, ...textBoxLines,
      ...sheetShapes.map(formatSheetShape)].join("\n");
  }
}
