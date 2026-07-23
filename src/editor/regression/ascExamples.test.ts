import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * File-compatibility guard for every bundled `examples/*.asc`. For each file it
 * does exactly what the app's Open→Save does: parse the LTSpice `.asc`
 * (`loadFromAsc`), write it back out (`LTSpiceExporter.export`) to a *temporary*
 * file, then read that file and parse it again. The re-import must reproduce:
 *   1. the same set of real devices (InstNames),
 *   2. the same electrical connectivity — the partition of device pins into nets
 *      (compared by device label + pin, so net renumbering doesn't matter), and
 *   3. a structurally stable export — the WIRE / FLAG / IOPIN / SYMBOL line counts
 *      of the two successive exports agree (the exporter is a fixed point).
 * A parser/exporter change that silently drops, duplicates or rewires anything on
 * save therefore breaks the test.
 *
 * The suite is data-driven: it enumerates the examples directory at run time, so
 * a newly added `.asc` is covered automatically with no code change here.
 *
 * This suite only runs under Node (the regression runner); the node builtins are
 * pulled in through indirect dynamic imports so the browser-oriented `tsc` build
 * needn't know about `@types/node`.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

/**
 * Files with a *pre-existing* exporter fidelity gap (unrelated to net
 * connectors): they still must load, export a valid header and keep their device
 * list, but the strict connectivity / line-count round-trip checks are skipped.
 * Documented so the gap is visible and a future fix can drop the entry.
 */
const KNOWN_ROUNDTRIP_ISSUES: Record<string, string> = {
  // (currently none — every bundled example round-trips under the strict checks)
};

/** Node's `fs`/`path`/`os`, loaded via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path, os] = await Promise.all([load("node:fs"), load("node:path"), load("node:os")]);
  return { fs, path, os, proc: (globalThis as any).process };
}

/** True for a real device (a placed symbol), excluding net-label terminals which
 *  are re-materialised from FLAGs and legitimately shift identity on a round-trip. */
const isDevice = (id: string) => !id.startsWith("netlabel_");

/** Sorted InstNames of the real devices. */
function deviceLabels(): string[] {
  const out: string[] = [];
  for (const [id, comp] of st().circuit.components) {
    if (isDevice(id)) out.push(comp.label);
  }
  return out.sort();
}

/**
 * Canonical electrical-connectivity signature: the partition of *device* pins
 * into nets, each pin named `label:handle` (not by net id). Net renumbering or
 * component-id churn across a round-trip doesn't change it, but moving a pin to a
 * different net — or losing a wire that joined two — does.
 */
function connectivity(): string[] {
  const byNet = new Map<string, string[]>();
  for (const [id, comp] of st().circuit.components) {
    if (!isDevice(id)) continue;
    for (const port of comp.ports) {
      if (!port.netId) continue;
      const handle = port.id.slice(comp.id.length + 1);
      const list = byNet.get(port.netId) ?? [];
      list.push(`${comp.label}:${handle}`);
      byNet.set(port.netId, list);
    }
  }
  // Drop nets with a single pin (nothing is connected there) and canonicalise:
  // sort members within a net, then sort the nets by their member string.
  return [...byNet.values()]
    .filter((members) => members.length >= 2)
    .map((members) => members.sort().join(" + "))
    .sort();
}

/** Counts of the structural line types in an `.asc`, to compare two exports. */
function lineCounts(asc: string): Record<string, number> {
  const count = (re: RegExp) => (asc.match(re) ?? []).length;
  return {
    WIRE: count(/^WIRE\b/gm),
    FLAG: count(/^FLAG\b/gm),
    IOPIN: count(/^IOPIN\b/gm),
    SYMBOL: count(/^SYMBOL\b/gm),
  };
}

/** Load an `.asc` string into the store and wait for its deferred net rebuild. */
async function load(asc: string): Promise<void> {
  st().clearCircuit();
  st().loadFromAsc(asc);
  await tick(); // loadFromAsc rebuilds connections/labels on a microtask
}

type Failure = { name: string; reason: string };

export async function runAscExamplesTests(): Promise<TestReport> {
  const { fs, path, os, proc } = await nodeApi();
  const failures: Failure[] = [];
  let total = 0, failed = 0;

  // examples/ sits at the repo root; the editor test runner is invoked there.
  const dir = path.resolve(proc.cwd(), "examples");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f: string) => f.toLowerCase().endsWith(".asc")).sort();
  } catch {
    return { total: 1, passed: 0, failures: [{ name: "examples directory is readable", reason: `cannot read ${dir}` }] };
  }
  if (files.length === 0) {
    return { total: 1, passed: 0, failures: [{ name: "examples has .asc files", reason: `no .asc under ${dir}` }] };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "librespice-asc-"));

  for (const file of files) {
    total++;
    const name = `round-trips ${file}`;
    let f = false;
    const fail = (reason: string) => { failures.push({ name, reason }); f = true; };
    try {
      // LTSpice writes .asc in Windows-1252; read as latin1 so bytes like µ (0xB5)
      // survive rather than becoming replacement characters.
      const original = fs.readFileSync(path.join(dir, file), "latin1");

      await load(original);
      const beforeDevices = deviceLabels();
      const beforeNets = connectivity();

      const export1 = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, [], [], { anchors: st().netAnchors, busTaps: st().busTaps });
      if (!/^Version\s+\d/m.test(export1)) {
        fail(`export produced no LTSpice header:\n${export1.slice(0, 120)}`);
      } else {
        // Save to a real temp file and read it back, exactly like a save/open.
        const tmpFile = path.join(tmp, file);
        fs.writeFileSync(tmpFile, export1, "latin1");
        const reloaded = fs.readFileSync(tmpFile, "latin1");

        await load(reloaded);
        const afterDevices = deviceLabels();
        const afterNets = connectivity();
        const export2 = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, [], [], { anchors: st().netAnchors, busTaps: st().busTaps });

        const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
        const known = file in KNOWN_ROUNDTRIP_ISSUES;
        if (!same(beforeDevices, afterDevices)) {
          // The device list must survive even for known-issue files.
          fail(`device set changed:\n  before (${beforeDevices.length}): ${beforeDevices.join(", ")}\n  after  (${afterDevices.length}): ${afterDevices.join(", ")}`);
        } else if (known) {
          // Strict connectivity / line-count checks are waived here — see the map.
        } else if (!same(beforeNets, afterNets)) {
          fail(`connectivity changed:\n  before:\n    ${beforeNets.join("\n    ")}\n  after:\n    ${afterNets.join("\n    ")}`);
        } else {
          const c1 = lineCounts(export1), c2 = lineCounts(export2);
          const drift = Object.keys(c1).filter((k) => c1[k] !== c2[k]);
          if (drift.length) {
            fail(`export line counts drifted for ${drift.join(", ")}: ${drift.map((k) => `${k} ${c1[k]}→${c2[k]}`).join("; ")}`);
          }
        }
      }
    } catch (e) {
      fail(`threw: ${(e as Error).message}`);
    }
    if (f) failed++;
  }

  return { total, passed: total - failed, failures };
}
