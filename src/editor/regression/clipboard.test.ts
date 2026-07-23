import { useCircuitStore } from "@store/circuitStore.js";
import { buildFragment, isFragment, freeLabel, pasteLabelFor } from "@core/ltspice/ascFragment.js";
import { withSymbols } from "./withSymbols.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { createSubcircuitComponent } from "@editor/componentFactory.js";
import { useUIStore } from "@store/uiStore.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { ghostify } from "@editor/FragmentGhost.js";
import { buildSchematicSvg } from "@editor/svgExport.js";
import { wireRoutes, type PinLookup } from "@core/geometry/wireRoutes.js";
import { getNodePins } from "@editor/pinGeometry.js";

/**
 * Cut / copy / paste of a selection, carried as a `.asc` fragment.
 *
 * The payload is plain `.asc` text on the system clipboard, which is what lets a
 * block be pasted into a *different* schematic — the point of the feature. So
 * the checks here are: does a fragment survive the trip, does the paste land
 * without colliding with what is already there, and does it stay electrically
 * the same circuit.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

/**
 * Net partition of the *device* pins, so nets can be compared across pastes.
 * Restricted by component *id* rather than label, because a pasted ground keeps
 * the label "0" and legitimately joins the original one on net 0 — filtering by
 * label could not tell the two apart.
 */
function connectivity(ids?: Set<string>): string[] {
  const byNet = new Map<string, string[]>();
  for (const [id, comp] of st().circuit.components) {
    if (ids && !ids.has(id)) continue;
    if (id.startsWith("netlabel_") || id.startsWith("netconnector_")) continue;
    for (const p of comp.ports) {
      if (!p.netId) continue;
      const key = String(p.netId);
      if (!byNet.has(key)) byNet.set(key, []);
      byNet.get(key)!.push(`${comp.label}.${p.id.split("-").pop()}`);
    }
  }
  return [...byNet.values()].map((ps) => ps.sort().join(",")).sort();
}

