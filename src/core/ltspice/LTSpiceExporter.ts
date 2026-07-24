import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import type { PortType } from "@core/components/special/Special.js";
import {
  CENTER, TYPE_TO_SYMBOL, GROUND_PIN, rotStr, offsetsForNode, nodeToSymbol, centeringFor,
} from "./ltspiceGeometry.js";
import { outwardAxis, type Axis } from "@core/geometry/ortho.js";
import { wireRoutes, type PinLookup } from "@core/geometry/wireRoutes.js";
import { encodeTextBox, TEXT_SIZE_DEFAULT, type TextBox } from "@core/circuit/textBox.js";
import { formatSheetShape, type SheetShape } from "@core/circuit/sheetShape.js";
import { sameAttrValue, shiftWindowLine, formatEng, type AscRaw, type AscPreserved } from "./ascPreserve.js";
import { formatAnchor, formatBusTap } from "@core/circuit/netAnchor.js";

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
  // Instance parameters go back where they came from: `SpiceLine`, LTSpice's own
  // slot for the trailing `name=value` list on an `X` line.
  const params = String(comp?.params ?? "").trim();
  return {
    ...(subckt ? { value: subckt } : {}),
    ...(params ? { spiceLine: params } : {}),
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

/**
 * Split a wire segment at every flag lying strictly inside it, returning the
 * pieces in order. Reproduces LTSpice's own convention — it stores a wire that
 * passes under a `FLAG` as two wires meeting at the flag's coordinate — so a
 * name lying on a wire still writes the same lines the file was read with.
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
    // Names first: each anchor is a `FLAG`, plus the `IOPIN` a connector's
    // direction rides on. This is the whole of the file's naming — there is no
    // second source any more, so nothing here has to be reconciled with
    // something else that might also have written the name.
    const flagLines: string[] = (preserved.anchors ?? []).flatMap(formatAnchor);
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

      // A junction is a place where wires meet, not a part: it writes no line at
      // all. It exists so a wire whose end is on no pin is still an ordinary
      // edge (see Junction), and the wire itself carries the coordinate into the
      // file — which is exactly the `WIRE` line the junction was made from.
      if (data.componentType === "junction") {
        const jx = Math.round(node.position.x + CENTER);
        const jy = Math.round(node.position.y + CENTER);
        pinCoord.set(`${node.id}-j`, { x: jx, y: jy });
        continue;
      }

      // Ground is the one name that is also a part, so its flag comes from the
      // node. Every other name is an anchor and was written above.
      if (data.componentType === "ground") {
        const fx = Math.round(node.position.x + GROUND_PIN.dx);
        const fy = Math.round(node.position.y + GROUND_PIN.dy);
        flagLines.push(`FLAG ${fx} ${fy} 0`);
        pinCoord.set(`${node.id}-${GROUND_PIN.handle}`, { x: fx, y: fy });
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
    // Nothing has to be taken *out* of the routes any more. A name used to be a
    // node with a pin, so a label dropped on a wire arrived as two edges meeting
    // at it, and the exporter had to splice it back out or dragging the label
    // bent the wire (moving `U1` in 06-2-2_RC_HP1 by 40px turned a straight wire
    // into a diagonal). An anchor is not in the topology at all, so the wire it
    // names is simply the wire that was drawn.
    // Pins measured in LTSpice symbol space — *not* the canvas's `getNodePins`,
    // which differs by a few pixels (see wireRoutes for why that matters).
    const symbolPins: PinLookup = {
      at: (nodeId, handle) => pinCoord.get(`${nodeId}-${handle}`),
      axis: (nodeId, handle) => pinAxis.get(`${nodeId}-${handle}`),
    };

    // Flag coordinates, used to break wires the way LTSpice does.
    const flagPoints: Pt[] = flagLines
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[0] === "FLAG")
      .map((p) => ({ x: parseInt(p[1], 10), y: parseInt(p[2], 10) }))
      .filter((p) => !isNaN(p.x) && !isNaN(p.y));

    const wireSeen = new Set<string>();
    const wireLines: string[] = [];
    for (const { verts } of wireRoutes(edges, symbolPins)) {
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

    // Bus taps sit with the flags: both are marks at a place, and LTSpice writes
    // them in the same block above the symbols.
    const busTapLines = (preserved.busTaps ?? []).map(formatBusTap);

    const dataflagLines = dataFlags.map((df) => `DATAFLAG ${Math.round(df.x)} ${Math.round(df.y)} "${df.expr}"`);

    // Text boxes go out as LTSpice sheet comments, so a file written here still
    // reads there — and a comment written there comes back as a text box.
    const textBoxLines = textBoxes.map(
      (t) => `TEXT ${Math.round(t.x)} ${Math.round(t.y)} ${t.justify ?? "Left"} ${t.size ?? TEXT_SIZE_DEFAULT} ;${encodeTextBox(t)}`,
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

    return [...header, ...wireLines, ...busTapLines, ...flagLines, ...symbolLines, ...dataflagLines, ...directiveLines, ...textBoxLines,
      ...sheetShapes.map(formatSheetShape)].join("\n");
  }
}
