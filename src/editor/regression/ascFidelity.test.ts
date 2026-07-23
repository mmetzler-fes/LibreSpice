import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { canonicalAscLines } from "@core/ltspice/ascPreserve.js";
import { withSymbols } from "./withSymbols.js";

/**
 * File-fidelity guard: opening a `.asc` and saving it again must give back the
 * *same file*, not merely an equivalent circuit.
 *
 * The sibling suite `ascExamples.test.ts` checks that a round-trip preserves the
 * circuit — same devices, same nets. That passed while the exporter was quietly
 * rewriting almost every line it wrote: it re-derived caption `WINDOW`s in our
 * own coordinate convention, reformatted `100nF` to `1.0000000000000001e-7`,
 * relaid directives at a hardcoded position and hardcoded the sheet header. The
 * circuit survived all of it; the file did not. Reopening such a save in LTSpice
 * showed captions stacked in one line and rotated vertical.
 *
 * So this suite compares *text*. Two normalisations are applied, both for
 * differences with no meaning in the format (see `canonicalAscLines`): line
 * order, and a `WIRE`'s endpoint order.
 *
 * A file may not be byte-identical yet, but it may not silently get worse
 * either, so each remaining gap is budgeted below by its exact line count. The
 * budget is an upper bound — a file that improves fails the test until its entry
 * is lowered, which is what keeps the list shrinking rather than rotting.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

/**
 * Remaining fidelity gaps, as the number of differing canonical lines.
 *
 * Most are the same harmless shape: the source drew one long `WIRE` where we
 * emit the equivalent split pair (or vice versa), covering the identical run of
 * pixels. The two that mean something:
 *   - `TGM-Abi2025_A2-2-9`: a source valued `{USt1}` loses the parameter
 *     expression at *import* and comes back as `DC 1`.
 */
const FIDELITY_BUDGET: Record<string, number> = {
  "06-2-3_RC_BP1.asc": 2,
  "InvSummierverstaerker.asc": 4,
  "OP-inv_Verstärker.asc": 4,
  "RL-Parallelkompensation4b.asc": 2,
  "RLC_Reihenschwingkreis.asc": 2,
  "Spannungsteiler_unbelastet.asc": 2,
  "TGM-Abi2025_A2-2-6.asc": 0,
  "TGM-Abi2025_A2-2-9.asc": 2,
  "test.asc": 3,
  "test_belastungskennlinie.asc": 6,
};

/** Node's `fs`/`path`, loaded via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path };
}

/** Save the current store exactly as the Save button does. */
function exportCurrent(): string {
  const s = st();
  return LTSpiceExporter.export(
    s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
    { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires, anchors: s.netAnchors, busTaps: s.busTaps },
  );
}

/** Lines of `a` missing from `b` and vice versa, compared as multisets. */
function lineDiff(a: string[], b: string[]): { lost: string[]; added: string[] } {
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = count(a), cb = count(b);
  const lost: string[] = [], added: string[] = [];
  for (const [l, n] of ca) for (let i = 0; i < n - (cb.get(l) ?? 0); i++) lost.push(l);
  for (const [l, n] of cb) for (let i = 0; i < n - (ca.get(l) ?? 0); i++) added.push(l);
  return { lost, added };
}

/**
 * A duplicate line the source carried more than once and we emit once is
 * deduplication, not loss — several bundled examples were written by an older
 * build that stacked a fresh `FLAG` and `WIRE` on every save.
 */
function realDiff(src: string[], out: string[]): string[] {
  const { lost, added } = lineDiff(src, out);
  const present = new Set(out);
  return [...lost.filter((l) => !present.has(l)), ...added];
}

/**
 * The pixels a schematic's wires cover, independent of how they are cut into
 * `WIRE` lines. Axis-aligned segments on the same line are merged into maximal
 * runs; anything diagonal is kept verbatim.
 *
 * This is the right invariant for "the wire did not change": LTSpice splits a
 * wire at every flag on it, so moving a label along a wire legitimately moves
 * the split — `64→112, 112→160` becomes `64→136, 136→160` — while the run of
 * copper from 64 to 160 is the same. Comparing raw segments would call that a
 * change; comparing coverage does not.
 */