export async function runClipboardTests(): Promise<{ total: number; passed: number; failures: { name: string; reason: string }[] }> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const check = (name: string, ok: boolean, reason = "") => { total++; if (!ok) failures.push({ name, reason }); };

  // ── The pure naming rules ─────────────────────────────────────────────────
  check("a free designator is left alone", freeLabel("R1", new Set(["R2"])) === "R1");
  check("a taken designator moves on", freeLabel("R1", new Set(["R1", "R2"])) === "R3",
    `got ${freeLabel("R1", new Set(["R1", "R2"]))}`);
  check("the prefix survives renumbering", freeLabel("Rload1", new Set(["Rload1"])) === "Rload2",
    `got ${freeLabel("Rload1", new Set(["Rload1"]))}`);
  // A designator with no trailing number must still move on — `RL` beside `RL`
  // is one part declared twice as far as SPICE is concerned.
  check("a designator without a number gets one", freeLabel("RL", new Set(["RL"])) === "RL2",
    `got ${freeLabel("RL", new Set(["RL"]))}`);
  // Net labels keep their name, verified against LTSpice: pasting there
  // duplicates the flag names as they are, and a net may carry several. The
  // merge that follows is reported to the user instead of being prevented.
  check("a net label keeps its name", pasteLabelFor("netlabel", "UE", new Set(["UE"])) === "UE",
    `got ${pasteLabelFor("netlabel", "UE", new Set(["UE"]))}`);
  check("a connector does too", pasteLabelFor("netconnector", "PORT1", new Set(["PORT1"])) === "PORT1");
  check("a device is renumbered", pasteLabelFor("resistor", "R1", new Set(["R1"])) === "R2");
  // …but ground names the ground net wherever it lands.
  check("ground keeps its name", pasteLabelFor("ground", "0", new Set(["0"])) === "0");
  check("a GND label keeps its name", pasteLabelFor("netlabel", "GND", new Set(["GND"])) === "GND");

  check("plain prose is not a fragment", !isFragment("Guten Morgen"));
  check("a schematic is", isFragment("Version 4\nSHEET 1 880 680\nSYMBOL res 0 0 R0"));

  await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const file = path.resolve("examples", "06-2-2_RC_HP1_orig.asc");
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, "latin1");

    // ── Copy everything, paste into the same sheet ──────────────────────────
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();
    st().regenerateNetlist();

    const before = connectivity();
    const idsBefore = new Set(st().circuit.components.keys());
    const deviceCount = [...st().circuit.components.keys()].filter((id) => id.startsWith("comp_")).length;

    const pastedCountBefore = st().edges.length;
    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));
    const fragment = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);
    check("a fragment is produced", fragment.length > 0 && isFragment(fragment));
    check("the fragment carries the parts", (fragment.match(/^SYMBOL /gm) ?? []).length === deviceCount,
      `${(fragment.match(/^SYMBOL /gm) ?? []).length} SYMBOL lines for ${deviceCount} devices`);

    const n = st().pasteFragment(fragment, { x: 600, y: 400 });
    await tick(); await tick();
    st().regenerateNetlist();

    check("the paste inserted something", n > 0, `pasteFragment returned ${n}`);

    // Ids must stay unique across the whole sheet. React Flow keys its elements
    // by id, so a duplicate is not a cosmetic detail: the parser numbers edges
    // from `edge_1` on every run, and a fragment pasted with those ids made the
    // *original* wires vanish from the canvas while the store still held them.
    // Checking connectivity cannot see this — both edges are in the array, only
    // the render collapses them — so it is asserted directly.
    const edgeIds = st().edges.map((e) => e.id);
    check("wire ids stay unique after pasting", new Set(edgeIds).size === edgeIds.length,
      `${edgeIds.length} wires but ${new Set(edgeIds).size} distinct ids: ${edgeIds.join(", ")}`);
    const nodeIds = st().nodes.map((x) => x.id);
    check("part ids stay unique after pasting", new Set(nodeIds).size === nodeIds.length,
      `${nodeIds.length} parts but ${new Set(nodeIds).size} distinct ids`);
    check("the existing wires are still there", st().edges.length > pastedCountBefore,
      `had ${pastedCountBefore} wires before the paste, ${st().edges.length} after`);

    // Designators must not clash — SPICE cannot tell two R1 apart.
    const labels = [...st().circuit.components.values()]
      .filter((c) => !c.id.startsWith("netlabel_") && !c.id.startsWith("netconnector_") && !c.id.startsWith("ground_"))
      .map((c) => c.label);
    check("no duplicate designators after pasting", new Set(labels).size === labels.length,
      `duplicates in: ${labels.sort().join(", ")}`);

    // The original block must be electrically untouched by the paste.
    check("the original block keeps its nets", connectivity(idsBefore).join("|") === before.join("|"),
      `before: ${before.join(" | ")}\n    after:  ${connectivity(idsBefore).join(" | ")}`);

    // And the copy must be wired like the original, not left loose.
    const pastedIds = new Set([...st().circuit.components.keys()].filter((id) => !idsBefore.has(id)));
    check("the pasted block is wired up", pastedIds.size > 0 && connectivity(pastedIds).length === before.length,
      `pasted nets: ${connectivity(pastedIds).length}, original: ${before.length}`);

    // ── Paste into a *different*, empty schematic ───────────────────────────
    // The reason the payload is clipboard text at all.
    st().clearCircuit();
    await tick();
    const m = st().pasteFragment(fragment, { x: 0, y: 0 });
    await tick(); await tick();
    st().regenerateNetlist();

    check("the fragment pastes into another schematic", m > 0, `pasteFragment returned ${m}`);
    check("and rebuilds the same nets there", connectivity().join("|") === before.join("|"),
      `expected: ${before.join(" | ")}\n    got:      ${connectivity().join(" | ")}`);
    check("the netlist is not empty afterwards", /^[RCVL]/im.test(st().netlist),
      `netlist:\n${st().netlist}`);

    // ── A pasted block keeps to itself ──────────────────────────────────────
    // Reported: long strokes ran from the pasted parts back into the schematic
    // they came from. A wire's shape is not carried by its ends alone — the
    // waypoints are absolute coordinates too, and moving only the parts left
    // them behind, so every bent wire reached back to where it was copied from.
    {
      const want = new Set(["D3", "D4", "C1", "RL", "UA1", "UA2"]);
      st().clearCircuit();
      st().loadFromAsc(fs.readFileSync(path.resolve("examples", "05-2-3_Brummspannung1.asc"), "latin1"));
      await tick(); await tick();
      st().setNodes(st().nodes.map((x) => ({ ...x, selected: want.has(String((x.data as { label?: string }).label)) })));
      const frag = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);
      const idsBefore = new Set(st().nodes.map((x) => x.id));
      st().pasteFragment(frag, { x: 100, y: 600 });
      await tick(); await tick();

      const s2 = st();
      const flowPins: PinLookup = {
        at: (nodeId, handle) => {
          const n = s2.nodes.find((x) => x.id === nodeId);
          if (!n) return undefined;
          const p = getNodePins(n).find((q) => q.handleId === handle);
          return p ? { x: p.x, y: p.y } : undefined;
        },
      };
      let oldMax = -Infinity, newMin = Infinity;
      for (const { edge, verts } of wireRoutes(s2.edges, flowPins)) {
        const isNew = !idsBefore.has(edge.source) || !idsBefore.has(edge.target);
        for (const v of verts) {
          if (isNew) newMin = Math.min(newMin, v.y);
          else oldMax = Math.max(oldMax, v.y);
        }
      }
      check("pasted wires stay below the circuit they came from",
        newMin > oldMax,
        `pasted wires start at y=${newMin}, the original still runs to y=${oldMax}`);
    }

    // ── A fragment holds the selection and nothing else ─────────────────────
    // Reported on a partial copy: parts appeared with wires nobody had drawn.
    // Saving a whole schematic wrote a `FLAG` for every named net that had no
    // terminal, because the file had nowhere else to keep the name — in a
    // fragment those are names nobody selected, and each pasted back as a label
    // with a fresh wire to the nearest pin. Four parts produced three flags.
    //
    // A name cannot do that any more: it is not a part, so it can neither be
    // pasted as one nor bring a wire with it. What a fragment must still not do
    // is carry names off nets the selection merely touches.
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();
    {
      const want = new Set(["R1", "C1"]);
      st().setNodes(st().nodes.map((x) => ({ ...x, selected: want.has(String((x.data as { label?: string }).label)) })));
      const partial = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);

      check("a partial copy carries only the parts picked",
        (partial.match(/^SYMBOL /gm) ?? []).length === 2,
        `fragment was:\n${partial}`);
      check("and invents no flags for nets it merely touches",
        !/^FLAG /m.test(partial),
        `unpicked names came along:\n${partial}`);

      const idsBeforePartial = new Set(st().nodes.map((x) => x.id));
      const edgesBefore = st().edges.length;
      st().pasteFragment(partial, { x: 100, y: 600 });
      await tick(); await tick();

      // Exactly the wires the fragment held, and no more. (A wire between the two
      // picked parts is one the user drew, so it comes along by right — what must
      // not appear is a wire the paste invented.)
      const wanted = (partial.match(/^WIRE /gm) ?? []).length;
      const drawn = st().edges.length - edgesBefore;
      check("so pasting it draws no wires of its own", drawn <= wanted,
        `${drawn} wires appeared for ${wanted} in the fragment`);
      // …and none of them reaches back into the circuit it was copied from.
      const reachesBack = st().edges.filter((e) => {
        const a = idsBeforePartial.has(e.source), b = idsBeforePartial.has(e.target);
        return a !== b;
      });
      check("and none of them reaches back into the original", reachesBack.length === 0,
        `${reachesBack.length} wire(s) join the paste to the original`);
    }

    // ── A partial selection drops the wires that leave it ───────────────────
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();
    const one = st().nodes.find((x) => (x.data as { label?: string }).label === "R1")!;
    st().setNodes(st().nodes.map((x) => ({ ...x, selected: x.id === one.id })));
    const single = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);
    check("a single part copies without its wires",
      (single.match(/^SYMBOL /gm) ?? []).length === 1 && !/^WIRE /m.test(single),
      `fragment was:\n${single}`);
  });

  // ── A library part carries its model along ────────────────────────────────
  // A `.asc` names a subcircuit but never defines it, so a fragment on its own
  // would paste into a circuit that has never heard of that model and netlist as
  // `UNKNOWN`. The definition travels with it, as an inline directive.
  {
    const SUB = ".subckt MYAMP in out vcc\nR1 in out 10k\n.ends";
    const lib = useLibraryStore.getState();

    st().clearCircuit();
    await tick();
    lib.addEntries(ModelParser.parse(SUB).entries, "temp");

    const id = "sub_test";
    const comp = createSubcircuitComponent(id, "X1", 0, 0, SUB, ["in", "out", "vcc"]);
    st().addComponent(comp, {
      id, type: "component", position: { x: 0, y: 0 }, selected: true,
      data: { componentType: "subcircuit", label: "X1", subName: "MYAMP", pins: ["in", "out", "vcc"] },
    } as never);
    await tick();

    const frag = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);
    check("the fragment carries the .subckt", /\.subckt\s+MYAMP/i.test(frag),
      `no model in:\n${frag}`);
    check("the model stays on one TEXT line", (frag.match(/^TEXT .*\.subckt/gim) ?? []).length === 1,
      "a multi-line block must not be exploded into one text box per line");

    // Now forget the model entirely — this is the other machine / other session.
    lib.removeEntry("MYAMP");
    st().clearCircuit();
    await tick();
    check("the model is really gone", !useLibraryStore.getState().findByName("MYAMP"));

    st().pasteFragment(frag, { x: 0, y: 0 });
    await tick(); await tick();
    st().regenerateNetlist();

    check("pasting restores the model", !!useLibraryStore.getState().findByName("MYAMP"),
      "the carried .subckt should have been taken into the library");
    check("the pasted part netlists by name, not as UNKNOWN",
      /\bMYAMP\b/.test(st().netlist) && !/UNKNOWN/.test(st().netlist),
      `netlist:\n${st().netlist}`);
    check("the definition lands in the netlist too", /\.subckt\s+MYAMP/i.test(st().netlist),
      `netlist:\n${st().netlist}`);

    useLibraryStore.getState().removeEntry("MYAMP");
  }

  // ── The in-app clipboard, for devices without a keyboard ──────────────────
  // iOS shows its copy/paste callout only on editable elements, so on an iPad
  // without a keyboard the clipboard *events* never fire and the toolbar buttons
  // are the only way in. Those cannot rely on reading the system clipboard —
  // that needs a confirmation the user has to tap, and may be refused outright —
  // so a copy also parks the fragment here.
  await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const file = path.resolve("examples", "06-2-2_RC_HP1_orig.asc");
    if (!fs.existsSync(file)) return;

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));

    const fragment = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);
    st().setFragmentClipboard(fragment);
    check("a copy is remembered in-app", st().fragmentClipboard === fragment);

    // Now paste from that alone, with no system clipboard in play at all — the
    // situation on a device that refuses to hand one over.
    st().clearCircuit();
    await tick();
    check("the in-app copy survives loading another circuit", st().fragmentClipboard === fragment,
      "clearCircuit must not wipe the clipboard — pasting into a fresh sheet is the whole point");

    const n = st().pasteFragment(st().fragmentClipboard, { x: 0, y: 0 });
    await tick(); await tick();
    st().regenerateNetlist();
    check("pasting from the in-app copy works", n > 0 && /^[RCVL]/im.test(st().netlist),
      `inserted ${n}, netlist:\n${st().netlist}`);
  });

  // ── Duplicating a whole block leaves two independent circuits ─────────────
  // The case this was reported on: copying the Brummspannung rectifier and
  // pasting it produced `V1 UE 0` and `V2 UE 0` on the *same* net, both bridges
  // shorted together and `RL` declared twice, because net labels kept their
  // names and a designator without a number was never renumbered. Nothing on
  // screen showed it — only the netlist did.
  await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const file = path.resolve("examples", "05-2-3_Brummspannung1.asc");
    if (!fs.existsSync(file)) return;

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    st().regenerateNetlist();
    // The two nodes of a two-terminal device, i.e. the tokens right after the
    // designator. Anything further along is the value or a waveform spec
    // (`SIN(0V 17V 50Hz)`), which must not be mistaken for a net name.
    const nodesOf = (line: string) => {
      const t = line.trim().split(/\s+/);
      return /^[RCLVID]/i.test(t[0]) ? t.slice(1, 3) : [];
    };

    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));
    st().pasteFragment(buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors), { x: 100, y: 500 });
    await tick(); await tick();
    st().regenerateNetlist();
    const after = st().netlist.split("\n").filter((l) => /^[A-Z]/i.test(l) && !/^\./.test(l));

    const names = after.map((l) => l.trim().split(/\s+/)[0]);
    check("duplicating a block renumbers every device", new Set(names).size === names.length,
      `duplicate designators: ${names.filter((x, i) => names.indexOf(x) !== i).join(", ")}`);

    // No device may sit with both ends on one net — that is the short the merged
    // net names produced.
    const shorted = after.filter((l) => {
      const ns = nodesOf(l);
      return ns.length === 2 && ns[0] === ns[1];
    });
    check("no device ends up shorted across itself", shorted.length === 0,
      `shorted: ${shorted.join(" | ")}`);

    // The copy *does* join the original wherever the net names meet — that is
    // LTSpice's behaviour and stays the default. What must not happen is that it
    // happens silently: the paste reports the names it merged onto.
    const notice = st().pasteNotice ?? [];
    check("the paste reports which net names it joined",
      notice.includes("UE") && notice.includes("UA1") && notice.includes("UA2"),
      `reported: [${notice.join(", ")}]`);
  });

  // ── Carrying a block on the cursor ────────────────────────────────────────
  // LTSpice hands a cut/copied block to the cursor and puts it down on the next
  // click. The clipboard is filled at the same time, because that — not the
  // ghost — is what a paste into another schematic uses later.
  await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const file = path.resolve("examples", "06-2-2_RC_HP1_orig.asc");
    if (!fs.existsSync(file)) return;

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    const partsBefore = st().nodes.length;

    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));
    const fragment = buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors);

    // What a copy does: fill both, so the block can be put down now *and* pasted
    // into another schematic later.
    useUIStore.getState().setPendingFragment(fragment);
    st().setFragmentClipboard(fragment);
    check("a copy hands the block to the cursor", useUIStore.getState().pendingFragment === fragment);
    check("and fills the clipboard as well", st().fragmentClipboard === fragment);

    // Putting it down is what actually inserts it — nothing lands before that.
    check("nothing is inserted while it is only being carried", st().nodes.length === partsBefore,
      `${st().nodes.length} parts, expected ${partsBefore}`);

    st().pasteFragment(useUIStore.getState().pendingFragment!, { x: 600, y: 400 });
    useUIStore.getState().setPendingFragment(null);
    await tick(); await tick();
    check("putting it down inserts it", st().nodes.length > partsBefore,
      `${st().nodes.length} parts, expected more than ${partsBefore}`);
    check("and the cursor is empty afterwards", useUIStore.getState().pendingFragment === null);
    check("while the clipboard still holds it", st().fragmentClipboard === fragment,
      "a paste into another schematic must still be possible after putting the block down");
  });

  // ── The ghost's preview markup ────────────────────────────────────────────
  // Both rewrites here were asserted and not checked the first time, and both
  // silently did nothing: the backdrop pattern expected a self-closing `<rect/>`
  // that React never emits, and the size pattern anchored at the start of a
  // string that begins with `<?xml …?>`. The ghost drew a white card over the
  // schematic and ignored the zoom. Checked against the real markup now.
  await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const file = path.resolve("examples", "05-2-3_Brummspannung1.asc");
    if (!fs.existsSync(file)) return;

    st().clearCircuit();
    st().loadFromAsc(fs.readFileSync(file, "latin1"));
    await tick(); await tick();
    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));

    const { nodes, edges } = LTSpiceParser.parse(buildFragment(st().nodes, st().edges, st().circuit, st().netAnchors));
    const raw = buildSchematicSvg(nodes, edges, "en");
    const ghost = ghostify(raw);

    check("the export really does carry what has to be removed",
      /fill="#ffffff"/.test(raw) && /<svg\b[^>]*width="\d/.test(raw),
      "the fixture stopped exercising the rewrites — they would pass vacuously");
    check("the ghost drops the white backdrop", !/fill="#ffffff"/.test(ghost),
      `still present in: ${ghost.slice(0, 200)}`);
    check("the ghost scales with its container",
      /<svg\b[^>]*width="100%"[^>]*height="100%"/.test(ghost),
      `root tag: ${ghost.slice(0, 200)}`);
    check("the viewBox survives", /viewBox="/.test(ghost),
      "without it the container cannot scale the drawing");
    check("the drawing itself is untouched",
      (ghost.match(/<polyline/g) ?? []).length === (raw.match(/<polyline/g) ?? []).length,
      "the rewrite must only touch the root tag and the backdrop");
  });

  return { total, passed: total - failures.length, failures };
}
