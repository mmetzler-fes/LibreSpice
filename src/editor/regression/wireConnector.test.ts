import type { Edge, Node } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { pointAtT, projectToPolyline, type FlowPoint } from "../WireTool.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { netLabelShape } from "../netLabelShape.js";
import { terminalDirection, terminalTagSide } from "../netTerminalOrientation.js";
import { buildSchematicSvg } from "../svgExport.js";
import type { PortType } from "@core/components/special/Special.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Net names on wires, and the net connector.
 *
 * A wire carries only a *name* (`showLabel` / `labelT` / `labelOffset` in
 * `edge.data`), so the geometry that slides that name along the wire must stay
 * correct. Ports are not wire attributes: a net connector is its own node,
 * stored the way LTSpice stores it — a `FLAG` plus an `IOPIN x y In|Out|BiDir`
 * at the same point — so the round-trip through `.asc` is the other half of what
 * is covered here.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// An L-shaped wire: (0,0) → (100,0) → (100,100). Total length 200.
const L: FlowPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

const CASES: Case[] = [
  { name: "pointAtT walks the polyline by arc length", run: (fail) => {
    const mid = pointAtT(L, 0.5); // 100 units in → the corner
    if (!near(mid.x, 100) || !near(mid.y, 0)) fail(`t=0.5 gave (${mid.x},${mid.y}), expected the corner (100,0)`);
    const q = pointAtT(L, 0.75); // 150 units → halfway down the second leg
    if (!near(q.x, 100) || !near(q.y, 50)) fail(`t=0.75 gave (${q.x},${q.y}), expected (100,50)`);
    const start = pointAtT(L, 0), end = pointAtT(L, 1);
    if (!near(start.x, 0) || !near(start.y, 0)) fail(`t=0 not the start: (${start.x},${start.y})`);
    if (!near(end.x, 100) || !near(end.y, 100)) fail(`t=1 not the end: (${end.x},${end.y})`);
  } },

  { name: "projectToPolyline finds the nearest along-position", run: (fail) => {
    // A point off the first leg projects onto it at the right fraction.
    const t = projectToPolyline(L, { x: 50, y: 20 });
    if (!near(t, 0.25)) fail(`projected t=${t}, expected 0.25 (50 of 200 units)`);
    // Clamped/round-trip: projecting the point pointAtT returns lands back there.
    const p = pointAtT(L, projectToPolyline(L, pointAtT(L, 0.6)));
    const want = pointAtT(L, 0.6);
    if (!near(p.x, want.x) || !near(p.y, want.y)) fail(`round-trip drifted to (${p.x},${p.y})`);
  } },

  { name: "updateEdgeData patches only the target edge and is undoable", run: (fail) => {
    const store = useCircuitStore.getState();
    store.clearCircuit();
    store.setEdges([
      { id: "w1", source: "a", sourceHandle: "p", target: "b", targetHandle: "n", type: "wire", data: { waypoints: [] } },
      { id: "w2", source: "c", sourceHandle: "p", target: "d", targetHandle: "n", type: "wire", data: { waypoints: [] } },
    ] as Edge[]);
    useCircuitStore.getState().updateEdgeData("w1", { showLabel: true, labelT: 0.3 });
    const [w1, w2] = useCircuitStore.getState().edges;
    if (!(w1.data as { showLabel?: boolean }).showLabel) fail("w1 did not receive showLabel");
    if ((w2.data as { showLabel?: boolean }).showLabel) fail("w2 was wrongly patched");
    useCircuitStore.getState().undo();
    if ((useCircuitStore.getState().edges[0].data as { showLabel?: boolean }).showLabel) fail("undo did not revert showLabel");
  } },
];

/** One net-connector node at a fixed point, with the given port type. */
function connectorNodes(label: string, portType: PortType): Node[] {
  return [
    { id: "netconnector_0", type: "component", position: { x: 100, y: 100 },
      data: { componentType: "netconnector", label, portType } },
  ];
}

const emptyCircuit = { components: new Map(), nets: new Map() };

