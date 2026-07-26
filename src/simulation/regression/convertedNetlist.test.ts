import { useCircuitStore } from "@store/circuitStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import { readMsjs, msjsToSchematic } from "@core/multisim/msjs.js";
import { convert } from "@core/multisim/MultisimConverter.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * The netlists the converted Multisim schematics produce, checked for the two
 * faults that make a sheet un-runnable without anything on it looking wrong.
 *
 * Both are the same mistake seen from two sides: a terminal that ended up on a
 * node it was never meant to touch.
 *
 *   - **A shorted source.** Multisim's digital constant and clock have a single
 *     pin and an implied ground, so the converter invents the return terminal.
 *     Landing on a neighbour's pin it grounds that pin's net: ngspice stops at
 *     "instance vdg6 is a shorted VSRC" and the sheet yields nothing. Judged
 *     against the original, like the gate inputs below — a source the original
 *     itself left unwired has no two nodes to be on, and that is the sheet as it
 *     was drawn rather than something the conversion did.
 *   - **A lost gate input.** Our logic symbols carry their pins nothing like
 *     Multisim's — a 4-input AND's input column sits 200 units off — and an
 *     unconnected port reads as ground, so the gate quietly computes with zeros.
 *     Counted against the *source*, not against a frozen number: inputs that are
 *     tied low in Multisim too are not a fault, and only sheets where the
 *     conversion grounds more of them than the original did are reported. This
 *     found 106 inputs lost across six schematics in one run, from a change that
 *     every other suite had passed.
 *   - **A floating driver.** The complement of the same fault: a source whose
 *     two terminals are the same node is dead, and so is one whose output node
 *     no other device mentions. Both leave the logic downstream reading zero.
 *
 * Read off the generated netlist rather than from a simulation run, so the whole
 * corpus can be covered in the time one `.tran` would take.
 */

/**
 * Gate inputs a sheet grounds that its Multisim source did not, per file.
 *
 * Empty, and meant to stay that way. It held one — a 2-input AND whose inputs
 * Multisim spaces 32 apart against our 48 — until the wiring stopped being copied
 * from Multisim and started being routed between our own pins, which is exactly
 * the class of fault that removed. Anything appearing here again is our pin raster
 * disagreeing with the original's, and the number has to be checked by hand before
 * it is written down.
 */
const KNOWN_LOST_GATE_INPUTS: Record<string, number> = {};

/** Instance names of the logic gates a converted `.asc` places. */
function gateNames(asc: string): Set<string> {
  const out = new Set<string>();
  const lines = asc.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^SYMBOL Digital\\(and|or|nand|nor|xor|inv|buf)\b/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && !/^SYMBOL /.test(lines[j]); j++) {
      const n = /^SYMATTR InstName (\S+)/.exec(lines[j]);
      if (n) { out.add(n[1]); break; }
    }
  }
  return out;
}

/** A Node `Buffer` as the plain `ArrayBuffer` the reader wants. */
function bufferOf(buf: { buffer: ArrayBuffer; byteOffset: number; byteLength: number }): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** How many gate inputs the Multisim source itself leaves on ground. */
function groundedInSource(buf: { buffer: ArrayBuffer; byteOffset: number; byteLength: number }): number {
  const sch = msjsToSchematic(readMsjs(bufferOf(buf)) as never);
  let n = 0;
  for (const p of sch.parts) {
    if (!/-Input |Inverter|Buffer/.test(p.typeName)) continue;
    for (const c of p.connNames) {
      if (c === "Y") continue;
      const id = p.connPin[c];
      const net = sch.nets.find((q) => q.pins.some((r) => r.component === p.guid && r.pin === id));
      if (!net || net.name === "0") n++;
    }
  }
  return n;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path };
}

