import type { Node, Edge } from "@xyflow/react";
import { createSpiceComponent } from "@editor/componentFactory.js";
import { getNodePins } from "@editor/pinGeometry.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import { symbolToType, CENTER, rotDeg, rotatedOffsets, symbolToNode, centeringFor } from "./ltspiceGeometry.js";


/** Multiplier for an SI/SPICE suffix (`meg`=1e6, `m`=milli, `r`/unknown=1). */
function siMult(suffix: string): number {
  const s = suffix.trim().toLowerCase();
  if (s.startsWith("meg")) return 1e6;
  if (s.startsWith("g")) return 1e9;
  if (s.startsWith("t")) return 1e12;
  if (s.startsWith("k")) return 1e3;
  if (s.startsWith("m")) return 1e-3;
  if (s.startsWith("u") || s.startsWith("µ")) return 1e-6;
  if (s.startsWith("n")) return 1e-9;
  if (s.startsWith("p")) return 1e-12;
  if (s.startsWith("f")) return 1e-15;
  return 1;
}

function parseSI(val: string): number {
  if (!val) return 0;
  const t = val.trim();
  // European R/L/C notation using the SI letter as the decimal point:
  // 4R7 = 4.7Ω, 1k5 = 1500, 1k591 = 1591, 2m2 = 2.2m. ("e" is excluded so a
  // scientific literal like 1e3 is not mistaken for this form.)
  const infix = t.match(/^(\d+)(meg|[rpnuµmkgtf])(\d+)$/i);
  if (infix) return parseFloat(`${infix[1]}.${infix[3]}`) * siMult(infix[2]);
  const num = parseFloat(t);
  if (isNaN(num)) return 0;
  return num * siMult(t.replace(/^[-\d.]+/, ""));
}

interface Wire { x1: number; y1: number; x2: number; y2: number; netId?: number }
interface Pin { compId: string; handle: string; x: number; y: number; netId?: number }

