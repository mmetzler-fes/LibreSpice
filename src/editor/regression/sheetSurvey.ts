import { useCircuitStore } from "@store/circuitStore.js";
import { getNodePins } from "@editor/pinGeometry.js";
import { anchorRoutes } from "@editor/anchorNets.js";
import { distToRoutes, ANCHOR_TOLERANCE } from "@core/circuit/anchorResolve.js";

/**
 * One schematic, measured the way a user would notice it is wrong.
 *
 * The suites that existed before this each checked one property of the file —
 * that it round-trips (`ascExamples`), that its text survives a save
 * (`ascFidelity`), that its netlist has no shorted source (`convertedNetlist`).
 * None of them answered the question that actually gets asked: *does this sheet
 * open correctly?* Three faults found by hand in one day were all invisible to
 * the suites and obvious in the drawing:
 *
 *   - a library part that netlisted as `UNKNOWN`, so ngspice refused the circuit;
 *   - net names sitting 25 px off their wire, naming nothing, which silently
 *     grounded two inputs of a display;
 *   - a payload whose supply wires were absent, leaving `V4 0 0 DC 12`.
 *
 * Hence one measurement in one place, used by the load suite, the simulation
 * runner and the drag suite alike — four callers asking the same question four
 * different ways is how they end up disagreeing about the answer.
 *
 * Everything here is read off the *canvas's* own geometry (`getNodePins`,
 * `anchorRoutes`), not off the file: there are two pin coordinate systems in
 * this app and the exporter's is not the one the user aims at (see
 * `anchorNets`'s header).
 */

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A name that sits too far from any wire or pin to belong to one. */
export interface LooseAnchor {
  id: string;
  name: string;
  x: number;
  y: number;
  /** Distance to the nearest route, in flow units. */
  dist: number;
}

export interface SheetSurvey {
  nodeCount: number;
  edgeCount: number;
  /** Parts whose symbol yielded no pins at all — nothing can attach to them. */
  pinlessNodes: string[];
  /** Wire ends naming a handle the part does not have. */
  danglingEdges: string[];
  /** Names farther than `ANCHOR_TOLERANCE` from any wire or pin. */
  looseAnchors: LooseAnchor[];
  /** `X` lines whose subcircuit the netlist never defines. */
  danglingSubckts: string[];
  /** The analysis lines the sheet carries (`.tran`, `.ac`, …), lower-cased. */
  analyses: string[];
  netlist: string;
}

/**
 * Subcircuits a netlist instantiates but never defines.
 *
 * `UNKNOWN` is named separately because it is not a missing part but the
 * placeholder for an unlinked one (`CustomSubcircuit.getNetlistLine`) — the two
 * want different fixes, so the report says which it is.
 */
export function danglingSubckts(netlist: string): string[] {
  const defined = new Set<string>();
  for (const l of netlist.split(/\r?\n/)) {
    const m = /^\s*\.subckt\s+(\S+)/i.exec(l);
    if (m) defined.add(m[1].toLowerCase());
  }
  const bad: string[] = [];
  for (const l of netlist.split(/\r?\n/)) {
    if (!/^\s*[Xx]\S*\s/.test(l)) continue;
    // `X<name> <nodes…> <subckt> [params]`: the subcircuit is the last token
    // that is not a `key=value` parameter.
    const tok = l.trim().split(/\s+/).filter((t) => !t.includes("="));
    const name = tok[tok.length - 1];
    if (!name) continue;
    if (name.toUpperCase() === "UNKNOWN") bad.push(`${tok[0]}: unlinked (UNKNOWN)`);
    else if (!defined.has(name.toLowerCase())) bad.push(`${tok[0]}: no .subckt ${name}`);
  }
  return bad;
}

/**
 * Loads a sheet into the store and measures it.
 *
 * Leaves the circuit loaded, so a caller that wants to go on driving it (the
 * drag suite) can, and one that only wants the numbers can ignore that.
 */
export async function surveySheet(ascText: string): Promise<SheetSurvey> {
  st().clearCircuit();
  st().loadFromAsc(ascText);
  // Two ticks: `loadFromAsc` defers `rebuildConnections` by a timeout of its own,
  // and the anchors are only resolved once that has run.
  await tick(); await tick();
  st().rebuildConnections();
  await tick();
  st().regenerateNetlist();
  await tick();

  const s = st();
  const pinsOf = new Map(s.nodes.map((n) => [n.id, getNodePins(n)]));

  const pinlessNodes: string[] = [];
  for (const n of s.nodes) {
    // Junctions and ground carry a single pin; a part with none has no symbol
    // and no fallback, and nothing on the sheet can reach it.
    if ((pinsOf.get(n.id) ?? []).length === 0) {
      pinlessNodes.push(`${n.data?.label ?? n.id} (${n.data?.componentType})`);
    }
  }

  const danglingEdges: string[] = [];
  for (const e of s.edges) {
    for (const [end, id, handle] of [["Quelle", e.source, e.sourceHandle], ["Ziel", e.target, e.targetHandle]] as const) {
      const pins = pinsOf.get(id);
      if (!pins) { danglingEdges.push(`${e.id}: ${end} ${id} fehlt`); continue; }
      if (!pins.some((p) => p.handleId === handle)) {
        danglingEdges.push(`${e.id}: ${end} ${id}:${handle} gibt es nicht`);
      }
    }
  }

  const routes = anchorRoutes({
    nodes: s.nodes, edges: s.edges, circuit: s.circuit,
    netAnchors: s.netAnchors, _anchorBind: s._anchorBind,
  });
  const looseAnchors: LooseAnchor[] = [];
  for (const a of s.netAnchors ?? []) {
    const dist = distToRoutes({ x: a.x, y: a.y }, routes);
    if (dist > ANCHOR_TOLERANCE) looseAnchors.push({ id: a.id, name: a.name, x: a.x, y: a.y, dist });
  }

  const analyses = [...s.spiceDirectives.matchAll(/^\s*\.(tran|ac|dc|op|noise|four)\b/gim)]
    .map((m) => m[1].toLowerCase());

  return {
    nodeCount: s.nodes.length,
    edgeCount: s.edges.length,
    pinlessNodes,
    danglingEdges,
    looseAnchors,
    danglingSubckts: danglingSubckts(s.netlist),
    analyses,
    netlist: s.netlist,
  };
}
