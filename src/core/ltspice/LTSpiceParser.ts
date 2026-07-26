import type { Node, Edge } from "@xyflow/react";
import { createSpiceComponent, createSubcircuitComponent, getValueLabel } from "@editor/componentFactory.js";
import { getNodePins } from "@editor/pinGeometry.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import { symbolToType, CENTER, GROUND_PIN, parseRot, offsetsForNode, symbolToNode, centeringFor } from "./ltspiceGeometry.js";
import { symbolByName } from "@sym/asyParser.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { PORT_TYPES, type PortType } from "@core/components/special/Special.js";
import { decodeTextBox, asJustification, type TextBox } from "@core/circuit/textBox.js";
import type { AscRaw, DirectiveRaw } from "./ascPreserve.js";
import { parseBusTap, type NetAnchor, type BusTap } from "@core/circuit/netAnchor.js";
import { parseSheetShape, type SheetShape } from "@core/circuit/sheetShape.js";


/** Decimal exponent of an SI/SPICE suffix (`meg`=6, `m`=-3, `r`/unknown=0). */
function siExp(suffix: string): number {
  const s = suffix.trim().toLowerCase();
  if (s.startsWith("meg")) return 6;
  if (s.startsWith("g")) return 9;
  if (s.startsWith("t")) return 12;
  if (s.startsWith("k")) return 3;
  if (s.startsWith("m")) return -3;
  if (s.startsWith("u") || s.startsWith("µ")) return -6;
  if (s.startsWith("n")) return -9;
  if (s.startsWith("p")) return -12;
  if (s.startsWith("f")) return -15;
  return 0;
}

/**
 * Apply an SI suffix by *composing the exponent into the literal* rather than
 * multiplying by a power of ten. `100 * 1e-9` is 1.0000000000000001e-7 in
 * binary floating point, so `100n` and `1e-7` — the same capacitance — parsed to
 * different numbers, and a save/load cycle drifted the value it displayed.
 * `Number("100e-9")` is exactly 1e-7.
 */
function applySI(mantissa: string, suffix: string): number {
  const exp = siExp(suffix);
  if (exp === 0) return Number(mantissa) || 0;
  // A literal that already carries an exponent can't take a second one
  // (`1e-7` + `n` would read as `1e-7e-9`), so that rare case still multiplies.
  const n = /[eE]/.test(mantissa)
    ? Number(mantissa) * Math.pow(10, exp)
    : Number(`${mantissa}e${exp}`);
  return isNaN(n) ? 0 : n;
}

function parseSI(val: string): number {
  if (!val) return 0;
  const t = val.trim();
  // European R/L/C notation using the SI letter as the decimal point:
  // 4R7 = 4.7Ω, 1k5 = 1500, 1k591 = 1591, 2m2 = 2.2m. ("e" is excluded so a
  // scientific literal like 1e3 is not mistaken for this form.)
  const infix = t.match(/^(\d+)(meg|[rpnuµmkgtf])(\d+)$/i);
  if (infix) return applySI(`${infix[1]}.${infix[3]}`, infix[2]);
  // The leading numeric literal, kept as text so the exponent can be folded in.
  const m = t.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!m) return 0;
  return applySI(m[0], t.slice(m[0].length));
}

/**
 * Numeric value of a source's main attribute, e.g. `5`, `DC 5`, `DC 5 AC 1`.
 * A bare parseSI would read "DC 5" as NaN→0 and lose the DC level.
 */
function parseDC(val: string): number {
  const m = val.replace(/\bAC\b.*$/i, "").match(/[-+]?[\d.]+(?:e[-+]?\d+)?\s*[a-zµ]*/i);
  return m ? parseSI(m[0]) : 0;
}

/**
 * `hasOwnProperty` through the prototype rather than off the object itself. The
 * components tested here are built from file input, so calling the method on the
 * instance would break on a schematic that happens to define an attribute of
 * that name.
 */
const owns = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

interface Wire { x1: number; y1: number; x2: number; y2: number; netId?: number }
interface Pin { compId: string; handle: string; x: number; y: number; netId?: number }

export class LTSpiceParser {
  static parse(content: string, opts: { idStart?: number } = {}): { nodes: Node[]; edges: Edge[]; directives: string; components: SpiceComponent[]; dataFlags: DataFlag[]; textBoxes: TextBox[]; sheetShapes: SheetShape[]; directiveRaw: DirectiveRaw[]; header: Record<string, string>; anchors: NetAnchor[]; busTaps: BusTap[] } {
    const lines = content.split(/\r?\n/);
    const nodes: Node[] = [];
    const components: SpiceComponent[] = [];
    const wires: Wire[] = [];
    const pins: Pin[] = [];
    const dataFlags: DataFlag[] = [];
    const textBoxes: TextBox[] = [];
    const sheetShapes: SheetShape[] = [];
    /** Flags already imported, keyed x,y,name — see the FLAG handler. */
    const seenFlags = new Set<string>();
    /** IOPIN coordinates ("x,y") → port type: a FLAG at one of these is a connector. */
    const iopinCoords = new Map<string, PortType>();
    let directives = "";
    /** Directive `TEXT` lines kept verbatim, so an unedited one is written back
     *  at its original position and spelling (see ascPreserve.ts). */
    const directiveRaw: DirectiveRaw[] = [];
    /** The file's `Version` / `SHEET` lines, written back as-is. */
    const header: Record<string, string> = {};
    /**
     * Every named `FLAG` as what it is: a name at a coordinate (see netAnchor).
     * These replace the net-label nodes the parser used to build — the anchors
     * were proven to reproduce every `FLAG`/`IOPIN` line across all 91 bundled
     * schematics before the switch. Ground is the exception and stays a part.
     */
    const anchors: NetAnchor[] = [];
    /** Bus taps, kept so a file that has one does not lose it on save. */
    const busTaps: BusTap[] = [];

    let currentSymbol: any = null;
    // Where the generated ids start. A paste parses its fragment into a store
    // that already holds `comp_1`…, so it passes a watermark above those to keep
    // the new parts distinct. The `comp_`/`ground_`/`netlabel_` prefixes stay put
    // — several places key behaviour off them (see isNetTerminalId).
    let compIdCounter = opts.idStart ?? 1;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0];