export class LTSpiceParser {
  static parse(content: string): { nodes: Node[]; edges: Edge[]; directives: string; components: SpiceComponent[]; dataFlags: DataFlag[]; netNames: { compId: string; handle: string; name: string }[] } {
    const lines = content.split(/\r?\n/);
    const nodes: Node[] = [];
    const components: SpiceComponent[] = [];
    const wires: Wire[] = [];
    const pins: Pin[] = [];
    const dataFlags: DataFlag[] = [];
    // Named-flag positions, so we can also anchor the net name on a real
    // component pin (robust even if the terminal's edge is dropped at runtime).
    const namedFlags: { name: string; x: number; y: number }[] = [];
    let directives = "";
    
    let currentSymbol: any = null;
    let compIdCounter = 1;

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
          id: `comp_${compIdCounter++}`
        };
      } else if (cmd === "WINDOW") {
        if (currentSymbol) {
          const pid = parseInt(parts[1], 10);
          const wx = parseInt(parts[2], 10);
          const wy = parseInt(parts[3], 10);
          if (!isNaN(pid) && !isNaN(wx) && !isNaN(wy)) currentSymbol.windows[pid] = { x: wx, y: wy };
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
        if (flagName === "0") {
          const id = `ground_${compIdCounter++}`;
          const comp = createSpiceComponent("ground", id, "0", x - 40, y - 20);
          components.push(comp);
          // Ground symbol's pin sits at local (40, 20); offset the node so the
          // rendered terminal lands exactly on the LTSpice flag coordinate.
          nodes.push({ id, type: "component", position: { x: x - 40, y: y - 20 }, data: { componentType: "ground", label: "0" } });
          pins.push({ compId: id, handle: "gnd", x, y });
        } else if (flagName) {
          // Named net label (e.g. UB-) → a placeable NetLabel terminal at the
          // flag point. Its single pin sits on the flag coordinate so the wire
          // routing connects it (exactly like ground), and its name is imposed
          // on that net (see SpiceComponent.getNetLabel), so same-named labels
          // collapse to one node.
          const id = `netlabel_${compIdCounter++}`;
          const comp = createSpiceComponent("netlabel", id, flagName, x - CENTER, y - CENTER);
          components.push(comp);
          nodes.push({ id, type: "component", position: { x: x - CENTER, y: y - CENTER }, data: { componentType: "netlabel", label: flagName } });
          pins.push({ compId: id, handle: "t", x, y });
          namedFlags.push({ name: flagName, x, y });
        }
      } else if (cmd === "WIRE") {
        wires.push({
          x1: parseInt(parts[1], 10), y1: parseInt(parts[2], 10),
          x2: parseInt(parts[3], 10), y2: parseInt(parts[4], 10)
        });
      } else if (cmd === "TEXT") {
        const textMatch = line.match(/TEXT\s+-?\d+\s+-?\d+\s+\w+\s+\d+\s+!(.*)/i);
        if (textMatch) {
          directives += textMatch[1].trim() + "\n";
        }
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

    // Assign Nets using simple distance-based Union-Find
    let nextNetId = 1;

    // Helper: Distance from point px,py to line segment w
    const distToSegment = (px: number, py: number, w: Wire) => {
      const l2 = (w.x2 - w.x1) ** 2 + (w.y2 - w.y1) ** 2;
      if (l2 === 0) return Math.sqrt((px - w.x1) ** 2 + (py - w.y1) ** 2);
      let t = ((px - w.x1) * (w.x2 - w.x1) + (py - w.y1) * (w.y2 - w.y1)) / l2;
      t = Math.max(0, Math.min(1, t));
      const projX = w.x1 + t * (w.x2 - w.x1);
      const projY = w.y1 + t * (w.y2 - w.y1);
      return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
    };

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
    const PIN_TOL = 8;
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

    // Named FLAGs are imported as NetLabel terminals (see the FLAG handler). As a
    // robust backup, also resolve each flag to a *real* component pin on its net,
    // so the store can label that net directly — this keeps the naming correct
    // even if the terminal's single edge doesn't survive the initial render.
    const netNames: { compId: string; handle: string; name: string }[] = [];
    for (const nf of namedFlags) {
      let wireNet: number | undefined, best = PIN_TOL;
      for (const w of wires) {
        const d = distToSegment(nf.x, nf.y, w);
        if (d <= best) { best = d; wireNet = w.netId; }
      }
      const rep = pins.find(
        (p) => p.netId !== undefined && p.netId === wireNet && !p.compId.startsWith("netlabel_") && !p.compId.startsWith("ground_"),
      );
      if (rep) netNames.push({ compId: rep.compId, handle: rep.handle, name: nf.name });
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

    for (const netPins of nets.values()) {
      if (netPins.length < 2) continue;
      const p1 = netPins[0];
      const v1 = vertexForPin(p1);
      const c1 = pinCenters.get(`${p1.compId}|${p1.handle}`);
      for (let i = 1; i < netPins.length; i++) {
        const p2 = netPins[i];
        let waypoints: { x: number; y: number }[] = [];
        const v2 = vertexForPin(p2);
        if (v1 && v2) {
          const path = bfsPath(v1, v2);
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
        }
        edges.push({
          id: `edge_${edgeCounter++}`,
          source: p1.compId,
          sourceHandle: p1.handle,
          target: p2.compId,
          targetHandle: p2.handle,
          type: "wire",
          data: { waypoints },
        });
      }
    }

    return { nodes, edges, directives: directives.trim(), components, dataFlags, netNames };
  }

  private static finalizeSymbol(sym: any, nodes: Node[], components: SpiceComponent[], pins: Pin[]) {
    let cType = symbolToType(sym.name) || "resistor";
    const label = sym.attrs["InstName"] || sym.name;
    // LTSpice writes an empty source value as `""`; treat it as blank.
    let valueStr = (sym.attrs["Value"] || "").trim();
    if (valueStr === '""' || valueStr === "''") valueStr = "";
    // A source's small-signal AC spec lives in a separate attribute
    // (SYMATTR Value2, e.g. "AC 1"), often with the main Value left empty.
    const value2 = (sym.attrs["Value2"] || "").trim();

    if (cType === "vsource") {
      if (valueStr.toUpperCase().startsWith("SINE")) cType = "sinesource";
      if (valueStr.toUpperCase().startsWith("PULSE")) cType = "pulsesource";
    }

    const deg = rotDeg(sym.rot);

    // Pin registration (LTSpice symbol-local offsets, rotated about the origin).
    const rotated = rotatedOffsets(cType, deg);
    for (const p of rotated) {
      pins.push({ compId: sym.id, handle: p.handle, x: sym.x + p.dx, y: sym.y + p.dy });
    }

    // Place the node so its 80px box is centered on the pins' bounding box, so
    // our rendered terminals line up with the pin coordinates the wires use.
    // Otherwise the LTSpice origin (a corner) becomes the center and every pin
    // sits ~16px off, forcing dog-leg wires.
    const { x: nodeX, y: nodeY } = symbolToNode(sym.x, sym.y, rotated, centeringFor(cType));

    const comp = createSpiceComponent(cType, sym.id, label, nodeX, nodeY);

    // Preserve LTSpice waveform specs verbatim (PULSE/SINE/PWL/EXP/SFFM) so
    // `{param}` expressions and unit suffixes survive to the netlist. ngspice
    // uses SIN, not LTSpice's SINE. This takes precedence over the best-effort
    // numeric parsing below (which still fills the UI fields where it can).
    if (/^\s*(sine|sin|pulse|pwl|exp|sffm)\b/i.test(valueStr)) {
      (comp as any).rawSpec = valueStr.replace(/^(\s*)sine(?=\s*\()/i, "$1SIN");
    }

    // Parse values
    if (cType === "sinesource") {
      const match = valueStr.match(/SINE\(([^)]+)\)/i);
      if (match) {
        const pVals = match[1].split(/[\s,]+/).map(parseSI);
        if (pVals[0] !== undefined) (comp as any).offset = pVals[0];
        if (pVals[1] !== undefined) (comp as any).amplitude = pVals[1];
        if (pVals[2] !== undefined) (comp as any).frequency = pVals[2];
      }
    } else if (cType === "pulsesource") {
       // Simplistic pulse parser
       const match = valueStr.match(/PULSE\(([^)]+)\)/i);
       if (match) {
         const pVals = match[1].split(/[\s,]+/).map(parseSI);
         if (pVals[0] !== undefined) (comp as any).initialValue = pVals[0];
         if (pVals[1] !== undefined) (comp as any).pulsedValue = pVals[1];
         if (pVals[5] !== undefined) (comp as any).pulseWidth = pVals[5];
         if (pVals[6] !== undefined) (comp as any).period = pVals[6];
       }
    } else if (valueStr && comp.hasOwnProperty("model")) {
      // Semiconductors carry a model name (e.g. a diode's `1N4148`), not a value.
      (comp as any).model = valueStr;
    } else if (valueStr && valueStr.includes("{")) {
      // Parametric value (e.g. `{Cvar}`) — keep verbatim for the netlist so
      // .param/.step can drive it.
      comp.valueExpr = valueStr;
    } else if (valueStr && !valueStr.includes("(")) {
      const num = parseSI(valueStr);
      if (comp.hasOwnProperty("resistance")) (comp as any).resistance = num;
      if (comp.hasOwnProperty("capacitance")) (comp as any).capacitance = num;
      if (comp.hasOwnProperty("inductance")) (comp as any).inductance = num;
      if (comp.hasOwnProperty("dcValue")) (comp as any).dcValue = num;
    }

    // Small-signal AC magnitude from `AC <mag>` in Value/Value2 (a bare `AC`
    // means unit amplitude in LTSpice). Without this the source has no AC
    // excitation and a `.ac` sweep returns an all-zero response.
    if ((comp as any).acAmplitude !== undefined) {
      const acm = `${valueStr} ${value2}`.match(/\bAC\b\s*([-+0-9.eE]+[a-zµ]*)?/i);
      if (acm) {
        (comp as any).acAmplitude = acm[1] != null ? parseSI(acm[1]) : 1;
        // An AC-only source (empty main Value) is DC 0, not the constructor default.
        if (!valueStr && comp.hasOwnProperty("dcValue")) (comp as any).dcValue = 0;
      }
    }

    components.push(comp);

    // On-canvas value caption: fall back to the AC spec for an AC-only source
    // (empty main Value) so it isn't rendered blank.
    let displayValue = valueStr;
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
      }
    });
  }
}
