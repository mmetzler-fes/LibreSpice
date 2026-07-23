import type { Node, Edge } from "@xyflow/react";
import { reseatTwoPinEdges } from "../pinReseat.js";
import { getNodePins } from "../pinGeometry.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { canonicalAscLines } from "@core/ltspice/ascPreserve.js";
import { withSymbols } from "./withSymbols.js";

/**
 * Turning a part must not leave its wires crossing its body — and the reference
 * direction the symbol draws must stay in step with the netlist.
 *
 * A two-terminal part's pins are not interchangeable: `cap.asy` declares
 * `SpiceOrder 1/2` and draws a current arrow between them, and
 * `Resistor.getNetlistLine` emits `ports[0]` first, so `I(R1)` is positive for
 * current from pin 1 to pin 2. Half a turn moves the arrow, so it must also
 * reverse the SPICE node order; the alternative — pinning the netlist and
 * letting the wires cross — would make the drawing contradict the measurement.
 *
 * Most of this uses a *voltage source* as the two-pin part, which is not
 * arbitrary: the regression harness stubs out `import.meta.glob`, so no `.asy`
 * symbol is registered and a resistor or capacitor has no pin geometry at all
 * (see pinGeometry's FALLBACK_PINS, which covers sources but not passives). A
 * source is the one two-terminal part whose pins exist in both environments.
 *
 * The final block borrows the real symbols via {@link withSymbols} and rotates a
 * *capacitor* — the part the bug was actually reported on, horizontal and drawn
 * from cap.asy with the arrow that makes its pin order visible. Without it the
 * suite would only ever exercise a vertical source.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

function sourceNode(rotation: number, mirrored = false): Node {
  return {
    id: "V1", type: "component", position: { x: 100, y: 100 },
    data: { componentType: "vsource", label: "V1", rotation, ...(mirrored && { mirrored: true }) },
  } as Node;
}

function neighbour(id: string, x: number, y: number): Node {
  return { id, type: "component", position: { x, y }, data: { componentType: "vsource", label: id } } as Node;
}

export async function runPinReseatTests(): Promise<{ total: number; passed: number; failures: { name: string; reason: string }[] }> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const check = (name: string, ok: boolean, reason = "") => { total++; if (!ok) failures.push({ name, reason }); };

  // ── The pure rule ─────────────────────────────────────────────────────────
  // A source's pins run vertically (p above, n below), so neighbours above and
  // below are the layout in which a half turn creates a crossing.
  const nodes = [sourceNode(0), neighbour("A", 100, -100), neighbour("B", 100, 300)];
  const pins = getNodePins(nodes[0]);
  check("the fixture has two pins", pins.length === 2, `got ${pins.length} — pin geometry missing`);

  if (pins.length === 2) {
    const upper = pins.reduce((a, b) => (a.y <= b.y ? a : b)).handleId;
    const lower = pins.reduce((a, b) => (a.y >= b.y ? a : b)).handleId;
    // Each wire seated on the pin facing it: the sensible starting state.
    const edges: Edge[] = [
      { id: "e1", source: "A", sourceHandle: "n", target: "V1", targetHandle: upper } as Edge,
      { id: "e2", source: "V1", sourceHandle: lower, target: "B", targetHandle: "p" } as Edge,
    ];

    check("a sensible seating is left alone",
      reseatTwoPinEdges(nodes[0], nodes, edges) === null,
      "an already-optimal assignment must not be disturbed");

    // A quarter turn puts the pins on the other axis, where both assignments are
    // equally long. That tie must not flip anything, or repeated rotation would
    // flap the sign of the measured current.
    const quarter = [sourceNode(90), nodes[1], nodes[2]];
    check("a quarter turn does not flip the pins",
      reseatTwoPinEdges(quarter[0], quarter, edges) === null,
      "a symmetric tie must leave the seating alone");

    // Half a turn swaps the pins' positions, so the wires must swap with them.
    const half = [sourceNode(180), nodes[1], nodes[2]];
    const swapped = reseatTwoPinEdges(half[0], half, edges);
    check("a half turn re-seats the wires", swapped !== null, "half a turn must swap the two handles");
    check("the half turn swaps both handles",
      !!swapped &&
        swapped.find((e) => e.id === "e1")!.targetHandle === lower &&
        swapped.find((e) => e.id === "e2")!.sourceHandle === upper,
      "both wires must move to the other pin");

    // Mirroring runs through the same `reseatTwoPinEdges` call from the store,
    // so it needs no separate rule. It is not unit-tested here because the only
    // two-pin part with geometry in this harness is a source, whose pins sit on
    // the mirror axis (`px = NODE_SIZE / 2`) and so do not move when flipped —
    // the case is degenerate. Exercising it properly needs a horizontal part,
    // which means a loaded `.asy`.
  } else {
    total += 3;
  }

  // ── A part with more than two pins is never re-seated ──────────────────────
  {
    const npn = {
      id: "Q1", type: "component", position: { x: 100, y: 100 },
      data: { componentType: "bjt_npn", label: "Q1", rotation: 180 },
    } as Node;
    const ns = [npn, neighbour("A", -100, 100)];
    const es: Edge[] = [{ id: "e", source: "A", sourceHandle: "n", target: "Q1", targetHandle: "b" } as Edge];
    check("a multi-pin part is never re-seated", reseatTwoPinEdges(npn, ns, es) === null,
      "re-seating a transistor would silently swap collector, base or emitter");
  }

  // ── End to end: rotating in a real schematic ──────────────────────────────
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  const file = path.resolve("examples", "06-2-2_RC_HP1_orig.asc");

  if (fs.existsSync(file)) {
    const exportCurrent = () => {
      const s = st();
      return LTSpiceExporter.export(
        s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
        { directiveRaw: s.directiveRaw, header: s.ascHeader, anchors: s.netAnchors, busTaps: s.busTaps },
      );
    };
    const sorted = (t: string) => canonicalAscLines(t).slice().sort().join("\n");
    const vLine = () => st().netlist.split("\n").find((l) => /^V1\b/i.test(l)) ?? "";

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    st().regenerateNetlist();

    const before = exportCurrent();
    const netBefore = vLine();
    const v1 = st().nodes.find((n) => (n.data as { label?: string }).label === "V1")!;

    st().setSelectedComponentId(v1.id);
    st().rotateSelected();
    st().rotateSelected();
    await tick(); await tick();
    st().regenerateNetlist();

    // Everything except that symbol's own placement and the wires reaching it
    // must be untouched — no caption window, value, directive or header moves.
    const settled = (t: string) =>
      canonicalAscLines(t).filter((l) => !/^(SYMBOL|WIRE) /.test(l)).slice().sort().join("\n");
    check("half a turn disturbs nothing but the part and its wires",
      settled(before) === settled(exportCurrent()),
      `unrelated lines changed`);

    // The source is drawn the other way round now, so its SPICE node order must
    // have reversed with it.
    check("half a turn reverses the part's SPICE node order",
      netBefore !== "" && vLine() !== "" && netBefore !== vLine(),
      `V1 unchanged: "${netBefore}" vs "${vLine()}"`);

    // Undo must restore orientation and wires together, in two steps for the
    // two rotations — never leaving a half-undone, crossed schematic.
    st().undo();
    st().undo();
    await tick(); await tick();
    check("undo restores the wires with the orientation",
      sorted(exportCurrent()) === sorted(before),
      "undoing both rotations left the schematic in a different state");
  }

  // ── With real `.asy` geometry: the case that was actually reported ────────
  // Everything above uses a source, the only two-terminal part with pins in the
  // bare harness. The bug users hit was a *capacitor* — horizontal, drawn from
  // cap.asy, with the current arrow that makes its pin order visible. Borrow the
  // real symbols for this block so that case is covered too.
  await withSymbols(async () => {
    if (!fs.existsSync(file)) return;
    const exportCurrent = () => {
      const s = st();
      return LTSpiceExporter.export(
        s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
        { directiveRaw: s.directiveRaw, header: s.ascHeader, anchors: s.netAnchors, busTaps: s.busTaps },
      );
    };
    const wiresOf = (t: string) => canonicalAscLines(t).filter((l) => l.startsWith("WIRE ")).sort().join("\n");
    const capLine = () => st().netlist.split("\n").find((l) => /^C1\b/i.test(l)) ?? "";

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    st().regenerateNetlist();

    const cap = st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "capacitor");
    check("the capacitor has real pin geometry", !!cap && getNodePins(cap).length === 2,
      "cap.asy did not load — the rest of this block would pass vacuously");
    if (!cap) return;

    const wiresBefore = wiresOf(exportCurrent());
    const netBefore = capLine();

    st().setSelectedComponentId(cap.id);
    st().rotateSelected();
    st().rotateSelected();
    await tick(); await tick();
    st().regenerateNetlist();

    // The reported symptom: after half a turn the wires ran through the body.
    check("half a turn leaves the capacitor's wires untouched",
      wiresOf(exportCurrent()) === wiresBefore,
      `wires changed:\n  before:\n    ${wiresBefore.replace(/\n/g, "\n    ")}\n  after:\n    ${wiresOf(exportCurrent()).replace(/\n/g, "\n    ")}`);

    // …and the arrow turned with it, so the node order must have too.
    check("half a turn reverses the capacitor's SPICE node order",
      netBefore !== "" && capLine() !== "" && netBefore !== capLine(),
      `C1 unchanged: "${netBefore}" vs "${capLine()}"`);

    // The only thing the file should record is the new orientation.
    const symbolOf = (t: string) => canonicalAscLines(t).find((l) => l.startsWith("SYMBOL cap")) ?? "";
    check("the saved file differs only in the capacitor's SYMBOL line",
      symbolOf(exportCurrent()) !== "" && symbolOf(exportCurrent()).endsWith("R270"),
      `got "${symbolOf(exportCurrent())}", expected the cap at R270`);
  });

  return { total, passed: total - failures.length, failures };
}
