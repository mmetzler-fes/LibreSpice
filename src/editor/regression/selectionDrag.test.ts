import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { resolveAnchors } from "@editor/anchorNets.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Moving a selection must not rewire the circuit.
 *
 * `dragCarry.test.ts` holds one specific case — a name near the moved end of a
 * wire that crosses the selection boundary. This is the general property, over
 * real sheets rather than a four-line rig: pick up parts and names, put them
 * down somewhere else, and the circuit has to be the one it was. Grabbing a
 * block and moving it aside is what a user does constantly while drawing, and it
 * is the operation that has broken names twice — once by leaving them behind
 * when their wire moved (`6dfe1a5`), once by skipping the rebuild that would
 * have re-fastened them (`2ee24e5`).
 *
 * The invariant is deliberately not "the name is still near a wire". A name can
 * sit on a wire and name the *wrong* net — that is exactly how the frequency
 * divider grounded two display inputs — so what is compared is the electrical
 * fact: for every name, the set of device terminals on the net it names. That
 * survives net renumbering (`net3` becoming `net7` is not a change) and catches
 * a name that quietly changed sides.
 *
 * Three moves per sheet:
 *
 *   1. everything at once — a rigid translation, where nothing about the
 *      geometry changes and any difference is a bug with no excuses;
 *   2. half of it — wires stretch, which is where a name can be left behind;
 *   3. save and reopen afterwards — because a rewiring that only shows up in the
 *      file is the worst kind: it is already on disk before anyone sees it.
 */

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Sheets to drag, chosen for having many names over a real circuit.
 *
 * Missing files are skipped, not failed: `examples/` is git-ignored, so a fresh
 * clone has almost none of it (see `sheetLoad.test.ts`).
 */
const SHEETS = [
  "examples/6_2_1_Asynchroner_Frequenzteiler_Lsg.asc",
  "examples/OP-inv_Verstärker.asc",
  "examples/OP-nicht_inv_Verstärker.asc",
  "examples/Rechteckgenerator.asc",
  "examples/TGM-Abi2025_A2-2-2.asc",
  "examples/TGM-Abi2025_A2-2-5.asc",
  "examples/TGM-Abi2025_A2-2-9.asc",
];

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path, proc: (globalThis as any).process };
}

/**
 * What each name is electrically attached to: name → the device terminals on
 * its net, sorted.
 *
 * Keyed by the name's text and coordinates rather than by anchor id, so the
 * comparison still works across a save and reload, which mints new ids. Two
 * names of the same text on one sheet are common (a supply rail is named at
 * both ends), so the key carries the name only — their port lists are equal by
 * construction when they name the same net, and differ when they do not, which
 * is the thing being watched.
 */
function attachment(): Map<string, string> {
  const s = st();
  const resolved = resolveAnchors(s, "default");
  const portsOfNet = new Map<string, string[]>();
  for (const comp of s.circuit.components.values()) {
    for (const port of comp.ports) {
      if (!port.netId) continue;
      const key = `${comp.label}:${port.name}`;
      portsOfNet.set(port.netId, [...(portsOfNet.get(port.netId) ?? []), key]);
    }
  }
  const out = new Map<string, string>();
  for (const a of s.netAnchors ?? []) {
    const netId = resolved.get(a.id);
    const ports = netId ? [...(portsOfNet.get(netId) ?? [])].sort() : [];
    // A name reaching nothing is recorded as such rather than skipped: going
    // from attached to unattached is the failure this exists to catch.
    const prev = out.get(a.name);
    const desc = netId ? (ports.join(",") || `(net ${netId}, no device pins)`) : "NICHTS";
    // Same name twice must describe the same net; if it does not, say so.
    out.set(a.name, prev && prev !== desc ? `${prev} / ${desc}` : desc);
  }
  return out;
}

/** Differences between two attachment maps, as readable lines. */
function diffAttachment(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [name, was] of before) {
    const now = after.get(name);
    if (now === undefined) out.push(`${name}: verschwunden`);
    else if (now !== was) out.push(`${name}: ${was} -> ${now}`);
  }
  for (const name of after.keys()) if (!before.has(name)) out.push(`${name}: neu aufgetaucht`);
  return out;
}

/**
 * Plays a drag exactly as `SchematicCanvas` does it (see
 * `onNodeDragStart`/`onNodeDrag`/`onNodeDragStop`): the names on wires wholly
 * inside the moving set travel live, and one rebuild runs at the end.
 */
