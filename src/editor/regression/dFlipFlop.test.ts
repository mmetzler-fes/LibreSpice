import { DFlipFlop } from "@core/components/digital/DFlipFlop.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The D flip-flop is two behavioural latches in series, because a `B` source on
 * its own is combinational and the bundled ngspice has no XSPICE digital models.
 * State sits on a capacitor that its `B` source drives while the latch is
 * transparent and leaves open while it holds.
 *
 * The T flip-flop is the same pair with the master fed by its own output gated
 * by T; the D latch is a single cell, so it is transparent while enabled.
 *
 * The forms pinned here were checked against the real engine: a rising-edge part
 * ignores D between edges, a falling-edge one latches half a period later, a
 * toggle connection divides by two, async Set/Reset override the clock, a T
 * flip-flop with T=1 divides by two and holds at T=0, and a latch follows D
 * without waiting for an edge. What these cases guard is that the emitted text
 * keeps the structure those runs depended on.
 */
type Case = { name: string; run: (fail: (r: string) => void) => void };

/** A flip-flop with the named pins wired to nets of the same name. */
function ff(wired: string[], cfg: Partial<DFlipFlop> = {}, label = "U1"): DFlipFlop {
  // Kind goes through the constructor: it renames the data and clock pins, and
  // the caller wires those by name.
  const f = new DFlipFlop("f1", label, undefined, cfg.kind ?? "dff");
  Object.assign(f, cfg);
  for (const pin of wired) {
    const p = f.getPort(pin);
    if (!p) throw new Error(`no such pin: ${pin}`);
    p.netId = pin.replace(/[^A-Za-z0-9]/g, "").toLowerCase() as typeof p.netId;
  }
  return f;
}

const ALL = ["D", "CLK", "SET", "RESET", "Q", "~Q"];

