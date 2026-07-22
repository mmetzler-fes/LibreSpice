import { useCircuitStore } from "@store/circuitStore.js";
import { buildFragment, isFragment, freeLabel, pasteLabelFor } from "@core/ltspice/ascFragment.js";
import { withSymbols } from "./withSymbols.js";

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
  // A net name is a *connection*, not an identity: pasting a block whose input is
  // called UE next to a circuit that has UE is how the two get joined.
  check("a net label keeps its name", pasteLabelFor("netlabel", "UE", new Set(["UE"])) === "UE");
  check("a device does not", pasteLabelFor("resistor", "R1", new Set(["R1"])) === "R2");

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

    st().setNodes(st().nodes.map((n) => ({ ...n, selected: true })));
    const fragment = buildFragment(st().nodes, st().edges, st().circuit);
    check("a fragment is produced", fragment.length > 0 && isFragment(fragment));
    check("the fragment carries the parts", (fragment.match(/^SYMBOL /gm) ?? []).length === deviceCount,
      `${(fragment.match(/^SYMBOL /gm) ?? []).length} SYMBOL lines for ${deviceCount} devices`);

    const n = st().pasteFragment(fragment, { x: 600, y: 400 });
    await tick(); await tick();
    st().regenerateNetlist();

    check("the paste inserted something", n > 0, `pasteFragment returned ${n}`);

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

    // ── A partial selection drops the wires that leave it ───────────────────
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();
    const one = st().nodes.find((x) => (x.data as { label?: string }).label === "R1")!;
    st().setNodes(st().nodes.map((x) => ({ ...x, selected: x.id === one.id })));
    const single = buildFragment(st().nodes, st().edges, st().circuit);
    check("a single part copies without its wires",
      (single.match(/^SYMBOL /gm) ?? []).length === 1 && !/^WIRE /m.test(single),
      `fragment was:\n${single}`);
  });

  return { total, passed: total - failures.length, failures };
}
