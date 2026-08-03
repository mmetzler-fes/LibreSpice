import { ModelParser } from "@core/library/ModelParser.js";
import { bundledEntries } from "@core/library/bundledLibrary.js";
import { placementForEntry } from "../libraryPlacement.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * What a library part is called in the parts list, as opposed to what it is
 * called in the netlist.
 *
 * The two are not always the same, and the shipped op-amp is the plain case:
 * LTSpice's UniversalOpAmp2 symbol asks for `SYMATTR SpiceModel level2`, so the
 * subcircuit has to be named `level2` and every saved `.asc` writes that. The
 * parts list showed exactly that — an entry called "level2", with no symbol and
 * a tooltip that said nothing, for what is in fact the same op-amp the Active
 * category offers.
 *
 * The fix is annotation, not renaming: a `.lib` says `* Label:`,
 * `* Description:` and `* Symbol:` in plain SPICE comments. These cases hold
 * both halves — that the annotations are read, and that the SPICE name they
 * decorate is left alone.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

/** The bundled entry by its SPICE name, or undefined. */
const bundled = (name: string) => bundledEntries().find((e) => e.name.toLowerCase() === name);

const CASES: Case[] = [
  {
    name: "a .lib's Label / Description / Symbol comments reach the entry",
    run: (fail) => {
      const { entries } = ModelParser.parse([
        "* Label: Universal-OpAmp",
        "* Description: Ein Satz dazu.",
        "* Symbol: UniversalOpAmp2",
        ".subckt level2 1 2 3 4 5",
        "R1 1 2 1G",
        ".ends level2",
      ].join("\n"));
      const e = entries[0];
      if (!e) { fail("no entry parsed"); return; }
      if (e.name !== "level2") fail(`the SPICE name became ${e.name}`);
      if (e.label !== "Universal-OpAmp") fail(`label: ${e.label}`);
      if (e.description !== "Ein Satz dazu.") fail(`description: ${e.description}`);
      if (e.symbol !== "UniversalOpAmp2") fail(`symbol: ${e.symbol}`);
    },
  },
  {
    // The annotation belongs to the directive under it. A file with several
    // parts must not have the first one's description spill onto the rest.
    name: "an annotation does not leak past its own directive",
    run: (fail) => {
      const { entries } = ModelParser.parse([
        "* Label: Erster",
        ".model D1 D (IS=1e-14)",
        ".model D2 D (IS=2e-14)",
      ].join("\n"));
      const [first, second] = entries;
      if (first?.label !== "Erster") fail(`the first lost its label: ${first?.label}`);
      if (second?.label !== undefined) fail(`the second inherited "${second?.label}"`);
    },
  },
  {
    // Every shipped .lib opens with a paragraph of prose about the model. That
    // is documentation for whoever edits the file, not a part description.
    name: "ordinary comment prose is not mistaken for a description",
    run: (fail) => {
      const { entries } = ModelParser.parse([
        "* Ein ngspice-taugliches Ersatzmodell.",
        "* Es rechnet mit einem Pol.",
        ".subckt foo 1 2",
        "R1 1 2 1k",
        ".ends foo",
      ].join("\n"));
      if (entries[0]?.description !== undefined) fail(`prose became a description: ${entries[0]?.description}`);
      if (entries[0]?.label !== undefined) fail(`prose became a label: ${entries[0]?.label}`);
    },
  },
  {
    // The comments sit above `.subckt`, so they must not end up inside the text
    // that is spliced into the netlist.
    name: "the annotations stay out of the netlist text",
    run: (fail) => {
      const { entries } = ModelParser.parse([
        "* Label: Teil",
        "* Symbol: sym",
        ".subckt foo 1 2",
        "R1 1 2 1k",
        ".ends foo",
      ].join("\n"));
      const raw = entries[0]?.raw ?? "";
      if (/label:|symbol:/i.test(raw)) fail(`an annotation reached the SPICE text:\n${raw}`);
    },
  },

  // ── The shipped op-amps ───────────────────────────────────────────────────
  {
    name: "the bundled level2 is named, described and keeps its SPICE name",
    run: (fail) => {
      const e = bundled("level2");
      if (!e) { fail("library/sub/UniversalOpAmp2.lib carries no level2"); return; }
      // The name is LTSpice's, and every saved sheet writes it — renaming it
      // would orphan the op-amp in every `.asc` we have ever written.
      if (e.name !== "level2") fail(`the subcircuit is called ${e.name}`);
      if (!e.label) fail("no label — the parts list would still read level2");
      if (!e.description) fail("no description");
      if (e.symbol !== "UniversalOpAmp2") fail(`symbol: ${e.symbol}`);
    },
  },
  {
    name: "the bundled 3-pin opamp is named and described too",
    run: (fail) => {
      const e = bundled("opamp");
      if (!e) { fail("library/sub/opamp.lib carries no opamp"); return; }
      if (!e.label) fail("no label");
      if (!e.description) fail("no description");
      if (e.symbol !== "opamp") fail(`symbol: ${e.symbol}`);
    },
  },
  {
    // Without a symbol a subcircuit is placed as the generic numbered box, which
    // for a part we have an `.asy` for is a worse drawing of something we can
    // already draw — and its pins read "1 2 3 4 5" instead of In+/In-/V+/V-/OUT.
    name: "placing level2 uses the op-amp symbol and its pin names",
    run: async (fail) => {
      await withSymbols(async () => {
        const e = bundled("level2");
        if (!e) { fail("no level2 entry"); return; }
        const p = placementForEntry(e);
        if (!p) { fail("level2 is not placeable"); return; }
        if (p.symbolName !== "UniversalOpAmp2") fail(`symbolName: ${p.symbolName}`);
        // SpiceOrder, which is the order the X line writes the nodes in.
        const want = ["In+", "In-", "V+", "V-", "OUT"];
        if (p.pins?.join(",") !== want.join(",")) fail(`pins: ${p.pins?.join(",")}`);
        // The model the netlist asks for is still the subcircuit's own name.
        if (p.name !== "level2") fail(`the placement renamed the part to ${p.name}`);
      });
    },
  },
  {
    // A symbol name that resolves to nothing must fall back to the box rather
    // than leave the part with no graphics at all.
    name: "an unknown Symbol: falls back to the generic box",
    run: async (fail) => {
      await withSymbols(async () => {
        const { entries } = ModelParser.parse([
          "* Symbol: GibtEsNicht",
          ".subckt foo 1 2",
          "R1 1 2 1k",
          ".ends foo",
        ].join("\n"));
        const p = placementForEntry(entries[0]);
        if (p?.symbolName !== undefined) fail(`symbolName: ${p?.symbolName}`);
        if (p?.pins?.join(",") !== "1,2") fail(`pins: ${p?.pins?.join(",")}`);
      });
    },
  },
];

export async function runLibraryLabelTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
