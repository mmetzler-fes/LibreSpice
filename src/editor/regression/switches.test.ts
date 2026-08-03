import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { bundledEntries } from "@core/library/bundledLibrary.js";
import { moveInductorIc, normalizeTranDirective } from "@core/circuit/NetlistGenerator.js";
import { symbolByName } from "@sym/asyParser.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Switches on a sheet: the SPICE `S` device (LTSpice's `sw` symbol) and the
 * `spdt2` subcircuit.
 *
 * Both were drawn as *resistors*. An unknown symbol with no pin list falls back
 * to the two-pin default (see LTSpiceParser), and that fallback is silent in the
 * worst way: the part appears, the sheet loads, and only the behaviour is wrong.
 * For `sw` it cost the two control pins — their wires met nothing — and
 * `SYMATTR Value SW1`, the name of the `.model`, was read as a resistance of
 * zero, i.e. a dead short exactly where the switching belongs.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

/** A minimal buck-converter fragment: the switch, its control and its model. */
const SW_ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "WIRE -16 16 -128 16",
  "WIRE 64 16 160 16",
  "WIRE 48 96 48 64",
  "WIRE 0 208 0 64",
  "FLAG -128 16 IN",
  "FLAG 160 16 OUT",
  "FLAG 0 208 0",
  "FLAG 48 64 CTRL",
  "SYMBOL sw -32 16 R270",
  "SYMATTR InstName S1",
  "SYMATTR Value SW1",
  "TEXT -48 296 Left 2 !.model SW1 SW(Ron=0.01 Roff=1Meg Vt=0.5 Vh=0)",
  "",
].join("\n");

/** Load a sheet and let the asynchronous re-link settle. */
async function load(asc: string) {
  st().clearCircuit();
  st().loadFromAsc(asc);
  await tick(); await tick();
  st().rebuildConnections();
  st().regenerateNetlist();
}

