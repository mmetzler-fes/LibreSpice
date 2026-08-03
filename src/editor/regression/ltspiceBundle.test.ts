import { useCircuitStore } from "@store/circuitStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { symbolSource } from "@sym/asyParser.js";
import {
  buildLTSpiceBundle, collectBundle, withIncludeDirective, BUNDLE_LIB, type BundleInput,
} from "@core/ltspice/ltspiceBundle.js";
import { buildZip } from "@core/zip.js";
import { toLatin1 } from "@core/latin1.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The "export for LTSpice" bundle: a sheet plus the parts of ours it names.
 *
 * Two failure modes matter, and they pull in opposite directions. Leave one of
 * our parts out and the sheet arrives broken — LTSpice shows a missing-symbol
 * box or refuses to run. Put one of *LTSpice's* parts in, and our drawing of a
 * resistor (or of `sw`, which is LTSpice's own part under LTSpice's own name)
 * sits in front of the original for that folder. These cases hold both lines.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

/** Files in a stored-entry ZIP, by name — enough to check what we wrote. */
function readZip(zip: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = 0;
  while (at + 4 <= zip.length && dv.getUint32(at, true) === 0x04034b50) {
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const body = zip.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
    // latin1 back to text, matching how the entries were written.
    out.set(name, Array.from(body, (b) => String.fromCharCode(b)).join(""));
    at += 30 + nameLen + extraLen + size;
  }
  return out;
}

/** Load a sheet and build the bundle input the toolbar would build. */
async function bundleInputFor(asc: string): Promise<BundleInput> {
  st().clearCircuit();
  st().loadFromAsc(asc);
  await tick(); await tick();
  st().rebuildConnections();
  const text = LTSpiceExporter.export(
    st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags,
    st().textBoxes, st().sheetShapes,
    { directiveRaw: st().directiveRaw, header: st().ascHeader, anchors: st().netAnchors, busTaps: st().busTaps },
  );
  const instanceLines = [...st().circuit.components.values()]
    .map((c) => c.getNetlistLine())
    .filter(Boolean).join("\n");
  return {
    asc: text,
    instanceLines,
    directives: st().spiceDirectives,
    library: useLibraryStore.getState().getDefinitionBlocks(),
    symbolSource,
  };
}

/** A sheet drawn with one of our parts (the changeover switch) and stock parts. */
const OURS_ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "FLAG -16 48 A",
  "FLAG 64 48 B",
  "FLAG 64 32 C",
  "FLAG 32 16 P",
  "FLAG 16 16 N",
  "SYMBOL spdt2 16 64 R90",
  "SYMATTR InstName U1",
  "SYMBOL res 200 0 R0",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  "TEXT 0 300 Left 2 !.tran 1m",
  "",
].join("\n");

/** A sheet of nothing but parts LTSpice ships itself. */
const STOCK_ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "SYMBOL res 0 0 R0",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  "SYMBOL sw 100 0 R0",
  "SYMATTR InstName S1",
  "SYMATTR Value SW1",
  "SYMBOL Misc\\\\EuropeanResistor 200 0 R0",
  "SYMATTR InstName R2",
  "SYMATTR Value 2k",
  "SYMBOL Digital\\and 300 0 R0",
  "SYMATTR InstName A1",
  "TEXT 0 300 Left 2 !.tran 1m",
  "",
].join("\n");

