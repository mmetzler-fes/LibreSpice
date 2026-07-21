import { getLocalPins, NODE_SIZE } from "../pinGeometry.js";
import { captionSide } from "../captionLayout.js";
import { offsetsForNode } from "@core/ltspice/ltspiceGeometry.js";
import { buildSchematicSvg } from "../svgExport.js";
import { LogicGate } from "@core/components/digital/LogicGate.js";
import { DFlipFlop } from "@core/components/digital/DFlipFlop.js";
import type { ComponentNodeData } from "../nodes/ComponentNode.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Editor geometry and export for the two digital parts.
 *
 * Both are drawn by hand rather than from an `.asy`, and both have a pin *set*
 * that depends on their properties — the gate's input count, the flip-flop's
 * kind. They were therefore missing from every static pin table: they had no
 * connectors at all on the canvas, nothing could be wired to them, and the SVG
 * export fell through to the generic lookup and drew them as resistors.
 *
 * The rule these tests hold to is that the pin positions here must equal the
 * component's own `createPorts` offsets. Three places carry those numbers (the
 * component for the netlist, this table for the canvas, `ltspiceGeometry` for
 * import), so they are compared against each other rather than against literals
 * copied from one of them.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const data = (over: Partial<ComponentNodeData>): ComponentNodeData =>
  ({ componentType: "dff", label: "U1", ...over }) as ComponentNodeData;

/** Pin offsets relative to the node centre, which is what a Port stores. */
const centred = (d: ComponentNodeData) =>
  getLocalPins(d).map((p) => ({ handleId: p.handleId, x: p.px - NODE_SIZE / 2, y: p.py - NODE_SIZE / 2 }));

/** The same offsets, taken from the component itself. */
const fromPorts = (c: { ports: { relativePosition: { x: number; y: number } }[] }) =>
  c.ports.map((p) => ({ x: p.relativePosition.x, y: p.relativePosition.y }));

const svgFor = (d: ComponentNodeData): string =>
  buildSchematicSvg([{ id: "n1", position: { x: 0, y: 0 }, data: d } as never], [], "default");

