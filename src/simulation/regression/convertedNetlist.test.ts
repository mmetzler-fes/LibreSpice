import { useCircuitStore } from "@store/circuitStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import { readMsjs, msjsToSchematic } from "@core/multisim/msjs.js";
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
 *     Emitted at a fixed orientation it landed on the wire leaving the output
 *     pin wherever that wire ran downwards, which grounds the output: ngspice
 *     stops at "instance vdg6 is a shorted VSRC" and the sheet yields nothing.
 *     Three schematics were in that state (`2_0_Disjunktive_Normalform_Lsg` and
 *     both `6_3_3_Universal_Schieberegister`).
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
 * Sheets that still convert with a shorted source, with the source named.
 *
 * Recorded rather than waived: each entry is a schematic ngspice will not start
 * on, and the list is the work still to do. It is spelled out per source so the
 * guard still fires if a *different* one goes dead in the same file.
 *
 * The digital constant and clock are fixed (their invented ground terminal now
 * turns away from the wiring it used to land on). These are the ones that are
 * not that: ordinary sources whose two terminals meet through the drawn wiring
 * — a different geometry fault, not yet run down.
 */
const KNOWN_DEAD_SOURCES: Record<string, string[]> = {
  "1_1_1_Nichtinvertierender_Komparator.asc": ["V2"],
  "1_1_2_Invertierender Komparator (1).asc": ["VUe4"],
  "1_1_2_Invertierender Komparator.asc": ["VUe4"],
  "6_1_1_Einfaches_RS_Flipflop.asc": ["VSet1", "VReset1"],
  "6_3_3_Universal_Schieberegister_Lsg.asc": ["VDG13", "VDG14"],
  "7_1_1_Intergrierender_OPV.asc": ["V4"],
};

/**
 * Gate inputs a sheet grounds that its Multisim source did not, per file.
 *
 * Down to one from four, and meant to stay there. It shrank when `emitGate` was fitted
 * over all its pins instead of anchored on its output alone: a gate Multisim had
 * mirrored used to come out facing the wrong way, with its inputs 200 units from
 * their wires and reading as ground. Anything appearing here again is that class
 * of fault returning.
 */
const KNOWN_LOST_GATE_INPUTS: Record<string, number> = {
  // One 2-input AND whose inputs Multisim spaces 32 apart; our gate spaces two
  // inputs 48 apart, so the second lands 16 off its wire. Not an orientation
  // fault — our own pin pitch. Changing it means changing the gate everywhere
  // (LogicGate.createPorts, pinGeometry and ltspiceGeometry have to agree, and
  // every hand-drawn schematic moves with them), which is a poor trade for one
  // input in one sheet.
  "2_1_Tiefgaragensteuerung_Lsg.asc": 1,
};

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

/** How many gate inputs the Multisim source itself leaves on ground. */
function groundedInSource(buf: { buffer: ArrayBuffer; byteOffset: number; byteLength: number }): number {
  const sch = msjsToSchematic(readMsjs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as never);
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
        const known = KNOWN_DEAD_SOURCES[file] ?? [];
        const bad: string[] = [];
        const stillDead: string[] = [];
        for (const l of lines) {
          // `V<name> <n+> <n-> …` / `I<name> …`: an independent source.
          const m = /^([VI]\S*)\s+(\S+)\s+(\S+)\s/.exec(l);
          if (!m || m[2] !== m[3]) continue;
          if (known.includes(m[1])) stillDead.push(m[1]);
          else bad.push(`${m[1]}: both terminals on ${m[2]}`);
        }
        // A known one that came back to life means the list is stale — say so,
        // rather than let a fixed schematic keep a waiver it no longer needs.
        const revived = known.filter((k) => !stillDead.includes(k));
        if (revived.length) bad.push(`no longer dead, drop from KNOWN_DEAD_SOURCES: ${revived.join(", ")}`);
        if (bad.length) failures.push({ name, reason: bad.join("; ") });

        // ── gate inputs the conversion grounded and the source did not ──────
        const src = path.resolve("examples/Sicherung_Multisim_Circuits", file.replace(/\.asc$/, ".msjs"));
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