const CASES: Case[] = [
  {
    name: "has the six flip-flop pins",
    run: (fail) => {
      const names = new DFlipFlop("f1", "U1").ports.map((p) => p.name);
      if (names.join(",") !== "D,CLK,SET,RESET,Q,~Q") fail(names.join(","));
    },
  },
  {
    name: "master and slave are gated on opposite clock levels",
    run: (fail) => {
      // This opposition *is* the edge trigger: if both latches were transparent
      // at once, D would run straight through to Q and a toggle connection
      // would oscillate instead of dividing.
      const l = ff(ALL).getNetlistLine();
      const master = l.split("\n").find((x) => /^BU1M /.test(x)) ?? "";
      const slave = l.split("\n").find((x) => /^BU1S /.test(x)) ?? "";
      if (!master.includes("(v(clk)<2.5)")) fail(`master: ${master}`);
      if (!slave.includes("(v(clk)>2.5)")) fail(`slave: ${slave}`);
    },
  },
  {
    name: "the falling-edge part swaps those two comparisons",
    run: (fail) => {
      const l = ff(ALL, { edge: "falling" }).getNetlistLine();
      const master = l.split("\n").find((x) => /^BU1M /.test(x)) ?? "";
      const slave = l.split("\n").find((x) => /^BU1S /.test(x)) ?? "";
      if (!master.includes("(v(clk)>2.5)")) fail(`master: ${master}`);
      if (!slave.includes("(v(clk)<2.5)")) fail(`slave: ${slave}`);
    },
  },
  {
    name: "the slave samples the master, not D",
    run: (fail) => {
      // A slave reading D directly would be transparent, not edge-triggered.
      const slave = ff(ALL).getNetlistLine().split("\n").find((x) => /^BU1S /.test(x)) ?? "";
      if (!slave.includes("v(n_U1_m)")) fail(`slave does not read the master: ${slave}`);
      if (/v\(d\)/.test(slave)) fail(`slave reads D directly: ${slave}`);
    },
  },
  {
    name: "an unconnected Set/Reset is left out of the expression",
    run: (fail) => {
      // Read as 0 V an open pin would be harmless when active high but would
      // assert permanently when active low, pinning the output.
      const l = ff(["D", "CLK", "Q"], { asyncPolarity: "low" }).getNetlistLine();
      if (/v\(set\)|v\(rst\)|v\(reset\)/i.test(l)) fail(`open async pin referenced: ${l}`);
    },
  },
  {
    name: "active-low Set/Reset compare below the threshold",
    run: (fail) => {
      const l = ff(ALL, { asyncPolarity: "low" }).getNetlistLine();
      if (!l.includes("(v(set)<2.5)")) fail(`set: ${l}`);
      if (!l.includes("(v(reset)<2.5)")) fail(`reset: ${l}`);
    },
  },
  {
    name: "Set outranks Reset",
    run: (fail) => {
      // Both asserted must give Q = 1, so the SET test has to sit outside the
      // RESET one in the nested ternary.
      const master = ff(ALL).getNetlistLine().split("\n").find((x) => /^BU1M /.test(x)) ?? "";
      const s = master.indexOf("(v(set)>2.5) ?");
      const r = master.indexOf("(v(reset)>2.5) ?");
      if (s < 0 || r < 0) fail(master);
      else if (s > r) fail("Reset is tested before Set");
    },
  },
  {
    name: "storage nodes are namespaced per instance",
    run: (fail) => {
      // Two flip-flops sharing a storage node would be one flip-flop; that is
      // what a shift register would collapse into.
      const a = ff(ALL, {}, "U1").getNetlistLine();
      const b = ff(ALL, {}, "U2").getNetlistLine();
      if (!a.includes("n_U1_m") || !b.includes("n_U2_m")) fail("storage node not per instance");
      if (b.includes("n_U1_")) fail("U2 refers to U1's storage");
    },
  },
  {
    name: "each storage node gets a capacitor and a DC path to ground",
    run: (fail) => {
      // Without the leak resistor the holding latch is a floating node and
      // ngspice refuses the circuit before it ever runs the transient.
      const lines = ff(ALL).getNetlistLine().split("\n");
      for (const suffix of ["M", "S"]) {
        if (!lines.some((x) => x.startsWith(`CU1${suffix} `))) fail(`no storage cap for ${suffix}`);
        if (!lines.some((x) => x.startsWith(`RU1${suffix} `))) fail(`no leak resistor for ${suffix}`);
      }
    },
  },
  {
    name: "~Q is the complement of Q",
    run: (fail) => {
      const lines = ff(ALL).getNetlistLine().split("\n");
      const q = lines.find((x) => /^BU1Q /.test(x)) ?? "";
      const qn = lines.find((x) => /^BU1N /.test(x)) ?? "";
      if (!q.endsWith("? 5 : 0")) fail(`Q: ${q}`);
      if (!qn.endsWith("? 0 : 5")) fail(`~Q: ${qn}`);
    },
  },
  {
    name: "an unconnected output emits no source",
    run: (fail) => {
      const l = ff(["D", "CLK", "Q"]).getNetlistLine();
      if (/^BU1N /m.test(l)) fail("drove a dangling ~Q");
      if (!/^BU1Q /m.test(l)) fail("did not drive the connected Q");
    },
  },
  {
    name: "the references keep a B prefix for ngspice",
    run: (fail) => {
      // ngspice derives the device type from the first letter, so a flip-flop
      // the user named "FF1" must still emit B/C/R lines.
      const lines = ff(ALL, {}, "FF1").getNetlistLine().split("\n");
      for (const l of lines) {
        if (!/^[BCR]FF1/.test(l)) fail(`bad device letter: ${l}`);
      }
    },
  },
  {
    name: "levels follow the configured threshold and output high",
    run: (fail) => {
      const l = ff(ALL, { threshold: 1.4, vHigh: 3.3 }).getNetlistLine();
      if (!l.includes("v(clk)<1.4")) fail("threshold ignored");
      if (!l.includes("3.3")) fail("output level ignored");
    },
  },
  {
    name: "clone and serialize carry the configuration",
    run: (fail) => {
      const f = ff(ALL, { edge: "falling", asyncPolarity: "low", threshold: 1.4, vHigh: 3.3 });
      const c = f.clone();
      if (c.edge !== "falling" || c.asyncPolarity !== "low" || c.threshold !== 1.4 || c.vHigh !== 3.3) {
        fail("clone lost properties");
      }
      const s = f.serialize();
      if (s.edge !== "falling" || s.asyncPolarity !== "low") fail(`serialize: ${JSON.stringify(s)}`);
      const back = new DFlipFlop("f2", "U9");
      back.deserialize(s);
      if (back.edge !== "falling" || back.asyncPolarity !== "low") fail("deserialize lost properties");
    },
  },
  {
    name: "a T flip-flop samples its own output, gated by T",
    run: (fail) => {
      // Verified against the engine: T=1 divides the clock by two, T=0 holds.
      // The master must compare T against the *slave* — reading the master's own
      // node would be a combinational loop with no clock in it.
      const f = ff(["T", "CLK", "Q"], { kind: "tff" });
      const master = f.getNetlistLine().split("\n").find((x) => /^BU1M /.test(x)) ?? "";
      if (!master.includes("!=")) fail(`no toggle term: ${master}`);
      if (!master.includes("v(n_U1_s)")) fail(`does not read the slave: ${master}`);
      if (!master.includes("v(t)")) fail(`does not read T: ${master}`);
    },
  },
  {
    name: "a JK's master samples J and K against its own output",
    run: (fail) => {
      // Verified against the engine over eight clocks, with J and K tied to
      // fixed levels: 00 holds, 10 sets, 01 clears (checked from a Q raised by
      // SET, since clearing a zero proves nothing), 11 divides the clock by two.
      // The term is J·~Q + ~K·Q, read off the *slave* for the same reason the T
      // flip-flop does — the master's own node would be a loop with no clock.
      const f = ff(["J", "K", "CLK", "Q"], { kind: "jkff" });
      const master = f.getNetlistLine().split("\n").find((x) => /^BU1M /.test(x)) ?? "";
      if (!master.includes("v(j)")) fail(`does not read J: ${master}`);
      if (!master.includes("v(k)")) fail(`does not read K: ${master}`);
      if (!master.includes("v(n_U1_s)")) fail(`does not read the slave: ${master}`);
      // Both halves of the term, so a JK cannot decay into "J sets, K ignored".
      if (!/\(v\(j\)>2\.5\) && !\(v\(n_U1_s\)>2\.5\)/.test(master)) fail(`no J·~Q term: ${master}`);
      if (!/!\(v\(k\)>2\.5\) && \(v\(n_U1_s\)>2\.5\)/.test(master)) fail(`no ~K·Q term: ${master}`);
    },
  },
  {
    name: "a JK has seven pins and the others still have six",
    run: (fail) => {
      // The seventh pin is a compatibility surface: four tables have to agree on
      // it (the ports, pinGeometry, ltspiceGeometry and the Multisim converter),
      // and a file written before the JK existed must keep its six.
      const jk = new DFlipFlop("f1", "U1", undefined, "jkff");
      const names = jk.ports.map((p) => p.name).join(",");
      if (names !== "J,K,CLK,SET,RESET,Q,~Q") fail(`jk pins: ${names}`);
      const ids = jk.ports.map((p) => p.id).join(",");
      if (ids !== "f1-d,f1-k,f1-clk,f1-set,f1-rst,f1-q,f1-qn") fail(`jk ids: ${ids}`);
      // J and K keep the heights the other kinds' data and clock pins have, so a
      // JK's terminals still land on the same grid rows.
      const at = (n: string) => { const p = jk.getPort(n)!.relativePosition; return `${p.x},${p.y}`; };
      if (at("J") !== "-32,-24") fail(`J moved: ${at("J")}`);
      if (at("K") !== "-32,24") fail(`K moved: ${at("K")}`);
      if (at("CLK") !== "-32,0") fail(`CLK not between them: ${at("CLK")}`);
      if (new DFlipFlop("f1", "U1").ports.length !== 6) fail("a plain D flip-flop grew a pin");
    },
  },
  {
    name: "a D latch is a single transparent cell",
    run: (fail) => {
      // The whole difference from a flip-flop: one storage node, driven straight
      // from D while EN is asserted, so D reaches Q without an edge.
      const l = ff(["D", "EN", "Q"], { kind: "dlatch" }).getNetlistLine();
      if (/^BU1M /m.test(l)) fail("latch emitted a master cell");
      const slave = l.split("\n").find((x) => /^BU1S /.test(x)) ?? "";
      if (!slave.includes("v(d)")) fail(`latch does not read D directly: ${slave}`);
      if (!slave.includes("(v(en)>2.5)")) fail(`not gated on EN: ${slave}`);
    },
  },
  {
    name: "the kind renames the data and clock pins but not their ids",
    run: (fail) => {
      // The .asc geometry table and the editor's handles are keyed on the port
      // ids, so those must not move when the kind does.
      const names = (k: string) =>
        new DFlipFlop("f1", "U1", undefined, k as never).ports.map((p) => p.name).join(",");
      if (names("dff") !== "D,CLK,SET,RESET,Q,~Q") fail(`dff: ${names("dff")}`);
      if (names("tff") !== "T,CLK,SET,RESET,Q,~Q") fail(`tff: ${names("tff")}`);
      if (names("dlatch") !== "D,EN,SET,RESET,Q,~Q") fail(`dlatch: ${names("dlatch")}`);
      const ids = new DFlipFlop("f1", "U1", undefined, "dlatch").ports.map((p) => p.id).join(",");
      if (ids !== "f1-d,f1-clk,f1-set,f1-rst,f1-q,f1-qn") fail(`ids moved: ${ids}`);
    },
  },
  {
    name: "switching the kind rebuilds the pins",
    run: (fail) => {
      const f = new DFlipFlop("f1", "U1");
      f.setProperty("kind", "dlatch");
      if (!f.getPort("EN")) fail("latch has no EN pin after the switch");
      f.setProperty("kind", "tff");
      if (!f.getPort("T")) fail("T flip-flop has no T pin after the switch");
      if (f.getPort("D")) fail("still has a D pin");
    },
  },
  {
    name: "the .asc attribute restores edge and Set/Reset polarity",
    run: (fail) => {
      // LTSpice's dflop symbol says nothing about either, so a file that lost
      // the LibreSpice attribute would come back as a rising-edge, active-high
      // part — simulating cleanly while behaving like a different circuit.
      const asc = `Version 4
SHEET 1 880 680
SYMBOL Digital\\\\dflop 100 100 R0
SYMATTR InstName U7
SYMATTR Value DFF-
SYMATTR LibreSpice kind=dlatch;edge=falling;async=low;vth=1.4;vhigh=3.3;pins=D,EN,SET,RESET,Q,~Q
`;
      const { components, nodes } = LTSpiceParser.parse(asc);
      const comp = components[0] as DFlipFlop | undefined;
      if (!comp) { fail("nothing parsed"); return; }
      if (!(comp instanceof DFlipFlop)) { fail("did not parse as a D flip-flop"); return; }
      if (comp.kind !== "dlatch") fail(`kind = ${comp.kind}`);
      if (!comp.getPort("EN")) fail("kind did not rebuild the pins");
      if (comp.edge !== "falling") fail(`edge = ${comp.edge}`);
      if (comp.asyncPolarity !== "low") fail(`async = ${comp.asyncPolarity}`);
      if (comp.threshold !== 1.4 || comp.vHigh !== 3.3) fail("levels lost");
      // The node carries them too, or the symbol draws the wrong part.
      const d = nodes.find((n) => n.data.componentType === "dff")?.data;
      if (d?.kind !== "dlatch") fail(`node kind: ${JSON.stringify(d)}`);
      if (d?.edge !== "falling" || d?.asyncPolarity !== "low") {
        fail(`node data: ${JSON.stringify(d)}`);
      }
    },
  },
];

export function runDFlipFlopTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}
