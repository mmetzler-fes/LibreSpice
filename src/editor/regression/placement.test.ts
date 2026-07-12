import { NODE_SIZE, GRID, snapToGrid, getLocalPins } from "../pinGeometry.js";
import type { ComponentType } from "../nodes/ComponentNode.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The placement ghost marks where the component's docking point will land: it
 * snaps the cursor to the grid and centres the preview there, and the placement
 * puts the node's centre on that same snapped point (`position = snap(cursor) −
 * NODE_SIZE/2`).
 *
 * The ghost used to carry its own hard-coded 20 px grid while the canvas snaps to
 * GRID, so the preview sat up to 10 px away from where the part actually
 * appeared. For a net-label connector that is fatal: its terminal has to land
 * *on* the wire (within ~2 px) to tap it, so aiming with the ghost could never
 * connect it. Both sides now share {@link snapToGrid} — this pins that down.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** Where the ghost draws its docking point for a cursor at (cx, cy). */
const ghostPoint = (cx: number, cy: number) => ({ x: snapToGrid(cx), y: snapToGrid(cy) });

/** Where the given pin of the placed component actually ends up (flow coords). */
function placedPin(type: ComponentType, cx: number, cy: number, rotation = 0, handleId?: string) {
  const position = { x: snapToGrid(cx) - NODE_SIZE / 2, y: snapToGrid(cy) - NODE_SIZE / 2 };
  const pins = getLocalPins({ componentType: type, label: "X", rotation });
  const pin = handleId ? pins.find((p) => p.handleId === handleId) : pins[0];
  if (!pin) return null;
  return { x: position.x + pin.px, y: position.y + pin.py };
}

// Cursor positions deliberately off-grid, including ones the old 20 px ghost grid
// and the canvas grid disagree about (e.g. 733 → 20-grid 740, snap grid 732).
const CURSORS: [number, number][] = [[0, 0], [733, 511], [101, 99], [-57, 244], [1234.6, 87.2]];

const CASES: Case[] = [
  { name: "ghost point == the net-label connector's terminal, at every rotation", run: (fail) => {
    for (const rotation of [0, 90, 180, 270]) {
      for (const [cx, cy] of CURSORS) {
        const g = ghostPoint(cx, cy);
        const pin = placedPin("netlabel", cx, cy, rotation);
        if (!pin) { fail("net label has no pin"); return; }
        if (pin.x !== g.x || pin.y !== g.y) {
          fail(`rot ${rotation}, cursor (${cx}, ${cy}): ghost (${g.x}, ${g.y}) but terminal (${pin.x}, ${pin.y})`);
        }
      }
    }
  } },

  { name: "ghost point is on the grid the canvas snaps to", run: (fail) => {
    // A wire lies on grid lines, so the connector can only tap it if the ghost
    // snaps to that same grid — the old 20 px ghost grid never met a 16-unit
    // LTSpice wire coordinate (20 and 16 only meet every 80 units).
    for (const [cx, cy] of CURSORS) {
      const g = ghostPoint(cx, cy);
      if (g.x !== snapToGrid(g.x) || g.y !== snapToGrid(g.y)) fail(`(${g.x}, ${g.y}) is off the grid`);
      if (Math.abs(g.x - cx) > GRID / 2 + 0.01 || Math.abs(g.y - cy) > GRID / 2 + 0.01) {
        fail(`cursor (${cx}, ${cy}) snapped ${Math.abs(g.x - cx)}/${Math.abs(g.y - cy)} px away — not the nearest grid point`);
      }
    }
  } },

  { name: "every pin sits on the grid, at every rotation (so it can meet a wire)", run: (fail) => {
    // Wires run along grid lines and a tap needs ~2 px accuracy, so a terminal
    // whose local offset is off-grid can never land on one — however carefully it
    // is aimed. The ground pin sat at y = 20, off the grid, and could not be
    // dropped onto a wire at all; it is at 24 now.
    const TYPES: ComponentType[] = [
      "resistor", "capacitor", "capacitor_polarized", "inductor", "diode", "led", "zener", "schottky",
      "opamp", "bjt_npn", "bjt_pnp", "mosfet_n", "mosfet_p", "vsource", "isource", "ground", "netlabel",
    ];
    for (const type of TYPES) {
      for (const rotation of [0, 90, 180, 270]) {
        for (const pin of getLocalPins({ componentType: type, label: "X", rotation })) {
          // Rounded: rotation of a grid-aligned pin is exact bar float noise.
          const px = Math.round(pin.px), py = Math.round(pin.py);
          if (px % GRID !== 0 || py % GRID !== 0) {
            fail(`${type} pin ${pin.handleId} at (${px}, ${py}) is off the ${GRID} px grid (rot ${rotation})`);
          }
        }
      }
    }
  } },

  { name: "a placed component's pins land on the grid (and stay there when dragged)", run: (fail) => {
    // Placement puts the node box on the grid (snap(cursor) − NODE_SIZE/2, and
    // NODE_SIZE/2 = 40 is a multiple of the grid), and React Flow's snapGrid keeps
    // it there while dragging — so with grid-aligned local pins, every terminal is
    // on a grid line before and after a drag.
    if ((NODE_SIZE / 2) % GRID !== 0) fail(`NODE_SIZE/2 (${NODE_SIZE / 2}) is not a multiple of the grid`);
    for (const [cx, cy] of CURSORS) {
      for (const type of ["resistor", "vsource", "ground", "netlabel"] as ComponentType[]) {
        const pos = { x: snapToGrid(cx) - NODE_SIZE / 2, y: snapToGrid(cy) - NODE_SIZE / 2 };
        for (const pin of getLocalPins({ componentType: type, label: "X", rotation: 0 })) {
          const x = pos.x + pin.px, y = pos.y + pin.py;
          if (x % GRID !== 0 || y % GRID !== 0) fail(`${type} ${pin.handleId} at (${x}, ${y}) is off the grid`);
        }
      }
    }
  } },

  { name: "the ground terminal lands on the ghost's column, on the grid", run: (fail) => {
    // Ground is the other single-pin part placed by clicking. Its terminal is not
    // at the box centre (it sits at the top of the stem), so only its x can match
    // the ghost point — but it must be on the grid in both axes.
    for (const [cx, cy] of CURSORS) {
      const g = ghostPoint(cx, cy);
      const pin = placedPin("ground", cx, cy);
      if (!pin) { fail("ground has no pin"); return; }
      if (Math.abs(pin.x - g.x) > 0.001) fail(`cursor (${cx}, ${cy}): ghost x ${g.x} but terminal x ${pin.x}`);
      if (pin.y % GRID !== 0) fail(`ground terminal y ${pin.y} is off the grid`);
    }
  } },

  { name: "the snap grid is commensurate with LTSpice's 16 (and a 12-unit spacing)", run: (fail) => {
    // Every point of an imported schematic must be reachable, or a part can be
    // aimed at a wire and still never land on it. LTSpice draws on 16 units (98%
    // of all coordinates in the bundled examples are multiples of 16, and the GCD
    // over all of them is 4); a 12-unit spacing has to work too. GRID must divide
    // each of them — 8 would already miss the 12- and the 4-unit points.
    for (const pitch of [16, 12, 8, 4]) {
      if (pitch % GRID !== 0) fail(`a ${pitch}-unit coordinate cannot be reached on a ${GRID} px grid`);
    }
  } },
];

export function runPlacementTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}