      if (cmd === "SYMBOL") {
        if (currentSymbol) {
          LTSpiceParser.finalizeSymbol(currentSymbol, nodes, components, pins);
        }
        currentSymbol = {
          name: parts[1],
          x: parseInt(parts[2], 10),
          y: parseInt(parts[3], 10),
          rot: parts[4] || "R0",
          attrs: {} as Record<string, string>,
          windows: {} as Record<number, { x: number; y: number }>,
          // Verbatim `WINDOW` lines, keyed by window id. Kept as *text* rather
          // than parsed numbers because that is exactly what we hand back on
          // export: LTSpice's caption geometry (symbol-local frame, per-symbol
          // defaults, justification that rotates with the part) is not our
          // caption geometry, so anything we re-derive is a guess. See
          // ascPreserve.ts for why passthrough beats re-generation here.
          rawWindows: {} as Record<number, string>,
          id: `comp_${compIdCounter++}`
        };
      } else if (cmd === "WINDOW") {
        if (currentSymbol) {
          const pid = parseInt(parts[1], 10);
          const wx = parseInt(parts[2], 10);
          const wy = parseInt(parts[3], 10);
          if (!isNaN(pid) && !isNaN(wx) && !isNaN(wy)) {
            currentSymbol.windows[pid] = { x: wx, y: wy };
            currentSymbol.rawWindows[pid] = line.trim();
          }
        }
      } else if (cmd === "SYMATTR") {
        if (currentSymbol) {
          const attrName = parts[1];
          const attrVal = parts.slice(2).join(" ");
          currentSymbol.attrs[attrName] = attrVal;
        }
      } else if (cmd === "FLAG") {
        const x = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        const flagName = parts[3];
        // The same flag at the same point is redundant — and files written by
        // older builds collected stacked copies (the exporter wrote one per label
        // *and* one per named net). Import each spot once, or the schematic keeps
        // invisible duplicates piled on top of each other.
        const flagKey = `${x},${y},${flagName}`;
        if (seenFlags.has(flagKey)) continue;
        seenFlags.add(flagKey);
        // Ground is excluded: it comes back as a component below, and its flag is
        // derived from that node again on export. An anchor here as well would
        // write the `FLAG x y 0` line twice.
        if (!isNaN(x) && !isNaN(y) && flagName && flagName !== "0") {
          anchors.push({ id: `anchor_${anchors.length + 1}`, x, y, name: flagName });
        }

        if (flagName === "0") {
          // Ground is the one flag that stays a part. In the file it is a flag
          // named `0` like any other, but on our sheet it is a drawn symbol with
          // a pin that the netlist connects to node 0 — so it is imported as the
          // component it is, and its anchor is derived back from the node on
          // export (see anchorsFromNodes).
          const id = `ground_${compIdCounter++}`;
          const gx = x - GROUND_PIN.dx, gy = y - GROUND_PIN.dy;
          const comp = createSpiceComponent("ground", id, "0", gx, gy);
          components.push(comp);
          // Offset the node by the ground symbol's pin offset so the rendered
          // terminal lands exactly on the LTSpice flag coordinate.
          nodes.push({ id, type: "component", position: { x: gx, y: gy }, data: { componentType: "ground", label: "0" } });
          pins.push({ compId: id, handle: "gnd", x, y });
        }
        // Every other named flag is *only* the anchor pushed above: a name at a
        // point, with no node, no pin and no edge. Which net it names is decided
        // by what lies under it (see anchorNets), the same way LTSpice decides it
        // — and unlike the terminal node this replaces, it cannot drag a wire
        // along when it is moved, because it is not part of the topology.
      } else if (cmd === "BUSTAP") {
        const t = parseBusTap(line, `bustap_${busTaps.length + 1}`);
        if (t) busTaps.push(t);
      } else if (cmd === "IOPIN") {
        // `IOPIN x y {In|Out|BiDir}` — pairs with the FLAG at the same point and
        // turns it into a net connector, the direction naming the port type. A
        // FLAG with no IOPIN is a plain net label (LTSpice's "Port Type: None").
        const x = parseInt(parts[1], 10), y = parseInt(parts[2], 10);
        const dir = PORT_TYPES.find((t) => t.toLowerCase() === (parts[3] ?? "").toLowerCase());
        if (!isNaN(x) && !isNaN(y)) iopinCoords.set(`${x},${y}`, dir && dir !== "None" ? dir : "BiDir");
      } else if (cmd === "WIRE") {
        wires.push({
          x1: parseInt(parts[1], 10), y1: parseInt(parts[2], 10),
          x2: parseInt(parts[3], 10), y2: parseInt(parts[4], 10)
        });
      } else if (cmd === "RECTANGLE" || cmd === "CIRCLE" || (cmd === "LINE" && !currentSymbol)) {
        // Sheet drawings — a frame, a divider, a ring around a part. Dropped
        // until now, so a file that carried one lost it on the next save.
        const shape = parseSheetShape(line, `shape_${sheetShapes.length + 1}`);
        if (shape) sheetShapes.push(shape);
      } else if (cmd === "TEXT") {
        // A comment TEXT becomes a text box. These used to be dropped on the
        // floor, which quietly discarded the exercise texts every converted
        // Multisim schematic carries.
        // The justification keyword and the size index are the text's own, not
        // ours to choose: writing every comment back as `Left 2` set a file's
        // sideways captions upright and shrank its headings to the default.
        const comment = line.match(/TEXT\s+(-?\d+)\s+(-?\d+)\s+(\w+)\s+(\d+)\s+;(.*)/i);
        if (comment) {
          textBoxes.push(decodeTextBox(
            comment[5], `tb_${textBoxes.length + 1}`,
            parseInt(comment[1], 10), parseInt(comment[2], 10),
            asJustification(comment[3]), parseInt(comment[4], 10),
          ));
        }
        const textMatch = line.match(/TEXT\s+-?\d+\s+-?\d+\s+\w+\s+\d+\s+!(.*)/i);
        if (textMatch) {
          // LTSpice stores a multi-line directive TEXT as one physical line with
          // literal "\n" separators (e.g. three chained .meas). Turn them into
          // real newlines so each directive is its own line in the netlist.
          const body = textMatch[1].replace(/\\n/g, "\n").trim();
          directives += body + "\n";
          // Keep the whole `TEXT` line verbatim, keyed by the directive text it
          // carries. The exporter used to lay every directive out at a hardcoded
          // (10, 100 + 32i), which shoved a file's directives across the sheet on
          // the first save; an unedited directive now goes back where it was, in
          // the spelling it had (`.ac dec … 1MEGHz`, not `.ac DEC … 1MEG`).
          directiveRaw.push({ text: body, raw: line.trim() });
        }
      } else if (cmd === "Version" || cmd === "SHEET") {
        // The file's own header. It used to be hardcoded to `Version 4` /
        // `SHEET 1 880 680` on export, which downgraded every `Version 4.1` file
        // and shrank the sheet of every schematic drawn larger than the default —
        // parts outside 880x680 then sat off-sheet in LTSpice.
        header[cmd] = line.trim();
      } else if (cmd === "DATAFLAG") {
        // DATAFLAG x y "expression" — a positioned data-point readout.
        const m = line.match(/DATAFLAG\s+(-?\d+)\s+(-?\d+)\s+"([^"]*)"/i);
        if (m) {
          dataFlags.push({ id: `df_${dataFlags.length + 1}`, x: parseInt(m[1], 10), y: parseInt(m[2], 10), expr: m[3] });
        }
      }
    }
    if (currentSymbol) {
      LTSpiceParser.finalizeSymbol(currentSymbol, nodes, components, pins);
    }

    // A named FLAG that coincides with an IOPIN is a net connector, not a plain
    // label — the direction is the only difference between them, which is why a
    // connector is an anchor with a `portType` rather than a second kind of
    // thing. IOPIN may follow its FLAG, so this is resolved once the whole file
    // is read.
    for (const a of anchors) {
      const portType = iopinCoords.get(`${a.x},${a.y}`);
      if (portType) a.portType = portType;
    }

    /** How close a pin has to be to a wire to count as sitting on it. Tight: a
     *  loose one lets a pin latch onto an adjacent wire one grid step away and
     *  short unrelated nodes. */
    const PIN_TOL = 8;

    /** Distance from a point to a wire segment. */
    const distToSegment = (px: number, py: number, w: Wire) => {
      const l2 = (w.x2 - w.x1) ** 2 + (w.y2 - w.y1) ** 2;
      if (l2 === 0) return Math.sqrt((px - w.x1) ** 2 + (py - w.y1) ** 2);
      let t = ((px - w.x1) * (w.x2 - w.x1) + (py - w.y1) * (w.y2 - w.y1)) / l2;
      t = Math.max(0, Math.min(1, t));
      const projX = w.x1 + t * (w.x2 - w.x1);
      const projY = w.y1 + t * (w.y2 - w.y1);
      return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
    };

    // ── A pin for every wire end that has none ─────────────────────────────
    // Our wires are edges between two pins, which is what makes them follow the
    // parts they are drawn to: an edge references the pin, not a coordinate. A
    // `.asc` wire has no such notion — it is four numbers, and it may end
    // somewhere that is no pin at all. The stub between a part and a net name is
    // exactly that, and there are hundreds of them.
    //
    // Those segments used to be set aside as raw geometry that nothing could
    // draw, select or move. A junction is the missing pin: put one at each free
    // end and every wire is an ordinary edge again, so there is one kind of wire
    // instead of two with two implementations of everything a wire can do.
    //
    // Only true *ends* get one. A corner or a T-junction is already carried by a
    // route's waypoints; turning those into junctions too would chop every bent
    // wire into a chain of edges and change what the file round-trips to.
    {
      const key = (x: number, y: number) => `${x},${y}`;
      /** How many wire ends land on each point. */
      const endCount = new Map<string, number>();
      for (const w of wires) {
        for (const k of [key(w.x1, w.y1), key(w.x2, w.y2)]) endCount.set(k, (endCount.get(k) ?? 0) + 1);
      }
      /** Does another wire *run through* this point rather than end on it? */
      const passedThrough = (x: number, y: number) => wires.some((w) => {
        if ((w.x1 === x && w.y1 === y) || (w.x2 === x && w.y2 === y)) return false;
        return distToSegment(x, y, w) <= 0.5;
      });

      for (const [k, n] of endCount) {
        if (n !== 1) continue;                       // several ends meet: a joint, not a free end
        const [x, y] = k.split(",").map(Number);
        if (passedThrough(x, y)) continue;           // sits on another wire: a tap
        // A pin already there is the binding we were looking for.
        if (pins.some((p) => Math.hypot(p.x - x, p.y - y) <= PIN_TOL)) continue;

        const id = `junction_${compIdCounter++}`;
        const jx = x - CENTER, jy = y - CENTER;
        components.push(createSpiceComponent("junction", id, "", jx, jy));
        nodes.push({ id, type: "component", position: { x: jx, y: jy }, data: { componentType: "junction", label: "" } });
        pins.push({ compId: id, handle: "j", x, y });
      }
    }

    // Assign Nets using simple distance-based Union-Find
    let nextNetId = 1;


    const isPointOnWire = (px: number, py: number, w: Wire, tolerance: number = 0) => {
      return distToSegment(px, py, w) <= tolerance;
    };

    // First assign each wire a unique net
    for (const w of wires) w.netId = nextNetId++;
    
    // Merge intersecting wires
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < wires.length; i++) {
        for (let j = i + 1; j < wires.length; j++) {
          if (wires[i].netId !== wires[j].netId) {
            if (isPointOnWire(wires[i].x1, wires[i].y1, wires[j]) ||
                isPointOnWire(wires[i].x2, wires[i].y2, wires[j]) ||
                isPointOnWire(wires[j].x1, wires[j].y1, wires[i]) ||
                isPointOnWire(wires[j].x2, wires[j].y2, wires[i])) {
              const oldId = wires[j].netId;
              for (const w of wires) if (w.netId === oldId) w.netId = wires[i].netId;
              changed = true;
            }
          }
        }
      }
    }

    // Assign pins to nets. Pins now sit exactly on wire endpoints (distance 0),
    // so a tight tolerance is enough — a loose one lets a pin latch onto an
    // adjacent wire one grid step away and short unrelated nodes.
    for (const p of pins) {
      let bestDist = Infinity;
      let bestNetId: number | undefined;
      for (const w of wires) {
        const d = distToSegment(p.x, p.y, w);
        if (d <= PIN_TOL && d < bestDist) {
          bestDist = d;
          bestNetId = w.netId;
        }
      }
      p.netId = bestNetId || nextNetId++;
    }

    // Fuse pins that share the same point but aren't bridged by a wire. LTSpice
    // connects a terminal, ground or net-label flag dropped directly onto
    // another pin (no wire in between); the wire-only assignment above leaves
    // each on its own net, which e.g. left a supply source with both terminals
    // floating to ground and ngspice reporting a "shorted VSRC".
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        if (pins[i].netId === pins[j].netId) continue;
        if (Math.hypot(pins[i].x - pins[j].x, pins[i].y - pins[j].y) <= PIN_TOL) {
          const oldId = pins[j].netId;
          const newId = pins[i].netId;
          for (const p of pins) if (p.netId === oldId) p.netId = newId;
        }
      }
    }

    // ── Faithful wire routing ──────────────────────────────────────────────
    // Reconstruct the original LTSpice wire paths so imported wires follow the
    // source layout instead of being re-routed straight pin-to-pin. Build a
    // graph of wire vertices (endpoints / T-junctions), then route each pin
    // pair along the shortest path through it, using interior junctions as
    // waypoints.

    // Rendered pin centres in flow coords, keyed `${compId}|${handle}`.
    const pinCenters = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      for (const gp of getNodePins(n)) pinCenters.set(`${gp.nodeId}|${gp.handleId}`, { x: gp.x, y: gp.y });
    }

    // Graph vertices = every wire endpoint (shared endpoints form junctions).
    const vKey = (x: number, y: number) => `${x},${y}`;
    const vCoord = new Map<string, { x: number; y: number }>();
    const adj = new Map<string, Set<string>>();
    const addV = (x: number, y: number) => {
      const k = vKey(x, y);
      if (!vCoord.has(k)) { vCoord.set(k, { x, y }); adj.set(k, new Set()); }
    };
    for (const w of wires) { addV(w.x1, w.y1); addV(w.x2, w.y2); }
    // Split every wire at all vertices lying on it and link neighbours in order.
    for (const w of wires) {
      const on = [...vCoord.values()].filter((v) => distToSegment(v.x, v.y, w) <= 0.5);
      const horiz = Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1);
      on.sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      for (let i = 0; i < on.length - 1; i++) {
        const a = vKey(on[i].x, on[i].y), b = vKey(on[i + 1].x, on[i + 1].y);
        if (a !== b) { adj.get(a)!.add(b); adj.get(b)!.add(a); }
      }
    }
    const vertexForPin = (p: Pin): string | undefined => {
      let best: string | undefined, bestD = PIN_TOL;
      for (const [k, v] of vCoord) {
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d <= bestD) { bestD = d; best = k; }
      }
      return best;
    };
    const bfsPath = (start: string, goal: string): string[] | null => {
      const prev = new Map<string, string>([[start, start]]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === goal) break;
        for (const nb of adj.get(cur) ?? []) {
          if (prev.has(nb)) continue;
          prev.set(nb, cur);
          queue.push(nb);
        }
      }
      if (!prev.has(goal)) return null;
      const path = [goal];
      let c = goal;
      while (c !== start) { c = prev.get(c)!; path.push(c); }
      return path.reverse();
    };

    // Build edges from nets, routing each pin pair along the wire graph.
    const edges: Edge[] = [];
    let edgeCounter = 1;
    const nets = new Map<number, Pin[]>();
    for (const p of pins) {
      if (!p.netId) continue;
      if (!nets.has(p.netId)) nets.set(p.netId, []);
      nets.get(p.netId)!.push(p);
    }

    /** Graph links some pin-to-pin route runs along, keyed "a|b" (both ways). */
    const usedLinks = new Set<string>();
    const markPath = (path: string[]) => {
      for (let i = 0; i < path.length - 1; i++) {
        usedLinks.add(`${path[i]}|${path[i + 1]}`);
        usedLinks.add(`${path[i + 1]}|${path[i]}`);
      }
    };

    for (const netPins of nets.values()) {
      if (netPins.length < 2) continue;

      // Each pin is wired to its *nearest* one already on the net, not all of
      // them to the first — a spanning tree rather than a star.
      //
      // The difference only shows once a part is dragged and the wires re-route:
      // as a star, every pin's wire runs the whole way back to whichever pin the
      // file happened to list first, so three resistors on a rail come out as
      // three long parallel runs across the sheet instead of one rail with short
      // branches. Nearest is measured along the drawn wiring, so the tree follows
      // the shape the schematic was drawn in; pins the drawing does not join (they
      // share a net *name*) fall back to plain distance.
      const reach = new Map<Pin, { dist: Map<string, number>; prev: Map<string, string> }>();
      const walkFrom = (p: Pin) => {
        let r = reach.get(p);
        if (r) return r;
        const v = vertexForPin(p);
        r = { dist: new Map(), prev: new Map() };
        if (v) {
          r.dist.set(v, 0);
          r.prev.set(v, v);
          const queue = [v];
          while (queue.length) {
            const cur = queue.shift()!;
            for (const nb of adj.get(cur) ?? []) {
              if (r.dist.has(nb)) continue;
              const a = vCoord.get(cur)!, b = vCoord.get(nb)!;
              r.dist.set(nb, r.dist.get(cur)! + Math.hypot(b.x - a.x, b.y - a.y));
              r.prev.set(nb, cur);
              queue.push(nb);
            }
          }
        }
        reach.set(p, r);
        return r;
      };
      /** Wire length between two pins, or plain distance where no wire joins them. */
      const cost = (a: Pin, b: Pin): number => {
        const vb = vertexForPin(b);
        const d = vb === undefined ? undefined : walkFrom(a).dist.get(vb);
        // Unreachable is worse than any drawn path, so the tree prefers wiring
        // that exists; among the unreachable, the closest still wins.
        return d ?? 1e6 + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      };

      const inTree = [netPins[0]];
      const rest = netPins.slice(1);
      while (rest.length) {
        let bi = 0, bj = 0, best = Infinity;
        for (let i = 0; i < inTree.length; i++) {
          for (let j = 0; j < rest.length; j++) {
            const c = cost(inTree[i], rest[j]);
            if (c < best) { best = c; bi = i; bj = j; }
          }
        }
        const p1 = inTree[bi];
        const p2 = rest[bj];
        rest.splice(bj, 1);
        inTree.push(p2);

        const v1 = vertexForPin(p1);
        const c1 = pinCenters.get(`${p1.compId}|${p1.handle}`);
        let waypoints: { x: number; y: number }[] = [];
        const v2 = vertexForPin(p2);
        const path = v1 && v2 ? bfsPath(v1, v2) : null;
        if (path) markPath(path);
        if (path && path.length > 2) {
          const c2 = pinCenters.get(`${p2.compId}|${p2.handle}`);
          // Interior junctions only; drop any sitting on top of an endpoint
          // pin (our terminals can be a few px off the LTSpice pin, which
          // would otherwise leave a tiny hook).
          waypoints = path.slice(1, -1)
            .map((k) => vCoord.get(k)!)
            .filter((v) => (!c1 || Math.hypot(v.x - c1.x, v.y - c1.y) > 12) &&
                           (!c2 || Math.hypot(v.x - c2.x, v.y - c2.y) > 12));
        }
        // Did this route follow a *diagonal* LTSpice wire? Orthogonalising such a
        // segment on export can make two diagonals' right-angle legs overlap and
        // wrongly merge their nets on the next import. Flag it so the exporter
        // writes the diagonal verbatim instead (see LTSpiceExporter).
        //
        // Measured on the *file's* own wire runs, not on the route we
        // reconstruct: our pin centres sit a few px off the LTSpice pin for some
        // parts on purpose (a voltage source's terminals span 64 px on the canvas
        // and 80 in the file), and a route ending on such a pin looks diagonal to
        // a test that includes it. It cost 364 of the 1702 wires in the converted
        // Multisim corpus — every one of them drawn from an axis-aligned pair of
        // WIRE lines, every one frozen as a straight diagonal that no longer
        // re-routed when its part was dragged, because the flag also protects the
        // path from being forgotten (see forgetImportedRoutes).
        //
        // A graph link always runs along one wire, so its two vertices give that
        // wire's direction. Where there is no path at all the pins are joined by
        // name and no wire is involved, which is not a diagonal either.
        let diagonal = false;
        for (let k = 0; path && k < path.length - 1 && !diagonal; k++) {
          const a = vCoord.get(path[k])!, b = vCoord.get(path[k + 1])!;
          if (Math.abs(b.x - a.x) > 4 && Math.abs(b.y - a.y) > 4) diagonal = true;
        }

        edges.push({
          id: `edge_${edgeCounter++}`,
          source: p1.compId,
          sourceHandle: p1.handle,
          target: p2.compId,
          targetHandle: p2.handle,
          type: "wire",
          // `autoRoute` marks a path that came from the source drawing rather
          // than from the user. Such a path is worth keeping as long as the
          // layout is the one the file described — but once a part moves it is
          // a detour around where that part used to be, so the wire is allowed
          // to re-route itself straight (see dropImportedRoutes). A wire the
          // user has hand-routed carries no such flag and is never touched.
          data: diagonal
            ? { waypoints, diagonal: true }
            : { waypoints, ...(waypoints.length > 0 ? { autoRoute: true } : {}) },
        });
      }
    }

    // ── Which net labels sit *on* a wire rather than at its end ────────────
    // The exporter needs this to know whether a label may be spliced out of a
    // wire's route (see LTSpiceExporter.spliceAnnotations). It cannot be
    // re-derived from geometry later: a label 16px off the route may be a
    // terminal on a one-grid-step stub (`UA2` in OP-nicht_inv_Verstärker, whose
    // stub splicing deleted) or a mid-wire label the user has nudged aside, and
    // the two look identical. The source file distinguishes them — a pass-through
    // flag has wire leaving it in two *opposing* directions — so record it here,
    // once, while the file is still in front of us.
    const passThrough = (px: number, py: number): boolean => {
      const dirs: { dx: number; dy: number }[] = [];
      for (const w of wires) {
        if (distToSegment(px, py, w) > 0.5) continue;
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        if (len === 0) continue;
        const ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
        // How far along the segment the flag sits decides which way(s) wire runs
        // away from it; a flag strictly inside one segment already has both.
        const t = ((px - w.x1) * (w.x2 - w.x1) + (py - w.y1) * (w.y2 - w.y1)) / (len * len);
        if (t > 0.001) dirs.push({ dx: -ux, dy: -uy });
        if (t < 0.999) dirs.push({ dx: ux, dy: uy });
      }
      return dirs.some((a) => dirs.some((b) => a.dx * b.dx + a.dy * b.dy < -0.001));
    };
    for (const node of nodes) {
      const d = node.data as { componentType?: string; ascPassThrough?: boolean };
      if (d.componentType !== "netlabel" && d.componentType !== "netconnector") continue;
      d.ascPassThrough = passThrough(node.position.x + CENTER, node.position.y + CENTER);
    }

    // ── The links no route ran along ───────────────────────────────────────
    // Every route above runs from the net's first pin to each of its others, so
    // a link the search never took — a loop, a second path to the same place, a
    // spur — is left over. Electrically it is part of its net already; what it
    // lacks is an edge to be drawn, selected and moved by.
    //
    // It gets one, with a junction at either end that is not already a pin. That
    // is the same answer as for a free end, applied to the last case, and it is
    // what empties this category instead of leaving a rest that behaves
    // differently from every other wire.
    const seenLink = new Set<string>();
    const junctionAt = new Map<string, string>();
    for (const [id, comp] of components.entries()) {
      void id;
      if (comp.id.startsWith("junction_")) junctionAt.set(`${Math.round(comp.position.x + CENTER)},${Math.round(comp.position.y + CENTER)}`, comp.id);
    }
    /** The port at a point: an existing pin, else a junction made for it. */
    const portAt = (x: number, y: number): { compId: string; handle: string } => {
      const pin = pins.find((p) => Math.hypot(p.x - x, p.y - y) <= PIN_TOL);
      if (pin) return { compId: pin.compId, handle: pin.handle };
      const existing = junctionAt.get(`${x},${y}`);
      if (existing) return { compId: existing, handle: "j" };
      const jid = `junction_${compIdCounter++}`;
      const jx = x - CENTER, jy = y - CENTER;
      components.push(createSpiceComponent("junction", jid, "", jx, jy));
      nodes.push({ id: jid, type: "component", position: { x: jx, y: jy }, data: { componentType: "junction", label: "" } });
      pins.push({ compId: jid, handle: "j", x, y });
      junctionAt.set(`${x},${y}`, jid);
      return { compId: jid, handle: "j" };
    };

    for (const [a, nbs] of adj) {
      for (const b of nbs) {
        if (usedLinks.has(`${a}|${b}`) || seenLink.has(`${b}|${a}`)) continue;
        seenLink.add(`${a}|${b}`);
        const p = vCoord.get(a)!, q = vCoord.get(b)!;
        const from = portAt(p.x, p.y), to = portAt(q.x, q.y);
        if (from.compId === to.compId && from.handle === to.handle) continue;
        edges.push({
          id: `edge_${edgeCounter++}`,
          source: from.compId, sourceHandle: from.handle,
          target: to.compId, targetHandle: to.handle,
          type: "wire",
          data: { waypoints: [] },
        });
      }
    }

    // An `IOPIN` may precede or follow its `FLAG`, so the direction is attached
    // once the whole file has been read — the same reason the connector nodes
    // above are promoted at the end.
    for (const a of anchors) {
      const dir = iopinCoords.get(`${a.x},${a.y}`);
      if (dir && dir !== "None") a.portType = dir;
    }

    return { nodes, edges, directives: directives.trim(), components, dataFlags, textBoxes, sheetShapes, directiveRaw, header, anchors, busTaps };
  }

  private static finalizeSymbol(sym: any, nodes: Node[], components: SpiceComponent[], pins: Pin[]) {
    const label = sym.attrs["InstName"] || sym.name;
    // LTSpice writes an empty source value as `""`; treat it as blank.
    let valueStr = (sym.attrs["Value"] || "").trim();
    if (valueStr === '""' || valueStr === "''") valueStr = "";
    // A source's small-signal AC spec lives in a separate attribute
    // (SYMATTR Value2, e.g. "AC 1"), often with the main Value left empty.
    const value2 = (sym.attrs["Value2"] || "").trim();
    // Our own attribute for state the .asc format has no slot for (see the
    // exporter's SymAttrs): `pins=a,b,c`, display flags, SINE Ncycles.
    const lsAttrs: Record<string, string> = {};
    for (const kv of (sym.attrs["LibreSpice"] || "").split(";")) {
      const [k, v] = kv.split("=").map((s: string) => s.trim());
      if (k && v) lsAttrs[k] = v;
    }

    // A library part / `.subckt` has no built-in type: keep it as a subcircuit
    // with its own symbol and pins, so it (and every wire on it) survives. Its
    // pin order comes from our own attribute, or from the `.asy` symbol itself
    // for a file written by LTSpice. Only a symbol that actually declares pins
    // qualifies — an unknown *device* symbol (a stock variant we don't map yet,
    // e.g. `Misc\EuropeanResistor`) has none, and must keep falling back to the
    // 2-pin default rather than becoming a pinless, valueless subcircuit.
    const known = symbolToType(sym.name);
    const symBase = (sym.name.split(/[\\/]/).pop() ?? sym.name) as string;
    const declaredPins =
      lsAttrs.pins?.split(",").map((s) => s.trim()).filter(Boolean) ??
      [...(symbolByName(symBase)?.pins ?? [])].sort((a, b) => a.order - b.order).map((p) => p.name);
    const cType: ComponentType = known ?? (declaredPins.length > 0 ? "subcircuit" : "resistor");
    // A gate needs its pin list as much as a subcircuit does: how many inputs it
    // has decides where they sit (they are spread over a fixed span, so two and
    // four land in different places). Without it every gate was registered as the
    // default two-input one, and a three- or four-input gate's wires met nothing.
    const subPins = cType === "subcircuit" || cType === "logicgate" ? declaredPins : undefined;

    // `R<deg>` / `M<deg>`: a mirrored symbol is flipped horizontally first, then
    // rotated. Dropping the `M` (as we used to) put every pin of a mirrored part
    // on the wrong side, so its wires matched nothing and the net fell apart.
    const { deg, mirrored } = parseRot(sym.rot);

    // Pin registration (LTSpice symbol-local offsets, mirrored then rotated
    // about the origin).
    const rotated = offsetsForNode(cType, deg, subPins, symBase, mirrored);
    for (const p of rotated) {
      pins.push({ compId: sym.id, handle: p.handle, x: sym.x + p.dx, y: sym.y + p.dy });
    }

    // Place the node so its 80px box is centered on the pins' bounding box, so
    // our rendered terminals line up with the pin coordinates the wires use.
    // Otherwise the LTSpice origin (a corner) becomes the center and every pin
    // sits ~16px off, forcing dog-leg wires.
    const { x: nodeX, y: nodeY } = symbolToNode(sym.x, sym.y, rotated, centeringFor(cType));

    // The subcircuit *body* isn't in the .asc — the file references it by name,
    // exactly as LTSpice does. circuitStore re-links it from the loaded library.
    const comp = cType === "subcircuit"
      ? createSubcircuitComponent(sym.id, label, nodeX, nodeY, "", subPins ?? [])
      : createSpiceComponent(cType, sym.id, label, nodeX, nodeY);

    // A library part's instance parameters (`Rtot=10k wiper=0.5`) ride in
    // `SpiceLine`, which is LTSpice's own slot for them and the only place a
    // `.asc` records what a `.subckt` with `params:` was called with. Read as a
    // string, unparsed: these are SPICE expressions, and the netlist line wants
    // them back verbatim. The symbol's own default is *not* substituted here —
    // a file that left the line out gets the subcircuit's declared defaults,
    // which is what LTSpice does too.
    if (cType === "subcircuit") {
      const line = [sym.attrs["SpiceLine"], sym.attrs["SpiceLine2"]].filter(Boolean).join(" ").trim();
      if (line) (comp as any).params = line;
    }

    // Preserve LTSpice waveform specs verbatim (PULSE/SINE/PWL/EXP/SFFM) so
    // `{param}` expressions and unit suffixes survive to the netlist. ngspice
    // uses SIN, not LTSpice's SINE. This takes precedence over the best-effort
    // numeric parsing below (which still fills the UI fields where it can).
    // PWL is excluded: it now has a real source type whose breakpoint list is
    // itself stored verbatim, so it round-trips without `rawSpec` — and unlike
    // `rawSpec`, editing the source in the UI no longer discards the waveform.
    if (/^\s*(sine|sin|pulse|exp|sffm)\b/i.test(valueStr)) {
      (comp as any).rawSpec = valueStr.replace(/^(\s*)sine(?=\s*\()/i, "$1SIN");
    }

    // Parse values
    const c = comp as any;

    // A logic gate carries its behaviour in our own attribute; the Digital
    // symbol name alone cannot say how many inputs it has or where its
    // threshold sits.
    if (cType === "logicgate") {
      if (lsAttrs.gate) c.gateType = lsAttrs.gate;
      if (lsAttrs.inputs) c.inputs = Number(lsAttrs.inputs);
      if (lsAttrs.vth) c.threshold = Number(lsAttrs.vth);
      if (lsAttrs.vhigh) c.vHigh = Number(lsAttrs.vhigh);
      c.rebuildPorts?.();
    }

    // A D flip-flop's symbol says nothing about which edge it triggers on or
    // whether SET/RESET are active low, so those come back from our attribute.
    if (cType === "dff") {
      // Kind first: it renames the data and clock pins, and the `pins=` list
      // read further up has to agree with what the component ends up with.
      if (lsAttrs.kind) { c.kind = lsAttrs.kind; c.rebuildPorts?.(); }
      if (lsAttrs.edge) c.edge = lsAttrs.edge;
      if (lsAttrs.async) c.asyncPolarity = lsAttrs.async;
      if (lsAttrs.vth) c.threshold = Number(lsAttrs.vth);
      if (lsAttrs.vhigh) c.vHigh = Number(lsAttrs.vhigh);
    }
    if (cType === "vsource" || cType === "isource") {
      // Generalized source: waveform kind + every field of its spec, so a phase,
      // delay or damping factor set in LTSpice (or by us on the last save) is
      // still there after the load — and the UI shows the right waveform.
      // PWL carries an arbitrary number of breakpoints, so it is kept as the
      // text between the parentheses rather than parsed into fixed fields —
      // that preserves SI suffixes and `{param}` expressions exactly.
      const pwl = valueStr.match(/^\s*pwl\s*\(([^)]*)\)/i);
      if (pwl) {
        c.sourceType = "PWL";
        // `r=<t>` is ngspice's repeat flag, not a breakpoint. Split it off, or
        // it would sit in the points text and be read as a time/value pair —
        // and the next load from a measurement file would drop it silently.
        const body = pwl[1].trim();
        const rep = body.match(/\s*\br\s*=\s*\S+\s*$/i);
        c.pwlRepeat = !!rep;
        c.pwlPoints = rep ? body.slice(0, rep.index).trim() : body;
      }

      const wave = valueStr.match(/^\s*(sine?|pulse)\s*\(([^)]*)\)/i);
      const f = wave ? wave[2].split(/[\s,]+/).filter(Boolean).map(parseSI) : [];
      if (wave && /^sin/i.test(wave[1])) {
        // SINE(Voffset Vamp Freq Td Theta Phi Ncycles)
        c.sourceType = "Sine";
        if (f[0] !== undefined) c.sOffset = f[0];
        if (f[1] !== undefined) c.sAmpl = f[1];
        if (f[2] !== undefined) c.sFreq = f[2];
        if (f[3] !== undefined) c.sTd = f[3];
        if (f[4] !== undefined) c.sTheta = f[4];
        if (f[5] !== undefined) c.sPhi = f[5];
        if (f[6] !== undefined && c.sNcycles !== undefined) c.sNcycles = f[6];
      } else if (wave && cType === "vsource") {
        // PULSE(V1 V2 Tdelay Trise Tfall Ton Tperiod Ncycles). Read every field —
        // omitting delay/rise/fall left them at their defaults (a 1 ns edge), so a
        // triangle like PULSE(0 10 0 10 10 0 20) collapsed to a 1 ns spike.
        c.sourceType = "Pulse";
        if (f[0] !== undefined) c.pV1 = f[0];
        if (f[1] !== undefined) c.pV2 = f[1];
        if (f[2] !== undefined) c.pTd = f[2];
        if (f[3] !== undefined) c.pTr = f[3];
        if (f[4] !== undefined) c.pTf = f[4];
        if (f[5] !== undefined) c.pPw = f[5];
        if (f[6] !== undefined) c.pPer = f[6];
        if (f[7] !== undefined) c.pNp = f[7];
      } else if (!/\(/.test(valueStr)) {
        // Plain DC level ("5", "DC 5", "DC 5 AC 1"), possibly with only an AC spec.
        c.sourceType = "DC";
        if (valueStr) c.dcValue = parseDC(valueStr);
      }
      // Parasitics: LTSpice keeps them in `SYMATTR SpiceLine Rser=… Cpar=…`.
      const spiceLine = (sym.attrs["SpiceLine"] || "") + " " + (sym.attrs["SpiceLine2"] || "");
      const rser = spiceLine.match(/\bRser\s*=\s*(\S+)/i);
      const cpar = spiceLine.match(/\bCpar\s*=\s*(\S+)/i);
      if (rser && c.seriesR !== undefined) c.seriesR = parseSI(rser[1]);
      if (cpar && c.parallelC !== undefined) c.parallelC = parseSI(cpar[1]);
    } else if (valueStr && owns(comp, "model")) {
      // Semiconductors carry a model name (e.g. a diode's `1N4148`), not a value.
      (comp as any).model = valueStr;
    } else if (valueStr && valueStr.includes("{")) {
      // Parametric value (e.g. `{Cvar}`) — keep verbatim for the netlist so
      // .param/.step can drive it.
      comp.valueExpr = valueStr;
    } else if (!valueStr && cType === "jumper" && owns(comp, "resistance")) {
      // A jumper carries no Value in the file: LTSpice fills it from the symbol
      // when placing, and a schematic drawn there simply has none. Take the
      // symbol's own default so it stays a link and does not become a 1 kOhm
      // resistor in the middle of a wire.
      (comp as any).resistance = 1e-6;
    } else if (valueStr && !valueStr.includes("(")) {
      const num = parseSI(valueStr);
      if (owns(comp, "resistance")) (comp as any).resistance = num;
      if (owns(comp, "capacitance")) (comp as any).capacitance = num;
      if (owns(comp, "inductance")) (comp as any).inductance = num;
      if (owns(comp, "dcValue")) (comp as any).dcValue = num;
    }

    // Small-signal AC magnitude from `AC <mag>` in Value/Value2 (a bare `AC`
    // means unit amplitude in LTSpice). Without this the source has no AC
    // excitation and a `.ac` sweep returns an all-zero response.
    if ((comp as any).acAmplitude !== undefined) {
      const acm = `${valueStr} ${value2}`.match(/\bAC\b\s*([-+0-9.eE]+[a-zµ]*)?/i);
      if (acm) {
        (comp as any).acAmplitude = acm[1] != null ? parseSI(acm[1]) : 1;
        // An AC-only source (empty main Value) is DC 0, not the constructor default.
        if (!valueStr && owns(comp, "dcValue")) (comp as any).dcValue = 0;
      }
    }

    // Apply our own attributes (`pins` is structural and already used above).
    // setProperty drops a verbatim imported spec (a UI edit overrides it), so
    // restore it afterwards — these attributes are not waveform edits.
    const keptSpec = (comp as any).rawSpec;
    for (const [k, v] of Object.entries(lsAttrs)) {
      if (k !== "pins") comp.setProperty(k, v);
    }
    if (keptSpec) (comp as any).rawSpec = keptSpec;

    // Carry the imported orientation into the component, not just into the node
    // data. `rotateComponent` turns the *component's* angle, so while this was
    // left at 0 the first rotation after opening a file ignored the angle the
    // file drew the part at and snapped it to an absolute 270° — an `R90`
    // capacitor jumped a half turn instead of a quarter.
    (comp as { rotation: number }).rotation = deg;

    components.push(comp);

    // On-canvas value caption: the same formatting the editor uses for a
    // component edited in-app, so a saved and reloaded part reads identically.
    // Fall back to the raw attribute (e.g. a model name), then to the AC spec of
    // an AC-only source, so the caption is never rendered blank.
    let displayValue = getValueLabel(comp, cType) || valueStr;
    if (!displayValue && (comp as any).acAmplitude) displayValue = `AC ${(comp as any).acAmplitude}`;

    // Note: LTSpice WINDOW positions are intentionally NOT imported as caption
    // offsets. Their coordinate frame doesn't line up with our native-scale
    // symbol rendering, which pushed labels/values far off the part. Loaded
    // components use the same sensible default caption placement (label above /
    // value below when horizontal, both to the left when vertical) as freshly
    // inserted ones; the user can still drag a caption to reposition it.
    nodes.push({
      id: sym.id,
      type: "component",
      position: { x: nodeX, y: nodeY },
      data: {
        componentType: cType,
        label,
        valueLabel: displayValue,
        rotation: deg,
        ...(mirrored && { mirrored: true }),
        // NOTE: the `WINDOW` lines are deliberately *not* read back into caption
        // offsets. They look like the obvious counterpart to what the exporter
        // writes, but the two do not mean the same thing: our writer measures
        // from *our* default caption spot, while a file from LTSpice (or from the
        // Multisim converter) carries LTSpice's own convention, which differs per
        // symbol. Reading those numbers as offsets from our default threw the
        // captions of every imported schematic across the sheet — measured on
        // 05-2-1_Leistungsanpassung1.asc, where `WINDOW 0 5 56` moved "Ri" by
        // (37, 66) px.
        //
        // Making this work means honouring LTSpice's semantics — a WINDOW is an
        // absolute position relative to the symbol origin, not an offset — which
        // is a change to how captions are laid out, not a line here.
        // The generalized source picks its symbol (DC / sine / pulse) from this.
        ...((comp as any).sourceType !== undefined && { sourceType: (comp as any).sourceType }),
        // The digital parts draw themselves from their properties, so the node
        // needs them at load time too — without this a loaded XOR came back
        // drawn as an AND, and a falling-edge flip-flop with a rising-edge
        // wedge, until some unrelated property edit refreshed the node.
        ...((comp as any).gateType !== undefined && { gateType: (comp as any).gateType, inputs: (comp as any).inputs }),
        ...((comp as any).edge !== undefined && { edge: (comp as any).edge, asyncPolarity: (comp as any).asyncPolarity, kind: (comp as any).kind }),
        // Library part: its handles, its `.asy` symbol and the subcircuit name.
        ...(cType === "subcircuit" && { pins: subPins ?? [], symbolName: symBase, subName: valueStr || symBase }),
        // Remember the symbol the file actually used (e.g. `Misc\EuropeanResistor`
        // for the IEC set), so saving writes it back instead of collapsing every
        // resistor to the US `res` symbol.
        // Kept even when the symbol is *not* one we map (`known` is undefined and
        // the part falls back to a resistor): rewriting `SYMBOL Ureg` as
        // `SYMBOL res` on save replaced the user's part with a resistor in
        // LTSpice too. Falling back for simulation is a guess we have to make;
        // writing that guess into the file is not.
        ascSymbol: sym.name,
        // The lines this symbol was imported with. The exporter writes them back
        // verbatim wherever the value they encode is still current, so opening
        // and saving a file leaves it byte-identical (see ascPreserve.ts).
        ascRaw: { windows: sym.rawWindows, attrs: { ...sym.attrs } } satisfies AscRaw,
      }
    });
  }
}
