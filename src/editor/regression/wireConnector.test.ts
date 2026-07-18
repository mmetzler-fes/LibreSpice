import type { Edge, Node } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { pointAtT, projectToPolyline, ARROW_ORDER, type FlowPoint } from "../WireTool.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Wire-based net label / connector. The label and the connector symbol now live
 * on the wire edge (visible / connector / arrowDir in `edge.data`) instead of on
 * a separate node, so the geometry that slides the label along the wire and the
 * store logic that rotates the connector must stay correct.
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

  { name: "Ctrl-R rotates a selected connector wire's arrow, not a component", run: (fail) => {
    const store = useCircuitStore.getState();
    store.clearCircuit();
    const edge: Edge = {
      id: "wire_test", source: "a", sourceHandle: "p", target: "b", targetHandle: "n",
      type: "wire", selected: true, data: { waypoints: [], connector: true, arrowDir: "up" },
    };
    store.setEdges([edge]);
    for (let i = 1; i < ARROW_ORDER.length; i++) {
      useCircuitStore.getState().rotateSelected();
      const dir = (useCircuitStore.getState().edges[0].data as { arrowDir?: string }).arrowDir;
      if (dir !== ARROW_ORDER[i]) { fail(`after ${i} rotations arrowDir=${dir}, expected ${ARROW_ORDER[i]}`); return; }
    }
    // One more wraps back to the first direction.
    useCircuitStore.getState().rotateSelected();
    const wrapped = (useCircuitStore.getState().edges[0].data as { arrowDir?: string }).arrowDir;
    if (wrapped !== ARROW_ORDER[0]) fail(`arrow did not wrap: got ${wrapped}, expected ${ARROW_ORDER[0]}`);
  } },

  { name: "updateEdgeData patches only the target edge and is undoable", run: (fail) => {
    const store = useCircuitStore.getState();
    store.clearCircuit();
    store.setEdges([
      { id: "w1", source: "a", sourceHandle: "p", target: "b", targetHandle: "n", type: "wire", data: { waypoints: [] } },
      { id: "w2", source: "c", sourceHandle: "p", target: "d", targetHandle: "n", type: "wire", data: { waypoints: [] } },
    ]);
    useCircuitStore.getState().updateEdgeData("w1", { showLabel: true, labelT: 0.3 });
    const [w1, w2] = useCircuitStore.getState().edges;
    if (!(w1.data as { showLabel?: boolean }).showLabel) fail("w1 did not receive showLabel");
    if ((w2.data as { showLabel?: boolean }).showLabel) fail("w2 was wrongly patched");
    useCircuitStore.getState().undo();
    if ((useCircuitStore.getState().edges[0].data as { showLabel?: boolean }).showLabel) fail("undo did not revert showLabel");
  } },
];

CASES.push(
  { name: "netlabel connector round-trips as FLAG + IOPIN", run: (fail) => {
    // A connector net-label node must export a FLAG *and* an IOPIN (LTSpice's
    // port), and re-import as a connector again.
    const nodes: Node[] = [
      { id: "netlabel_0", type: "component", position: { x: 100, y: 100 },
        data: { componentType: "netlabel", label: "OUT", connector: true } },
    ];
    const asc = LTSpiceExporter.export(nodes, [], "", { components: new Map(), nets: new Map() }, []);
    if (!/FLAG\s+\d+\s+\d+\s+OUT/.test(asc)) fail(`no FLAG OUT in export:\n${asc}`);
    if (!/IOPIN\s+\d+\s+\d+\s+BiDir/.test(asc)) fail(`no IOPIN in export:\n${asc}`);
    const back = LTSpiceParser.parse(asc);
    const nl = back.nodes.find((n) => (n.data as { label?: string }).label === "OUT");
    if (!nl) { fail("net label OUT did not re-import"); return; }
    if (!(nl.data as { connector?: boolean }).connector) fail("connector flag lost on re-import");
  } },

  { name: "plain netlabel exports a FLAG but no IOPIN", run: (fail) => {
    const nodes: Node[] = [
      { id: "netlabel_0", type: "component", position: { x: 100, y: 100 },
        data: { componentType: "netlabel", label: "SIG", connector: false } },
    ];
    const asc = LTSpiceExporter.export(nodes, [], "", { components: new Map(), nets: new Map() }, []);
    if (!/FLAG\s+\d+\s+\d+\s+SIG/.test(asc)) fail(`no FLAG SIG:\n${asc}`);
    if (/IOPIN/.test(asc)) fail(`plain label must not write IOPIN:\n${asc}`);
    const back = LTSpiceParser.parse(asc);
    const nl = back.nodes.find((n) => (n.data as { label?: string }).label === "SIG");
    if (nl && (nl.data as { connector?: boolean }).connector) fail("plain label came back as a connector");
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