const CASES: Case[] = [
  {
    name: "an LTSpice `sw` comes back as a switch, not as a resistor",
    run: async (fail) => {
      await withSymbols(async () => {
        await load(SW_ASC);
        const node = st().nodes.find((n) => n.data.label === "S1");
        if (!node) { fail("S1 is not on the sheet"); return; }
        if (node.data.componentType !== "vswitch") {
          fail(`S1 came back as ${node.data.componentType}`);
        }
        const comp = st().circuit.components.get(node.id);
        if (comp?.ports.length !== 4) fail(`${comp?.ports.length} pins, not 4 — the control pair is missing`);
        // The model name is the part's behaviour, not a value: read as a number
        // it became 0 ohm, which is a short across the switch.
        if ((comp as any)?.model !== "SW1") fail(`model: ${(comp as any)?.model}`);
        if ((comp as any)?.resistance !== undefined) fail("the switch grew a resistance");
      });
    },
  },
  {
    name: "the netlist line is an S device with the control pair in SpiceOrder",
    run: async (fail) => {
      await withSymbols(async () => {
        await load(SW_ASC);
        const line = st().netlist.split("\n").find((l) => /^S/i.test(l.trim()));
        if (!line) { fail(`no S line in:\n${st().netlist}`); return; }
        // S<name> n+ n- nc+ nc- <model> — the two contacts, then the control,
        // NC+ first. Reversing the control pair leaves a switch that simulates
        // and never closes.
        const m = /^S1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(line.trim());
        if (!m) { fail(`not an S line: ${line}`); return; }
        const [, a, b, ncp, ncn, model] = m;
        if (model !== "SW1") fail(`model: ${model}`);
        if (!(a === "IN" && b === "OUT")) fail(`contacts on ${a}/${b}, expected IN/OUT`);
        if (!(ncp === "CTRL" && ncn === "0")) fail(`control on ${ncp}/${ncn}, expected CTRL/0`);
      });
    },
  },
  {
    name: "the sheet's own .model wins over our fallback",
    run: async (fail) => {
      await withSymbols(async () => {
        await load(SW_ASC);
        const models = st().netlist.split("\n").filter((l) => /^\.model\s+SW1\b/i.test(l.trim()));
        if (models.length !== 1) fail(`${models.length} .model SW1 lines — a duplicate redefines the switch`);
        if (!models[0]?.includes("Vt=0.5")) fail(`the sheet's model was replaced: ${models[0]}`);
      });
    },
  },
  {
    name: "a switch with no model of its own still simulates",
    run: async (fail) => {
      await withSymbols(async () => {
        // Same sheet without the `.model` directive: a fresh switch off the
        // palette is in exactly this state, and without a fallback ngspice
        // aborts the whole run with "could not find a valid modelname".
        await load(SW_ASC.replace(/^TEXT .*!\.model.*$/m, ""));
        const models = st().netlist.split("\n").filter((l) => /^\.model\s+SW1\b/i.test(l.trim()));
        if (models.length !== 1) fail(`${models.length} fallback models emitted`);
        if (!/\bSW\s*\(/i.test(models[0] ?? "")) fail(`not a switch model: ${models[0]}`);
      });
    },
  },
  {
    name: "the switch is written back as `SYMBOL sw` with its model name",
    run: async (fail) => {
      await withSymbols(async () => {
        await load(SW_ASC);
        const asc = LTSpiceExporter.export(
          st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags,
          st().textBoxes, st().sheetShapes,
          { directiveRaw: st().directiveRaw, header: st().ascHeader, anchors: st().netAnchors, busTaps: st().busTaps },
        );
        if (!asc.includes("SYMBOL sw -32 16 R270")) fail(`the symbol moved or was renamed:\n${asc}`);
        if (!asc.includes("SYMATTR Value SW1")) fail("the model name was lost on save");
      });
    },
  },

  {
    // The buck-converter sheet asks for `.tran 0 100ms 99.97ms startup uic`.
    // `startup` is LTSpice's supply ramp and means nothing to ngspice, which
    // answers "unknown parameter on .tran - ignored" — and that message is what
    // our own simulation runner reports as a broken sheet.
    name: "LTSpice's .tran modifiers are dropped for ngspice",
    run: (fail) => {
      const got = normalizeTranDirective(".tran 0 100ms 99.97ms startup uic");
      if (/startup/i.test(got)) fail(`startup survived: ${got}`);
      if (!/\buic\b/.test(got)) fail(`uic was dropped too: ${got}`);
      // The times are untouched — only the modifier goes.
      if (!/100ms\s+99\.97ms/.test(got)) fail(`the sweep changed: ${got}`);
      // A valid step is left alone, modifier or not.
      const plain = normalizeTranDirective(".tran 1u 5m steady");
      if (plain.trim() !== ".tran 1u 5m") fail(`unexpected: ${plain}`);
      if (normalizeTranDirective(".tran 10m").trim() !== ".tran 10u 10m") {
        fail(`the LTSpice shorthand broke: ${normalizeTranDirective(".tran 10m")}`);
      }
    },
  },

  {
    // The other directive from the same sheet: `.ic I(L1)=0`. ngspice's `.ic`
    // takes node voltages only and answers ".ic syntax error", followed by
    // "circuit not parsed" — one line, and the whole schematic is gone.
    name: "an initial inductor current moves from .ic onto the inductor",
    run: (fail) => {
      const lines = ["L1 a b 785u", "C1 b 0 3.3m", ".ic I(L1)=0"];
      moveInductorIc(lines);
      if (lines.some((l) => /^\s*\.ic\b/i.test(l))) fail(`the .ic line survived: ${lines.join(" | ")}`);
      if (!/^L1 a b 785u ic=0$/.test(lines[0])) fail(`the inductor line reads "${lines[0]}"`);

      // A node voltage on the same line is ngspice's own syntax and stays.
      const mixed = ["L1 a b 1m", ".ic V(out)=5 I(L1)=2"];
      moveInductorIc(mixed);
      const ic = mixed.find((l) => /^\s*\.ic\b/i.test(l));
      if (!ic || !/V\(out\)=5/i.test(ic)) { fail(`the node voltage was lost: ${mixed.join(" | ")}`); return; }
      if (/I\(/i.test(ic)) fail(`the current term stayed: ${ic}`);
      if (!/ic=2$/.test(mixed[0])) fail(`the value did not reach the inductor: ${mixed[0]}`);

      // A current through something that is not an inductor is left alone —
      // ngspice will complain, and that is better than dropping it silently.
      const foreign = ["R1 a b 10", ".ic I(R1)=1"];
      moveInductorIc(foreign);
      if (!foreign.some((l) => /\.ic I\(R1\)=1/i.test(l))) fail(`a non-inductor term was swallowed: ${foreign.join(" | ")}`);
    },
  },

  // ── The `spdt2` subcircuit ────────────────────────────────────────────────
  {
    // A `.subckt` states its nodes in order; the symbol states the same nodes by
    // SpiceOrder. Disagree, and the wires land on the wrong terminals — silently,
    // because both sides are individually valid. `spdt2` had NC and NO the wrong
    // way round, so the contact drawn as the resting one switched the other way.
    name: "a bundled symbol's pin order matches its subcircuit's",
    run: async (fail) => {
      await withSymbols(async () => {
        for (const entry of bundledEntries()) {
          if (entry.kind !== "subckt" || !entry.symbol) continue;
          const sym = symbolByName(entry.symbol);
          if (!sym) { fail(`${entry.name}: no symbol "${entry.symbol}"`); continue; }
          if (sym.pins.length !== entry.pins.length) {
            fail(`${entry.name}: ${sym.pins.length} symbol pins for ${entry.pins.length} subckt nodes`);
            continue;
          }
          // Where a symbol names its pin as the subcircuit names the node, the
          // two must be in the same position. (A symbol may label a pin "+"
          // where the subcircuit says "POS"; only shared names are checked.)
          const symNames = [...sym.pins].sort((a, b) => a.order - b.order).map((p) => p.name.toUpperCase());
          const subNames = entry.pins.map((p) => p.toUpperCase());
          for (let i = 0; i < symNames.length; i++) {
            const elsewhere = subNames.indexOf(symNames[i]);
            if (elsewhere >= 0 && elsewhere !== i) {
              fail(`${entry.name}: pin ${i + 1} is "${symNames[i]}" on the symbol but node ${elsewhere + 1} in the subcircuit`);
            }
          }
        }
      });
    },
  },
  {
    // LTSpice puts the symbol's `Prefix X` in front of the InstName when it
    // netlists. We wrote the bare label, which was fine only because every
    // subcircuit came from the Multisim converter with an `X` already in its
    // name — a hand-drawn sheet calls its switch `U1`, and `U` is ngspice's URC
    // line, so the whole circuit failed to parse.
    name: "a subcircuit instance is netlisted as X, whatever it is called",
    run: async (fail) => {
      await withSymbols(async () => {
        await load([
          "Version 4",
          "SHEET 1 880 680",
          "FLAG -16 48 A",
          "FLAG 64 48 B",
          "FLAG 64 32 C",
          "FLAG 32 16 P",
          "FLAG 16 16 N",
          "SYMBOL spdt2 16 64 R90",
          "SYMATTR InstName U1",
          "TEXT 0 300 Left 2 !.tran 1m",
          "",
        ].join("\n"));
        const line = st().netlist.split("\n").find((l) => /spdt2/i.test(l) && !/^\.subckt/i.test(l.trim()));
        if (!line) { fail(`no instance line in:\n${st().netlist}`); return; }
        if (!/^XU1\b/.test(line.trim())) fail(`instance line is "${line.trim()}", not XU1`);
        // COM, NO, NC, POS, NEG — in the subcircuit's order.
        if (!/^XU1\s+A\s+B\s+C\s+P\s+N\s+/i.test(line.trim())) fail(`nodes out of order: ${line.trim()}`);
      });
    },
  },
];

export async function runSwitchTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