function wireGeometry(text: string): string[] {
  const runs = new Map<string, [number, number][]>();
  const other: string[] = [];
  for (const l of canonicalAscLines(text)) {
    const m = l.match(/^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
    if (!m) continue;
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
    if (y1 === y2) push(`h${y1}`, x1, x2);
    else if (x1 === x2) push(`v${x1}`, y1, y2);
    else other.push(l);
  }
  function push(key: string, a: number, b: number) {
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key)!.push([Math.min(a, b), Math.max(a, b)]);
  }
  const out: string[] = [];
  for (const [key, spans] of runs) {
    spans.sort((p, q) => p[0] - q[0]);
    let [lo, hi] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      // Touching counts as joined: two segments meeting at a flag are one wire.
      if (a <= hi) hi = Math.max(hi, b);
      else { out.push(`${key} ${lo}-${hi}`); [lo, hi] = [a, b]; }
    }
    out.push(`${key} ${lo}-${hi}`);
  }
  return [...out, ...other].sort();
}

export async function runAscFidelityTests(): Promise<{ total: number; passed: number; failures: { name: string; reason: string }[] }> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const fail = (name: string, reason: string) => { failures.push({ name, reason }); };

  return await withSymbols(async () => {
  const { fs, path } = await nodeApi();
  const dir = path.resolve("examples");
  const files: string[] = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f: string) => f.endsWith(".asc")).sort()
    : [];

  // ── 1. Open → Save must reproduce the file ─────────────────────────────────
  for (const file of files) {
    total++;
    const name = `save reproduces ${file}`;
    try {
      // latin1: the examples carry characters like `10µF`.
      const src = fs.readFileSync(path.join(dir, file), "latin1");
      st().clearCircuit();
      st().loadFromAsc(src);
      await tick(); await tick();

      const diff = realDiff(canonicalAscLines(src), canonicalAscLines(exportCurrent()));
      const budget = FIDELITY_BUDGET[file] ?? 0;
      if (diff.length > budget) {
        fail(name, `${diff.length} lines differ (budget ${budget}):\n    ${diff.slice(0, 12).join("\n    ")}`);
      } else if (diff.length < budget) {
        fail(name, `only ${diff.length} lines differ but the budget still allows ${budget} — lower FIDELITY_BUDGET["${file}"] to ${diff.length}`);
      }
    } catch (e) {
      fail(name, `threw: ${(e as Error).message}`);
    }
  }

  // ── 2. Rotating a part must not disturb anything but that part ─────────────
  // The bug this suite exists for: rotating one capacitor rewrote every symbol's
  // caption windows, every value's spelling and the directive's position.
  total++;
  try {
    const src = fs.readFileSync(path.join(dir, "06-2-2_RC_HP1_orig.asc"), "latin1");
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();

    const before = exportCurrent();
    const cap = st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "capacitor");
    if (!cap) throw new Error("no capacitor in the fixture");
    st().setSelectedComponentId(cap.id);
    st().rotateSelected();
    await tick(); await tick();
    const after = exportCurrent();

    // Everything that is not the rotated symbol's own placement must be untouched.
    const settled = (t: string) =>
      canonicalAscLines(t).filter((l) => !/^SYMBOL /.test(l) && !/^WIRE /.test(l));
    const diff = realDiff(settled(before), settled(after));
    if (diff.length) {
      fail("rotating a part touches only that part", `${diff.length} unrelated lines changed:\n    ${diff.join("\n    ")}`);
    }
  } catch (e) {
    fail("rotating a part touches only that part", `threw: ${(e as Error).message}`);
  }

  // ── 3. Moving a name must not move its wire ────────────────────────────────
  // A `FLAG` marks a coordinate on a wire; it is not a joint in it. Dragging the
  // label used to drag the wire's endpoint, which is what turned a straight run
  // into a diagonal in the reported schematic. Now that a name is an anchor
  // rather than a node with a pin, this holds by construction — the check stays
  // because it is the regression that motivated the whole model.
  total++;
  try {
    const src = fs.readFileSync(path.join(dir, "06-2-2_RC_HP1_orig.asc"), "latin1");
    st().clearCircuit();
    st().loadFromAsc(src);
    await tick(); await tick();

    const before = wireGeometry(exportCurrent());

    // `U1` sits mid-wire between the source and the capacitor — the case that
    // used to bend the wire. Nudge it along the wire and off it by a few pixels.
    const label = st().netAnchors.find((a) => a.name === "U1");
    if (!label) throw new Error("no U1 name in the fixture");
    st().moveNetAnchor(label.id, label.x + 24, label.y - 8);
    await tick(); await tick();

    const after = wireGeometry(exportCurrent());
    if (before.join("\n") !== after.join("\n")) {
      fail("moving a name leaves the wire alone",
        `wire geometry changed:\n  before:\n    ${before.join("\n    ")}\n  after:\n    ${after.join("\n    ")}`);
    }
  } catch (e) {
    fail("moving a name leaves the wire alone", `threw: ${(e as Error).message}`);
  }

  return { total, passed: total - failures.length, failures };
  });
}