const CASES: Case[] = [
  {
    name: "our own part travels with its symbol and its model",
    run: async (fail) => {
      await withSymbols(async () => {
        const input = await bundleInputFor(OURS_ASC);
        const c = collectBundle(input);
        if (!c.symbols.some((s) => s.name.toLowerCase() === "spdt2")) {
          fail(`spdt2.asy is missing: ${c.symbols.map((s) => s.name).join(", ")}`);
        }
        // Its symbol names the file, so the model rides there rather than in
        // the sheet's include list (see the double-definition case below).
        if (!c.symbolModels.some((m) => m.file.toLowerCase() === "spdt2.lib")) {
          fail(`the .subckt is missing: ${[...c.symbolModels.map((m) => m.file), ...c.models.map((m) => m.name)].join(", ")}`);
        }
        if (c.missing.length) fail(`unresolved: ${c.missing.join(", ")}`);
      });
    },
  },
  {
    // The line this export must not cross. `sw` is the sharp case: our own
    // drawing, LTSpice's own part name — shipping it would put our picture in
    // front of theirs for that folder.
    name: "nothing LTSpice ships itself is ever bundled",
    run: async (fail) => {
      await withSymbols(async () => {
        const input = await bundleInputFor(STOCK_ASC);
        const c = collectBundle(input);
        if (c.symbols.length) fail(`bundled LTSpice's own: ${c.symbols.map((s) => s.name).join(", ")}`);
        // …and not because it could not find them: they are all in our registry.
        for (const n of ["res", "sw"]) {
          if (!symbolSource(n)) fail(`${n} is not in the registry — the case proves nothing`);
        }
        if (c.missing.length) fail(`reported as missing rather than skipped: ${c.missing.join(", ")}`);
      });
    },
  },
  {
    // LTSpice loads a symbol's `SYMATTR ModelFile` by itself. Putting that same
    // `.subckt` into the sheet's `.include` as well gave it the definition
    // twice, and LTSpice stops with "there is more than one definition of
    // subcircuit SPDT2" — reliably so once the files are also copied into its
    // own library folder, where the symbol finds its model on the second path.
    name: "a model its symbol fetches is not included a second time",
    run: async (fail) => {
      await withSymbols(async () => {
        const input = await bundleInputFor(OURS_ASC);
        const c = collectBundle(input);
        // spdt2.asy says `ModelFile spdt2.lib`, so the model rides under that
        // name and leaves the sheet's include list.
        if (!c.symbolModels.some((m) => m.file.toLowerCase() === "spdt2.lib")) {
          fail(`not handed to its symbol: ${c.symbolModels.map((m) => m.file).join(", ")}`);
        }
        if (c.models.some((m) => m.name.toLowerCase() === "spdt2")) fail("also queued for the include");

        const files = readZip(buildLTSpiceBundle("Testblatt", input));
        if (!files.has("spdt2.lib")) fail(`no spdt2.lib: ${[...files.keys()].join(", ")}`);
        if (files.has(BUNDLE_LIB)) fail("an include file was written for a model nothing needs to include");
        if (files.get("Testblatt.asc")?.includes(".include")) fail("the sheet includes it anyway");

        // The point of all of it: exactly one file defines each subcircuit.
        const defs = new Map<string, string[]>();
        for (const [name, text] of files) {
          if (!/\.(lib|asc)$/i.test(name)) continue;
          for (const m of text.matchAll(/^\s*\.subckt\s+(\S+)/gim)) {
            defs.set(m[1].toLowerCase(), [...(defs.get(m[1].toLowerCase()) ?? []), name]);
          }
        }
        for (const [sub, where] of defs) {
          if (where.length > 1) fail(`${sub} is defined in ${where.join(" and ")}`);
        }
      });
    },
  },
  {
    name: "the sheet gets one .include, and only when models travel with it",
    run: (fail) => {
      const asc = "Version 4\nSHEET 1 880 680\nSYMBOL res 0 100 R0\nSYMATTR InstName R1\n";
      const none = withIncludeDirective(asc, false);
      if (/\.include/i.test(none)) fail("an include was added for an empty model list");

      const once = withIncludeDirective(asc, true);
      if (!new RegExp(`TEXT .*!\\.include ${BUNDLE_LIB}`).test(once)) fail(`no include: ${once}`);
      const twice = withIncludeDirective(once, true);
      if ((twice.match(/\.include/gi) ?? []).length !== 1) fail(`the include was added twice:\n${twice}`);
      // Below the drawing, so it does not land on top of a part.
      const y = Number(/TEXT 0 (\d+) Left/.exec(once)?.[1]);
      if (!(y > 100)) fail(`the directive sits at y=${y}, inside the schematic`);
    },
  },
  {
    name: "the archive holds the sheet, the symbols, the models and a note",
    run: async (fail) => {
      await withSymbols(async () => {
        const input = await bundleInputFor(OURS_ASC);
        const files = readZip(buildLTSpiceBundle("Testblatt", input));
        for (const want of ["Testblatt.asc", "spdt2.asy", "spdt2.lib", "LIESMICH.txt"]) {
          if (!files.has(want)) fail(`${want} is not in the archive: ${[...files.keys()].join(", ")}`);
        }
        if (!files.get("spdt2.asy")?.includes("PINATTR PinName COM")) fail("the .asy is not its source text");
        if (!/\.subckt\s+SPDT2/i.test(files.get("spdt2.lib") ?? "")) fail("the model file has no subcircuit");
      });
    },
  },
  {
    // LTSpice reads latin1. A `µF` written as UTF-8 arrives there as `ÂµF`, and
    // a value nobody can read is worse than a missing one.
    name: "text goes into the archive as latin1, as LTSpice reads it",
    run: (fail) => {
      const zip = buildZip([{ path: "a.asc", data: "10µF", latin1: true }]);
      const body = readZip(zip).get("a.asc") ?? "";
      if (body.length !== 4) fail(`"10µF" became ${body.length} bytes — that is UTF-8`);
      if (body.charCodeAt(2) !== 0xb5) fail(`µ is byte 0x${body.charCodeAt(2).toString(16)}, not 0xb5`);
    },
  },
  {
    // LTSpice opens `<sheet>.plt` by itself, so a bundle that carries one comes
    // up with the same panes and colours. Before the first simulation there are
    // no axis ranges to write down, and then it must simply be absent rather
    // than empty — an empty `.plt` makes LTSpice open a blank plot window.
    name: "the plot settings travel only once there are any",
    run: async (fail) => {
      await withSymbols(async () => {
        const input = await bundleInputFor(OURS_ASC);
        const without = readZip(buildLTSpiceBundle("Testblatt", { ...input, plt: null }));
        if ([...without.keys()].some((k) => k.endsWith(".plt"))) fail("a .plt was written with nothing plotted");

        const withPlt = readZip(buildLTSpiceBundle("Testblatt", { ...input, plt: "[Transient Analysis]\n{\n}\n" }));
        if (!withPlt.has("Testblatt.plt")) fail(`no .plt: ${[...withPlt.keys()].join(", ")}`);
        // The name is the sheet's, which is the only way LTSpice finds it.
        if (!withPlt.get("Testblatt.plt")?.includes("Transient")) fail("the .plt is not its own text");
        if (!withPlt.get("LIESMICH.txt")?.includes("Testblatt.plt")) fail("the note does not mention it");
      });
    },
  },
  {
    // The bug this shares with the plain Save: a JavaScript string handed to a
    // Blob or a file handle goes out as UTF-8 without asking. LTSpice reads
    // latin1, so `10µF` arrived there as `10ÂµF`, and LTSpice took the number
    // and dropped the rest — a 10 µF capacitor became a 10 F one, and a 31 mA
    // branch current came out as 10 A.
    name: "a saved sheet is latin1, so µ survives the trip to LTSpice",
    run: (fail) => {
      const text = "C1 10µF, R 1Ω, Größe";
      const bytes = toLatin1(text);
      if (bytes.length !== text.length) fail(`${bytes.length} bytes for ${text.length} characters — that is UTF-8`);
      const at = (ch: string) => bytes[text.indexOf(ch)];
      if (at("µ") !== 0xb5) fail(`µ is 0x${at("µ").toString(16)}, not 0xb5`);
      if (at("ö") !== 0xf6) fail(`ö is 0x${at("ö").toString(16)}, not 0xf6`);
      // Ω is U+03A9 — latin1 has no room for it, and neither has LTSpice.
      if (at("Ω") !== 0x3f) fail(`Ω should degrade to "?", got 0x${at("Ω").toString(16)}`);
    },
  },
  {
    // The whole loop, byte for byte: a value with a µ in it, saved and read
    // back the way LTSpice would. Encoding was only half the fault — the other
    // half is that a corrupt value is *sticky*. `10ÂµF` parses to 10, the model
    // holds 10, and `sameAttrValue` then reports the file's spelling as still
    // current and writes it back unchanged. Nothing short of retyping the value
    // repairs a sheet that has been through a UTF-8 save.
    name: "a µF value survives save and reload as bytes on disk",
    run: async (fail) => {
      await withSymbols(async () => {
        st().clearCircuit();
        st().loadFromAsc([
          "Version 4",
          "SHEET 1 880 680",
          "SYMBOL cap 0 0 R0",
          "SYMATTR InstName C1",
          "SYMATTR Value 10µF",
          "TEXT 0 300 Left 2 !.tran 1m",
          "",
        ].join("\n"));
        await tick(); await tick();
        const before = (st().circuit.components.get(st().nodes[0].id) as any)?.capacitance;
        if (before !== 1e-5) { fail(`the sheet did not even load: ${before}`); return; }

        const asc = LTSpiceExporter.export(
          st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags,
          st().textBoxes, st().sheetShapes,
          { directiveRaw: st().directiveRaw, header: st().ascHeader, anchors: st().netAnchors, busTaps: st().busTaps },
        );
        // What actually reaches the disk, and what LTSpice — and our own open —
        // make of those bytes.
        const bytes = toLatin1(asc);
        if (bytes.includes(0x3f) && !asc.includes("?")) fail("something was replaced by a question mark on the way out");
        const reread = new TextDecoder("windows-1252").decode(bytes);
        if (!/Value 10µF/.test(reread)) {
          fail(`the value came back as ${/SYMATTR Value (\S+)/.exec(reread)?.[1]}`);
        }

        st().clearCircuit();
        st().loadFromAsc(reread);
        await tick(); await tick();
        const after = (st().circuit.components.get(st().nodes[0].id) as any)?.capacitance;
        if (after !== before) fail(`10 µF became ${after} F after one save and open`);
      });
    },
  },
  {
    // The promise the export makes: a bundle is complete or says what is
    // missing. Checked across the whole shipped corpus, because the failure it
    // guards against is exactly the one we hit with `spdt2` — a symbol nobody
    // had noticed was unresolvable.
    name: "every shipped sheet resolves all of its symbols",
    run: async (fail) => {
      await withSymbols(async () => {
        const load = (m: string) => import(/* @vite-ignore */ m);
        const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
        const dirs = ["examples", "examples/Rahm", "examples/Multisim_converted", "examples/Multisim14_converted"];
        let checked = 0;
        for (const d of dirs) {
          if (!fs.existsSync(d)) continue;
          for (const f of fs.readdirSync(d)) {
            if (!f.endsWith(".asc")) continue;
            const asc = fs.readFileSync(path.join(d, f), "latin1");
            // Symbols only: the models need a loaded circuit, and the symbol is
            // the half this sweep can answer for every sheet cheaply.
            const c = collectBundle({ asc, instanceLines: "", directives: "", library: [], symbolSource });
            checked++;
            if (c.missing.length) fail(`${d}/${f}: ${c.missing.join(", ")}`);
          }
        }
        if (checked === 0) fail("no sheets were checked at all");
      });
    },
  },
];

export async function runLTSpiceBundleTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
