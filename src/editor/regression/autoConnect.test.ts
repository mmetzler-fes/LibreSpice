import { autoConnectEdgesFor, type DockPin, type WireGeom } from "../autoConnect.js";
import type { FlowPoint } from "../WireTool.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Docking rule for a freshly placed component's pins. The case this locks down:
 * a net connector (a single-pin terminal) dropped straight onto another part's
 * pin must connect to it — previously only a wire could be docked onto, so a
 * connector on a bare pin did nothing. A wire under the pin still wins over a
 * pin, matching the interactive wiring.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const pin = (nodeId: string, handleId: string, x: number, y: number): DockPin => ({ nodeId, handleId, x, y });
/** No wire ever pre-exists in these unit cases unless the case adds one. */
const noneWired = () => false;
const wire = (id: string, source: string, sourceHandle: string, verts: FlowPoint[]): WireGeom =>
  ({ id, source, sourceHandle, verts });

const CASES: Case[] = [
  { name: "a connector pin on a component pin docks straight onto it", run: (fail) => {
    const placed = [pin("netlabel_1", "t", 100, 100)];
    const others = [pin("R1", "p", 100, 100)];
    const edges = autoConnectEdgesFor(placed, others, [], noneWired);
    if (edges.length !== 1) { fail(`expected 1 connection, got ${edges.length}`); return; }
    const e = edges[0];
    if (e.source !== "netlabel_1" || e.sourceHandle !== "t" || e.target !== "R1" || e.targetHandle !== "p") {
      fail(`wrong endpoints: ${e.source}-${e.sourceHandle} → ${e.target}-${e.targetHandle}`);
    }
    if (e.tap) fail("a pin-to-pin dock must carry no wire tap");
  } },

  { name: "a pin just outside the snap tolerance does not connect", run: (fail) => {
    const placed = [pin("netlabel_1", "t", 100, 100)];
    const others = [pin("R1", "p", 105, 100)]; // 25 > tol 4
    const edges = autoConnectEdgesFor(placed, others, [], noneWired);
    if (edges.length !== 0) fail(`connected across a 5-unit gap: ${edges.length} edge(s)`);
  } },

  { name: "a wire under the pin takes precedence over a coincident pin", run: (fail) => {
    const placed = [pin("netlabel_1", "t", 100, 100)];
    const others = [pin("R1", "p", 100, 100)];
    const w = [wire("w1", "R2", "n", [{ x: 0, y: 100 }, { x: 200, y: 100 }])];
    const edges = autoConnectEdgesFor(placed, others, w, noneWired);
    if (edges.length !== 1) { fail(`expected 1 connection, got ${edges.length}`); return; }
    if (edges[0].target !== "R2" || !edges[0].tap) fail("the pin should have tapped the wire, not docked the pin");
  } },

  { name: "no self-connection: only *other* pins are offered as targets", run: (fail) => {
    // The placed node's own pins are never passed in as otherPins, so a
    // two-pin part cannot short itself even if its pins were to coincide.
    const placed = [pin("R1", "p", 100, 100), pin("R1", "n", 100, 100)];
    const edges = autoConnectEdgesFor(placed, [], [], noneWired);
    if (edges.length !== 0) fail(`a part connected to itself: ${edges.length} edge(s)`);
  } },

  { name: "an existing wire between the two pins is not duplicated", run: (fail) => {
    const placed = [pin("netlabel_1", "t", 100, 100)];
    const others = [pin("R1", "p", 100, 100)];
    // alreadyWired reports the join exists → no second edge.
    const edges = autoConnectEdgesFor(placed, others, [], (a, bNode, bHandle) =>
      a.nodeId === "netlabel_1" && bNode === "R1" && bHandle === "p");
    if (edges.length !== 0) fail(`a duplicate edge was laid: ${edges.length}`);
  } },

  { name: "only the pin that lands on a target connects (others stay free)", run: (fail) => {
    const placed = [pin("X1", "a", 100, 100), pin("X1", "b", 300, 300)];
    const others = [pin("R1", "p", 100, 100)]; // only X1.a coincides
    const edges = autoConnectEdgesFor(placed, others, [], noneWired);
    if (edges.length !== 1 || edges[0].sourceHandle !== "a") {
      fail(`expected only X1.a to connect, got ${edges.map((e) => e.sourceHandle).join(", ") || "nothing"}`);
    }
  } },
];

export function runAutoConnectTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}