CASES.push(
  { name: "each port type round-trips as FLAG + its own IOPIN direction", run: (fail) => {
    // LTSpice writes the direction verbatim (In / Out / BiDir), so the exported
    // keyword and the re-imported port type must both survive unchanged.
    for (const pt of ["In", "Out", "BiDir"] as PortType[]) {
      const asc = LTSpiceExporter.export(connectorNodes("A", pt), [], "", emptyCircuit, []);
      if (!new RegExp(`^FLAG\\s+-?\\d+\\s+-?\\d+\\s+A$`, "m").test(asc)) fail(`${pt}: no FLAG A:\n${asc}`);
      if (!new RegExp(`^IOPIN\\s+-?\\d+\\s+-?\\d+\\s+${pt}$`, "m").test(asc)) fail(`${pt}: no "IOPIN … ${pt}":\n${asc}`);

      const back = LTSpiceParser.parse(asc);
      const n = back.nodes.find((x) => (x.data as { label?: string }).label === "A");
      if (!n) { fail(`${pt}: connector A did not re-import`); continue; }
      const d = n.data as { componentType?: string; portType?: string };
      if (d.componentType !== "netconnector") fail(`${pt}: came back as ${d.componentType}, not a netconnector`);
      if (d.portType !== pt) fail(`${pt}: port type came back as ${d.portType}`);
    }
  } },

  { name: "the FLAG and its IOPIN sit on the same point", run: (fail) => {
    // LTSpice pairs the two by coordinate — a mismatch silently drops the port.
    const asc = LTSpiceExporter.export(connectorNodes("A", "In"), [], "", emptyCircuit, []);
    const flag = asc.match(/^FLAG\s+(-?\d+\s+-?\d+)\s+A$/m)?.[1];
    const iopin = asc.match(/^IOPIN\s+(-?\d+\s+-?\d+)\s+In$/m)?.[1];
    if (!flag || !iopin) { fail(`missing FLAG/IOPIN:\n${asc}`); return; }
    if (flag !== iopin) fail(`FLAG at ${flag} but IOPIN at ${iopin}`);
  } },

  { name: "port type None writes a bare FLAG and returns as a net label", run: (fail) => {
    // LTSpice's "Port Type: None" has no IOPIN at all, so it is exactly a label.
    const asc = LTSpiceExporter.export(connectorNodes("SIG", "None"), [], "", emptyCircuit, []);
    if (!/^FLAG\s+-?\d+\s+-?\d+\s+SIG$/m.test(asc)) fail(`no FLAG SIG:\n${asc}`);
    if (/IOPIN/.test(asc)) fail(`port type None must not write an IOPIN:\n${asc}`);
    const back = LTSpiceParser.parse(asc);
    const n = back.nodes.find((x) => (x.data as { label?: string }).label === "SIG");
    if ((n?.data as { componentType?: string })?.componentType !== "netlabel") {
      fail(`a bare FLAG must import as a netlabel, got ${(n?.data as { componentType?: string })?.componentType}`);
    }
  } },

  { name: "a plain net label exports a FLAG but no IOPIN", run: (fail) => {
    const nodes: Node[] = [
      { id: "netlabel_0", type: "component", position: { x: 100, y: 100 },
        data: { componentType: "netlabel", label: "SIG" } },
    ];
    const asc = LTSpiceExporter.export(nodes, [], "", emptyCircuit, []);
    if (!/FLAG\s+-?\d+\s+-?\d+\s+SIG/.test(asc)) fail(`no FLAG SIG:\n${asc}`);
    if (/IOPIN/.test(asc)) fail(`plain label must not write IOPIN:\n${asc}`);
  } },

  { name: "the four port types draw four distinct symbols", run: (fail) => {
    // None = bare circle, Out/In = one arrowhead each, BiDir = two.
    const counts: Record<string, number> = {};
    for (const pt of ["None", "Out", "In", "BiDir"] as PortType[]) {
      const s = netLabelShape(pt);
      counts[pt] = s.heads.length;
      if (pt === "None" && s.stem) fail("None must have no arrow stem");
      if (pt !== "None" && !s.stem) fail(`${pt} must have an arrow stem`);
    }
    if (counts.None !== 0) fail(`None drew ${counts.None} arrowheads, expected 0`);
    if (counts.Out !== 1) fail(`Out drew ${counts.Out} arrowheads, expected 1`);
    if (counts.In !== 1) fail(`In drew ${counts.In} arrowheads, expected 1`);
    if (counts.BiDir !== 2) fail(`BiDir drew ${counts.BiDir} arrowheads, expected 2`);
    // The name steps *across* the wire, never along it: along the axis is where
    // the wire continues and where the parts on it sit, which is what made a
    // connector's name land on its neighbour.
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const s2 = netLabelShape("BiDir", dir);
      const along = dir.x !== 0 ? s2.tag.x - s2.circle.cx : s2.tag.y - s2.circle.cy;
      const across = dir.x !== 0 ? s2.tag.y - s2.circle.cy : s2.tag.x - s2.circle.cx;
      if (along !== 0) fail(`dir (${dir.x},${dir.y}): the tag drifted ${along}px along the wire`);
      if (Math.abs(across) <= s2.circle.r) fail(`dir (${dir.x},${dir.y}): the tag sits on its own circle`);
    }
    // And it still clears the circle it belongs to.
    const label = netLabelShape("None"), conn = netLabelShape("BiDir");
    const d = Math.hypot(label.tag.x - label.circle.cx, label.tag.y - label.circle.cy);
    if (d <= label.circle.r) fail(`the label tag overlaps its circle (${d}px from the centre)`);
    // Both stay within the 1 cm the label may be dragged from the dock, or the
    // default position would already sit outside its own tether.
    const reach = Math.hypot(conn.tag.x - conn.circle.cx, conn.tag.y - conn.circle.cy);
    if (reach > 96 / 2.54) fail(`the connector tag starts ${reach.toFixed(1)}px from the dock, past the 1 cm cap`);

    // In and Out point opposite ways, so their heads must not coincide.
    if (netLabelShape("In").heads[0] === netLabelShape("Out").heads[0]) {
      fail("In and Out drew the same arrowhead");
    }
  } },
);

