import type { Node, Edge } from "@xyflow/react";
import { createSpiceComponent } from "@editor/componentFactory.js";
import { getNodePins } from "@editor/pinGeometry.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import { symbolToType, CENTER, rotDeg, rotatedOffsets, symbolToNode } from "./ltspiceGeometry.js";

// Must match LTSpiceExporter / ComponentNode so WINDOW ↔ offset round-trips.
const LABEL_DEFAULT = { left: 8, top: 30 };
const VALUE_DEFAULT = { left: 8, top: 48 };
const winToOffset = (def: { left: number; top: number }, w?: { x: number; y: number }) =>
  w ? { x: w.x - (def.left - CENTER), y: w.y - (def.top - CENTER) } : undefined;

function parseSI(val: string): number {
  if (!val) return 0;
  const num = parseFloat(val);
  if (isNaN(num)) return 0;
  const suffix = val.replace(/^[-\d.]+/, "").trim().toLowerCase();
  if (suffix.startsWith("meg")) return num * 1e6;
  if (suffix.startsWith("g")) return num * 1e9;
  if (suffix.startsWith("m")) return num * 1e-3;
  if (suffix.startsWith("k")) return num * 1e3;
  if (suffix.startsWith("u") || suffix.startsWith("µ")) return num * 1e-6;
  if (suffix.startsWith("n")) return num * 1e-9;
  if (suffix.startsWith("p")) return num * 1e-12;
  if (suffix.startsWith("f")) return num * 1e-15;
  return num;
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
          // Named net label (e.g. U1); resolved to one of our nets after wiring.
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

    // Resolve named FLAGs (net labels like U1) to a representative pin on their
    // net, so the store can label our net after wiring and imported DATAFLAG
    // expressions such as V(U1) resolve against the result.
    const netNames: { compId: string; handle: string; name: string }[] = [];
    for (const nf of namedFlags) {
      let wireNet: number | undefined, best = PIN_TOL;
      for (const w of wires) {
        const d = distToSegment(nf.x, nf.y, w);
        if (d <= best) { best = d; wireNet = w.netId; }
      }
      const rep = pins.find((p) => p.netId !== undefined && p.netId === wireNet);
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
    const valueStr = sym.attrs["Value"] || "";

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
    const { x: nodeX, y: nodeY } = symbolToNode(sym.x, sym.y, rotated);

    const comp = createSpiceComponent(cType, sym.id, label, nodeX, nodeY);

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
    } else if (valueStr && !valueStr.includes("(")) {
      const num = parseSI(valueStr);
      if (comp.hasOwnProperty("resistance")) (comp as any).resistance = num;
      if (comp.hasOwnProperty("capacitance")) (comp as any).capacitance = num;
      if (comp.hasOwnProperty("inductance")) (comp as any).inductance = num;
      if (comp.hasOwnProperty("dcValue")) (comp as any).dcValue = num;
    }

    components.push(comp);

    const windows = (sym.windows ?? {}) as Record<number, { x: number; y: number }>;
    const labelOffset = winToOffset(LABEL_DEFAULT, windows[0]);
    const valueOffset = winToOffset(VALUE_DEFAULT, windows[3]);

    nodes.push({
      id: sym.id,
      type: "component",
      position: { x: nodeX, y: nodeY },
      data: {
        componentType: cType,
        label,
        valueLabel: valueStr,
        rotation: deg,
        ...(labelOffset && { labelOffset }),
        ...(valueOffset && { valueOffset }),
      }
    });
  }
}