const CASES: Case[] = [
  {
    name: "the flip-flop's canvas pins match its own ports",
    run: (fail) => {
      const got = centred(data({ componentType: "dff", kind: "dff" }));
      const want = fromPorts(new DFlipFlop("f1", "U1"));
      if (got.length !== want.length) return fail(`${got.length} pins, component has ${want.length}`);
      got.forEach((p, i) => {
        if (p.x !== want[i].x || p.y !== want[i].y) {
          fail(`pin ${p.handleId} at ${p.x},${p.y} but port at ${want[i].x},${want[i].y}`);
        }
      });
    },
  },
  {
    name: "the flip-flop's handle ids match its port ids",
    run: (fail) => {
      const f = new DFlipFlop("f1", "U1");
      const want = f.ports.map((p) => p.id.replace("f1-", ""));
      const got = getLocalPins(data({ componentType: "dff" })).map((p) => p.handleId);
      // A mismatch here means Circuit.connectPorts cannot resolve a wire's end,
      // so the part draws terminals that silently connect to nothing.
      if (got.join() !== want.join()) fail(`handles ${got.join()} vs ports ${want.join()}`);
    },
  },
  {
    name: "a gate's pins follow its input count",
    run: (fail) => {
      for (const n of [2, 3, 4, 5]) {
        const got = centred(data({ componentType: "logicgate", gateType: "and", inputs: n }));
        const want = fromPorts(new LogicGate("g1", "U1", undefined, "and" as never, n));
        if (got.length !== n + 1) return fail(`${n} inputs gave ${got.length} pins`);
        got.forEach((p, i) => {
          if (p.x !== want[i].x || p.y !== want[i].y) {
            fail(`${n}-input gate pin ${i} at ${p.x},${p.y} but port at ${want[i].x},${want[i].y}`);
          }
        });
      }
    },
  },
  {
    name: "an inverter has one input whatever the input count says",
    run: (fail) => {
      const got = centred(data({ componentType: "logicgate", gateType: "not", inputs: 4 }));
      if (got.length !== 2) fail(`inverter has ${got.length} pins`);
    },
  },
  {
    name: "rotation turns the pins with the symbol",
    run: (fail) => {
      const up = centred(data({ componentType: "dff", rotation: 0 }));
      const right = centred(data({ componentType: "dff", rotation: 90 }));
      // A 90° clockwise turn about the node centre sends (x, y) to (-y, x).
      // Asserted for every pin, so a rotation applied about the wrong origin —
      // which still moves the pins, just to the wrong place — cannot pass.
      up.forEach((p, i) => {
        if (Math.abs(right[i].x - -p.y) > 0.001 || Math.abs(right[i].y - p.x) > 0.001) {
          fail(`${p.handleId} ${p.x},${p.y} turned to ${right[i].x},${right[i].y}, expected ${-p.y},${p.x}`);
        }
      });
    },
  },
  {
    name: "captions hug the flank with fewer pins",
    run: (fail) => {
      // A label set against a crowded flank sits in the wires running into it.
      // The op-amp has two inputs left and one output right, a gate up to five
      // against one — those belong on the right. A two-terminal part has its
      // pins top and bottom, so neither flank is busier and the left stays.
      const at = (d: Partial<ComponentNodeData>) => captionSide(getLocalPins(data(d)));
      if (at({ componentType: "logicgate", gateType: "and", inputs: 4 }) !== "right") fail("4-input gate kept its caption left");
      if (at({ componentType: "vsource" }) !== "left") fail("a source moved its caption off the left");
      if (at({ componentType: "dff" }) !== "left") fail("the flip-flop (2 left, 2 right) should keep the left");
      // Turned over, the crowded flank swaps and the caption follows.
      if (at({ componentType: "logicgate", gateType: "and", inputs: 4, rotation: 180 }) !== "left") {
        fail("turning a gate 180° did not move the caption back");
      }

      // The op-amp is the case this was built for, but it draws from an `.asy`
      // and the harness loads no symbols (see scripts/glob-shim.js), so its pin
      // set is stated here: two inputs left, supplies on the axis, output right.
      const c = NODE_SIZE / 2;
      const opamp = [{ px: c - 32 }, { px: c - 32 }, { px: c }, { px: c }, { px: c + 32 }];
      if (captionSide(opamp) !== "right") fail("the op-amp's caption stayed on its crowded flank");
      // The supplies sit on the centre line and must count for neither flank.
      if (captionSide([{ px: c }, { px: c }]) !== "left") fail("centre pins were counted as a flank");
    },
  },
  {
    name: "a jumper keeps its own pins, not a resistor's",
    run: (fail) => {
      // The jumper is a resistor behind the scenes (1 uOhm), but its pins sit
      // 64 apart on one horizontal line, where a resistor's are vertical. Folded
      // into the resistor type it landed on no wire at all — the schematic it
      // came from lost the whole branch and nothing reported it.
      // Checked on the *import* geometry: that is the table which decides where
      // a loaded part's pins land, and the one that sent the jumper off the
      // wires. (The canvas table draws from the `.asy`, which the harness does
      // not load — see scripts/glob-shim.js.)
      const pins = offsetsForNode("jumper", 0);
      if (pins.length !== 2) return fail(`${pins.length} pins`);
      const [a, b] = pins;
      if (a.dy !== b.dy) fail(`the two pins are not on one horizontal line: ${a.dy} vs ${b.dy}`);
      if (Math.abs(b.dx - a.dx) !== 64) fail(`the pins are ${Math.abs(b.dx - a.dx)} apart, expected 64`);
      // And it must not fall back to the resistor's layout, which is vertical.
      const res = offsetsForNode("resistor", 0);
      if (res.length === pins.length && res.every((r, i) => r.dx === pins[i].dx && r.dy === pins[i].dy)) {
        fail("the jumper fell back to the resistor's pins");
      }
    },
  },
  {
    name: "the export draws a flip-flop, not the resistor fallback",
    run: (fail) => {
      const svg = svgFor(data({ componentType: "dff", kind: "dff", edge: "rising" }));
      // The clock wedge is the flip-flop's alone; the fallback resistor is a
      // single zig-zag path with no polyline.
      if (!svg.includes("-20,19 -13,24 -20,29")) fail("no clock wedge in the exported SVG");
      if (!svg.includes('width="40"') || !svg.includes('height="80"')) fail("no flip-flop body in the exported SVG");
    },
  },
  {
    name: "the export honours the flip-flop's own properties",
    run: (fail) => {
      const falling = svgFor(data({ componentType: "dff", kind: "dff", edge: "falling" }));
      const rising = svgFor(data({ componentType: "dff", kind: "dff", edge: "rising" }));
      if (falling === rising) fail("rising and falling edge export identically");
      const latch = svgFor(data({ componentType: "dff", kind: "dlatch" }));
      if (!latch.includes(">EN<")) fail("a latch exported without its EN pin");
    },
  },
  {
    name: "the export draws the gate the properties ask for",
    run: (fail) => {
      const xor = svgFor(data({ componentType: "logicgate", gateType: "xor", inputs: 2 }));
      if (!xor.includes("=1")) fail("XOR exported without its =1 mark");
      const and5 = svgFor(data({ componentType: "logicgate", gateType: "and", inputs: 5 }));
      // Five input leads plus the output lead.
      const leads = (and5.match(/<line /g) ?? []).length;
      if (leads !== 6) fail(`5-input gate exported ${leads} leads`);
    },
  },
];

export function runDigitalGeometryTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