CASES.push(
  { name: "a terminal faces away from the wire on its dock", run: (fail) => {
    const dock = { x: 100, y: 100 };
    const cases: [string, { x: number; y: number }, { x: number; y: number }][] = [
      ["wire leaves right", { x: 180, y: 100 }, { x: -1, y: 0 }],
      ["wire leaves left", { x: 20, y: 100 }, { x: 1, y: 0 }],
      ["wire leaves down", { x: 100, y: 180 }, { x: 0, y: -1 }],
      ["wire leaves up", { x: 100, y: 20 }, { x: 0, y: 1 }],
      // A diagonal run snaps to its dominant axis, like every other wire here.
      ["diagonal, mostly right", { x: 180, y: 120 }, { x: -1, y: 0 }],
    ];
    for (const [what, far, want] of cases) {
      const got = terminalDirection(dock, [far]);
      if (got.x !== want.x || got.y !== want.y) {
        fail(`${what}: got (${got.x},${got.y}), expected (${want.x},${want.y})`);
      }
    }
    // Nothing wired up yet: default upward, matching the placement ghost.
    const bare = terminalDirection(dock, []);
    if (bare.x !== 0 || bare.y !== -1) fail(`unwired terminal faced (${bare.x},${bare.y}), expected up`);
    // A zero-length wire says nothing about direction and must be skipped, not
    // taken as "no direction at all".
    const degenerate = terminalDirection(dock, [{ ...dock }, { x: 20, y: 100 }]);
    if (degenerate.x !== 1 || degenerate.y !== 0) fail("a coincident far end must be skipped, not decide the facing");
  } },
  { name: "only a real port carries the circle", run: (fail) => {
    // The circle marks an interface point. A plain label just gives the net a
    // name and its tag already marks the spot, so a circle there was a second
    // mark for the same place; a connector's port is worth showing.
    const svg = (portType: PortType) => {
      const node = { id: "n1", position: { x: 0, y: 0 },
        data: { componentType: portType === "None" ? "netlabel" : "netconnector", label: "X", portType } };
      return buildSchematicSvg([node as never], [], "default");
    };
    if (/<circle/.test(svg("None"))) fail("a plain net label drew a circle");
    for (const pt of ["In", "Out", "BiDir"] as PortType[]) {
      if (!/<circle/.test(svg(pt))) fail(`a ${pt} connector drew no circle`);
    }
  } },

  { name: "the name takes the free side across the wire", run: (fail) => {
    // Across the wire there are two sides. The conventional one is above (or
    // right of a vertical run); the other is taken when something already sits
    // there, so a name never lands on a part or a neighbouring terminal. Derived
    // from the surroundings, not stored — the file keeps no layout hints.
    const dock = { x: 100, y: 100 };
    const right = { x: 1, y: 0 };
    if (terminalTagSide(dock, right, []) !== -1) fail("with nothing around, the name did not take the upper side");
    // A part just above it pushes the name below.
    if (terminalTagSide(dock, right, [{ x: 100, y: 60 }]) !== 1) fail("a part above did not push the name down");
    // Something below as well — the upper side is no worse, so convention wins.
    if (terminalTagSide(dock, right, [{ x: 100, y: 60 }, { x: 100, y: 140 }]) !== -1) {
      fail("with both sides equally busy the name left its conventional side");
    }
    // Far enough away it does not count.
    if (terminalTagSide(dock, right, [{ x: 100, y: -200 }]) !== -1) fail("a distant part still pushed the name");
    // On a vertical wire the two sides are left and right, and right is the
    // conventional one.
    const down = { x: 0, y: 1 };
    if (terminalTagSide(dock, down, []) !== 1) fail("on a vertical wire the name did not take the right side");
    if (terminalTagSide(dock, down, [{ x: 140, y: 100 }]) !== -1) fail("a part to the right did not push the name left");
  } },

  { name: "the name clears the wire whether it ends there or runs through", run: (fail) => {
    // The two jobs are split: the arrow keeps pointing along the wire, because
    // that is what says which way the signal runs; keeping out of the way is the
    // name's, and it steps across.
    const dock = { x: 100, y: 100 };
    const cases: [string, { x: number; y: number }[]][] = [
      ["wire ends here", [{ x: 20, y: 100 }]],
      ["wire runs through", [{ x: 180, y: 100 }, { x: 20, y: 100 }]],
      ["tee", [{ x: 180, y: 100 }, { x: 100, y: 180 }, { x: 20, y: 100 }]],
    ];
    for (const [what, ends] of cases) {
      const dir = terminalDirection(dock, ends);
      // The symbol stays on the wire's axis …
      if (dir.x === 0) fail(`${what}: the arrow left the wire's axis`);
      // … and the name steps off it.
      const s2 = netLabelShape("BiDir", dir);
      if (s2.tag.x !== s2.circle.cx) fail(`${what}: the name drifted along the wire`);
      if (s2.tag.y >= s2.circle.cy) fail(`${what}: the name did not step above the wire`);
    }
    // A vertical wire pushes the name sideways instead.
    const vert = netLabelShape("BiDir", terminalDirection(dock, [{ x: 100, y: 20 }]));
    if (vert.tag.y !== vert.circle.cy) fail("on a vertical wire the name drifted along it");
    if (vert.tag.x <= vert.circle.cx) fail("on a vertical wire the name did not step aside");
  } },

  { name: "the arrow follows LTSpice's layout (04-4_AstabileKippstufe1)", run: (fail) => {
    // The four connectors in that example are *all* `In`, yet LTSpice draws two
    // leftwards and two rightwards — proof the facing comes from the wiring, not
    // the port type. Coordinates lifted verbatim from the FLAG/WIRE lines.
    //
    // Only the arrow follows LTSpice. The *name* deliberately does not: LTSpice
    // hangs it off the same side, along the wire, where on these sheets it lands
    // on the next part. Ours steps across the wire instead. So the check below is
    // on the facing, and the tag is only required to stay off the wire's axis.
    const cases: [string, { x: number; y: number }, { x: number; y: number }, number][] = [
      // [name, dock (FLAG), far end of its wire, expected tag x-side]
      ["Q1_C", { x: 160, y: 176 }, { x: 176, y: 176 }, -1], // wire right → tag left
      ["Q2_C", { x: 640, y: 176 }, { x: 624, y: 176 }, +1], // wire left  → tag right
      ["Q1_B", { x: 320, y: 288 }, { x: 304, y: 288 }, +1], // wire left  → tag right
      ["Q2_B", { x: 480, y: 288 }, { x: 496, y: 288 }, -1], // wire right → tag left
    ];
    for (const [name, dock, far, side] of cases) {
      const dir = terminalDirection(dock, [far]);
      if (Math.sign(dir.x) !== side) {
        fail(`${name}: symbol faces x=${dir.x}, expected ${side}`);
        continue;
      }
      // These four sit on horizontal wires, so the name belongs above them —
      // centred over the dock, not off to either side.
      const shape = netLabelShape("In", dir);
      if (shape.tag.x !== shape.circle.cx) fail(`${name}: the name drifted ${shape.tag.x - shape.circle.cx}px along the wire`);
      if (shape.tag.y >= shape.circle.cy) fail(`${name}: the name did not step above the wire`);
    }
  } },
);

export function runWireConnectorTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}