async function dragSelection(movingIds: Set<string>, dx: number, dy: number): Promise<void> {
  const before = st();
  const inner = before.edges.filter((e) => movingIds.has(e.source) && movingIds.has(e.target));
  const carried = resolveAnchors(
    {
      nodes: before.nodes.filter((n) => movingIds.has(n.id)),
      edges: inner,
      netAnchors: before.netAnchors,
      circuit: before.circuit,
    },
    "default",
  );
  st().setNodes(st().nodes.map((n) => (movingIds.has(n.id)
    ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
    : n)));
  st().moveNetAnchorsBy([...carried.keys()], dx, dy);
  // The wires inside the block carry their drawn shape, or their corners stay
  // behind and the wire re-routes into something nobody drew — which is how a
  // name ends up on a wire it was never on (see `moveEdgeShapesBy`).
  st().moveEdgeShapesBy(inner.map((e) => e.id), dx, dy);
  await tick();
  st().rebuildConnections();
  await tick();
}

/** Loads a sheet and settles it. */
async function open(ascText: string): Promise<void> {
  st().clearCircuit();
  st().loadFromAsc(ascText);
  await tick(); await tick();
  st().rebuildConnections();
  await tick();
}

/** Save exactly as the Save button does. */
function exportCurrent(): string {
  const s = st();
  return LTSpiceExporter.export(
    s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
    { directiveRaw: s.directiveRaw, header: s.ascHeader, anchors: s.netAnchors, busTaps: s.busTaps },
  );
}

type Check = { name: string; reason: string };

export async function runSelectionDragTests(): Promise<TestReport> {
  return await withSymbols(async () => {
    const { fs, path, proc } = await nodeApi();
    const failures: Check[] = [];
    let total = 0;

    for (const rel of SHEETS) {
      const file = path.join(proc.cwd(), rel);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, "latin1");
      const short = path.basename(rel);

      // ── 1. Everything moves ──────────────────────────────────────────────
      total++;
      try {
        await open(src);
        const before = attachment();
        if (before.size === 0) throw new Error("das Blatt hat keine Netznamen");
        await dragSelection(new Set(st().nodes.map((n) => n.id)), 128, 64);
        const diff = diffAttachment(before, attachment());
        if (diff.length) {
          failures.push({
            name: `${short}: die ganze Auswahl verschieben aendert nichts`,
            reason: diff.slice(0, 5).join(" | "),
          });
        }
      } catch (e) {
        failures.push({ name: `${short}: die ganze Auswahl verschieben aendert nichts`, reason: `wirft: ${(e as Error).message}` });
      }

      // ── 2. Half of it moves ──────────────────────────────────────────────
      total++;
      try {
        await open(src);
        const before = attachment();
        // Split by x at the median, so both halves hold parts and the wires
        // between them have to stretch — that is where a name gets left behind.
        const xs = st().nodes.map((n) => n.position.x).sort((a, b) => a - b);
        const mid = xs[Math.floor(xs.length / 2)];
        const moving = new Set(st().nodes.filter((n) => n.position.x < mid).map((n) => n.id));
        if (moving.size === 0 || moving.size === st().nodes.length) throw new Error("keine echte Teilauswahl moeglich");
        // Straight up: a vertical move keeps every stretched wire on its own
        // column, so no wire is dragged sideways across a part it never touched.
        await dragSelection(moving, 0, -128);
        const diff = diffAttachment(before, attachment());
        if (diff.length) {
          failures.push({
            name: `${short}: die halbe Auswahl verschieben aendert nichts`,
            reason: diff.slice(0, 5).join(" | "),
          });
        }
      } catch (e) {
        failures.push({ name: `${short}: die halbe Auswahl verschieben aendert nichts`, reason: `wirft: ${(e as Error).message}` });
      }

      // ── 3. And it survives the file ──────────────────────────────────────
      total++;
      try {
        await open(src);
        await dragSelection(new Set(st().nodes.map((n) => n.id)), 128, 64);
        const moved = attachment();
        await open(exportCurrent());
        const diff = diffAttachment(moved, attachment());
        if (diff.length) {
          failures.push({
            name: `${short}: verschoben, gespeichert, wieder geoeffnet`,
            reason: diff.slice(0, 5).join(" | "),
          });
        }
      } catch (e) {
        failures.push({ name: `${short}: verschoben, gespeichert, wieder geoeffnet`, reason: `wirft: ${(e as Error).message}` });
      }
    }

    if (total === 0) {
      return { total: 1, passed: 0, failures: [{ name: "selection drag", reason: "keine der Beispieldateien gefunden" }] };
    }
    return { total, passed: total - failures.length, failures };
  });
}