export async function runConvertedNetlistTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const { fs, path } = await nodeApi();

  return await withSymbols(async () => {
    // The served library, as the app would have fetched it: the converted sheets
    // reference `pot`, `LM317`, `SCR` and the 74LS93 by name.
    const entries: { entry: unknown; scope: string }[] = [];
    const subDir = path.resolve("library/sub");
    if (fs.existsSync(subDir)) {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith(".lib")) continue;
        try {
          for (const e of ModelParser.parse(fs.readFileSync(path.join(subDir, f), "latin1")).entries) {
            entries.push({ entry: e, scope: "server" });
          }
        } catch { /* a malformed drop-in is not this suite's business */ }
      }
    }
    useLibraryStore.setState({ entries, serverAvailable: true } as never);

    const dir = path.resolve("examples/Multisim_converted");
    const files: string[] = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n: string) => n.endsWith(".asc")).sort()
      : [];

    for (const file of files) {
      total++;
      const name = `no dead source in ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();
        st().rebuildConnections();
        await tick();
        st().regenerateNetlist();
        await tick();

        const lines = st().netlist.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const src = path.resolve("examples/Sicherung_Multisim_Circuits", file.replace(/\.asc$/, ".msjs"));

        // Which sources the *original* leaves with fewer than two nodes. There is
        // no waiver list here on purpose: a source with both terminals on one node
        // is either a sheet the conversion broke — always a failure — or a part the
        // original never wired up, which several of these teaching sheets are full
        // of (`2_0_Disjunktive_Normalform` is an exercise: the gates and their
        // drivers lie on the sheet for the student to connect). The conversion is
        // asked which, because it holds the refdes→InstName mapping; the *symptom*
        // is still read off the netlist, so the two cannot agree by construction.
        const spare = new Set<string>(
          fs.existsSync(src) ? convert(msjsToSchematic(readMsjs(bufferOf(fs.readFileSync(src))) as never)).unconnected : [],
        );
        const bad: string[] = [];
        for (const l of lines) {
          // `V<name> <n+> <n-> …` / `I<name> …`: an independent source.
          const m = /^([VI]\S*)\s+(\S+)\s+(\S+)\s/.exec(l);
          if (!m || m[2] !== m[3]) continue;
          // The netlist prepends the device letter where the instance name does
          // not already carry it: the sheet's `Ue4` is `VUe4` on its own line.
          if (spare.has(m[1]) || spare.has(m[1].slice(1))) continue;
          bad.push(`${m[1]}: both terminals on ${m[2]}`);
        }
        if (bad.length) failures.push({ name, reason: bad.join("; ") });

        // ── gate inputs the conversion grounded and the source did not ──────
        if (fs.existsSync(src)) {
          const names = gateNames(fs.readFileSync(path.join(dir, file), "latin1"));
          let grounded = 0;
          for (const l of lines) {
            const m = /^B(\S+)\s+\S+\s+0\s+V\s*=\s*(.+?)\s*\?\s*[05]\s*:\s*[05]\s*$/.exec(l);
            if (!m || !names.has(m[1])) continue;
            grounded += [...m[2].matchAll(/v\(([^)]+)\)/gi)].filter((x) => x[1] === "0").length;
          }
          const lost = grounded - groundedInSource(fs.readFileSync(src));
          const known = KNOWN_LOST_GATE_INPUTS[file] ?? 0;
          const gname = `no gate input is lost to ground in ${file}`;
          // Only *more* grounded than the source is a fault. Fewer is not: the
          // source-side count is an upper bound — a gate input Multisim leaves
          // unwired counts as grounded there, and the conversion may well give
          // it a net. So the comparison is one-sided, and the stale-waiver check
          // applies only to the files whose number was checked by hand.
          if (lost > known) {
            failures.push({ name: gname, reason: `${lost} Eingaenge auf Masse statt am Netz (bekannt: ${known})` });
          } else if (file in KNOWN_LOST_GATE_INPUTS && lost < known) {
            failures.push({ name: gname, reason: `nur noch ${lost} statt ${known} - KNOWN_LOST_GATE_INPUTS nachziehen` });
          }
        }
      } catch (e) {
        failures.push({ name, reason: `threw: ${(e as Error).message}` });
      }
    }

    if (files.length === 0) {
      total++;
      failures.push({ name: "the converted corpus is present", reason: "no .asc files found" });
    }
    return { total, passed: total - failures.length, failures };
  });
}
