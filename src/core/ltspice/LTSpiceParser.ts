import type { Node, Edge } from "@xyflow/react";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { createSpiceComponent } from "@editor/componentFactory.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";

// Must match LTSpiceExporter / ComponentNode so WINDOW ↔ offset round-trips.
const CENTER = 40;
const LABEL_DEFAULT = { left: -6, top: 30 };
const VALUE_DEFAULT = { left: -6, top: 48 };
const winToOffset = (def: { left: number; top: number }, w?: { x: number; y: number }) =>
  w ? { x: w.x - (def.left - CENTER), y: w.y - (def.top - CENTER) } : undefined;

const SYMBOL_TO_TYPE: Record<string, ComponentType> = {
  res: "resistor", cap: "capacitor", ind: "inductor",
  diode: "diode", LED: "led",
  npn: "bjt_npn", pnp: "bjt_pnp",
  nmos: "mosfet_n", pmos: "mosfet_p",
  voltage: "vsource", current: "isource",
};

const PIN_OFFSETS: Record<string, { handle: string; dx: number; dy: number }[]> = {
  resistor: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  capacitor: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  inductor: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  diode: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  led: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  vsource: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  isource: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  sinesource: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  pulsesource: [{ handle: "p", dx: 0, dy: -16 }, { handle: "n", dx: 0, dy: 16 }],
  bjt_npn: [{ handle: "collector", dx: 16, dy: -16 }, { handle: "base", dx: -16, dy: 0 }, { handle: "emitter", dx: 16, dy: 16 }],
  bjt_pnp: [{ handle: "collector", dx: 16, dy: -16 }, { handle: "base", dx: -16, dy: 0 }, { handle: "emitter", dx: 16, dy: 16 }],
  mosfet_n: [{ handle: "collector", dx: 16, dy: -16 }, { handle: "base", dx: -16, dy: 0 }, { handle: "emitter", dx: 16, dy: 16 }],
  mosfet_p: [{ handle: "collector", dx: 16, dy: -16 }, { handle: "base", dx: -16, dy: 0 }, { handle: "emitter", dx: 16, dy: 16 }],
};

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
  static parse(content: string): { nodes: Node[]; edges: Edge[]; directives: string; components: SpiceComponent[] } {
    const lines = content.split(/\r?\n/);
    const nodes: Node[] = [];
    const components: SpiceComponent[] = [];
    const wires: Wire[] = [];
    const pins: Pin[] = [];
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
          const comp = createSpiceComponent("ground", id, "0", x, y);
          components.push(comp);
          nodes.push({ id, type: "component", position: { x: x - 40, y: y - 40 }, data: { componentType: "ground", label: "0" } });
          pins.push({ compId: id, handle: "gnd", x, y });
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

    // Assign pins to nets
    // We use a tolerance of 24 for pins, since our guessed LTSpice pin offsets
    // might be slightly off compared to the actual symbol boundaries in LTSpice.
    for (const p of pins) {
      let bestDist = Infinity;
      let bestNetId: number | undefined;
      for (const w of wires) {
        const d = distToSegment(p.x, p.y, w);
        if (d <= 24 && d < bestDist) {
          bestDist = d;
          bestNetId = w.netId;
        }
      }
      p.netId = bestNetId || nextNetId++;
    }

    // Build edges from nets
    const edges: Edge[] = [];
    let edgeCounter = 1;
    const nets = new Map<number, Pin[]>();
    for (const p of pins) {
      if (!p.netId) continue;
      if (!nets.has(p.netId)) nets.set(p.netId, []);
      nets.get(p.netId)!.push(p);
    }

    for (const netPins of nets.values()) {
      if (netPins.length > 1) {
        const p1 = netPins[0];
        for (let i = 1; i < netPins.length; i++) {
          const p2 = netPins[i];
          edges.push({
            id: `edge_${edgeCounter++}`,
            source: p1.compId,
            sourceHandle: p1.handle,
            target: p2.compId,
            targetHandle: p2.handle,
            type: "step"
          });
        }
      }
    }

    return { nodes, edges, directives: directives.trim(), components };
  }

  private static finalizeSymbol(sym: any, nodes: Node[], components: SpiceComponent[], pins: Pin[]) {
    let cType = SYMBOL_TO_TYPE[sym.name] || "resistor";
    const label = sym.attrs["InstName"] || sym.name;
    const valueStr = sym.attrs["Value"] || "";

    if (cType === "vsource") {
      if (valueStr.toUpperCase().startsWith("SINE")) cType = "sinesource";
      if (valueStr.toUpperCase().startsWith("PULSE")) cType = "pulsesource";
    }

    // Apply rotation for pins
    let rotDeg = 0;
    if (sym.rot === "R90") rotDeg = 90;
    if (sym.rot === "R180") rotDeg = 180;
    if (sym.rot === "R270") rotDeg = 270;

    const comp = createSpiceComponent(cType, sym.id, label, sym.x - 40, sym.y - 40);

    // Pin registration
    const offsets = PIN_OFFSETS[cType] || PIN_OFFSETS["resistor"];
    for (const p of offsets) {
      let dx = p.dx, dy = p.dy;
      if (rotDeg === 90) { dx = -p.dy; dy = p.dx; }
      else if (rotDeg === 180) { dx = -p.dx; dy = -p.dy; }
      else if (rotDeg === 270) { dx = p.dy; dy = -p.dx; }
      pins.push({ compId: sym.id, handle: p.handle, x: sym.x + dx, y: sym.y + dy });
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
      position: { x: sym.x - 40, y: sym.y - 40 },
      data: {
        componentType: cType,
        label,
        valueLabel: valueStr,
        rotation: rotDeg,
        ...(labelOffset && { labelOffset }),
        ...(valueOffset && { valueOffset }),
      }
    });
  }
}
