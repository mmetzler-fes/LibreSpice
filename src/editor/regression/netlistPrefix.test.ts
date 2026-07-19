import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { Diode, BJT, MOSFET } from "@core/components/semiconductors/Semiconductors.js";
import { normalizeMeasDirective, normalizeParamDirective } from "@core/circuit/NetlistGenerator.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * ngspice keys a device off the first letter of its reference designator
 * (R/C/L/D/Q/M/…). A component the user named against convention — e.g. a
 * resistor labelled "U1" (as in OP-nicht_inv_Verstaerker.asc) — must still emit
 * a line starting with its own device letter, or ngspice mis-parses it ("U…" as
 * a lossy/URC line) and the whole simulation fails. Pin that each device forces
 * its prefix, while conventional names pass through unchanged.
 */
type Case = { name: string; run: (fail: (r: string) => void) => void };

const firstToken = (line: string) => line.trim().split(/\s+/)[0];

const CASES: Case[] = [
  { name: "resistor 'U1' → RU1", run: (fail) => {
    const t = firstToken(new Resistor("r", "U1").getNetlistLine());
    if (t !== "RU1") fail(`expected RU1, got ${t}`);
  } },
  { name: "resistor 'R1' unchanged", run: (fail) => {
    const t = firstToken(new Resistor("r", "R1").getNetlistLine());
    if (t !== "R1") fail(`expected R1, got ${t}`);
  } },
  { name: "capacitor 'X' → CX", run: (fail) => {
    const t = firstToken(new Capacitor("c", "X").getNetlistLine());
    if (t !== "CX") fail(`expected CX, got ${t}`);
  } },
  { name: "inductor 'L2' unchanged", run: (fail) => {
    const t = firstToken(new Inductor("l", "L2").getNetlistLine());
    if (t !== "L2") fail(`expected L2, got ${t}`);
  } },
  { name: "diode 'U3' → DU3", run: (fail) => {
    const t = firstToken(new Diode("d", "U3").getNetlistLine());
    if (t !== "DU3") fail(`expected DU3, got ${t}`);
  } },
  { name: "bjt 'U4' → QU4", run: (fail) => {
    const t = firstToken(new BJT("q", "U4").getNetlistLine());
    if (t !== "QU4") fail(`expected QU4, got ${t}`);
  } },
  { name: "mosfet 'U5' → MU5", run: (fail) => {
    const t = firstToken(new MOSFET("m", "U5").getNetlistLine());
    if (t !== "MU5") fail(`expected MU5, got ${t}`);
  } },

  // ── .meas: LTSpice's differential probe ─────────────────────────────────────
  { name: ".meas V(a,b) → par('v(a)-v(b)') (ngspice has no such vector)", run: (fail) => {
    // A6_B2U-Schaltung1_Glaeetung1.asc measures the bridge output as V(U2+,U2-).
    // ngspice fails the whole measurement on it ("no such vector as 'v(u2+,u2-)'")
    // — and it rejects a bare (v(a)-v(b)) just the same; only par('…') runs.
    // Verified against the engine: the translated line yields ubrpp = 1.954e+01.
    const out = normalizeMeasDirective(".meas TRAN UBrPP PP V(U2+,U2-) FROM 20ms");
    if (!out.includes("par('v(U2+)-v(U2-)')")) fail(`not translated: ${out}`);
    if (/v\s*\([^)]*,/i.test(out)) fail(`a differential probe survived: ${out}`);
    // The FROM keyword still becomes from= (the existing normalisation).
    if (!/\bfrom=20ms\b/.test(out)) fail(`from= lost: ${out}`);
  } },

  { name: ".meas V(a,0) drops the ground term", run: (fail) => {
    const out = normalizeMeasDirective(".meas TRAN u PP V(out,0)");
    if (!out.includes("par('v(out)-0')")) fail(`ground term not dropped: ${out}`);
  } },

  { name: "a plain .meas and a non-.meas line are left alone", run: (fail) => {
    const plain = ".meas TRAN u PP V(out) from=1ms";
    if (normalizeMeasDirective(plain) !== plain) fail(`rewritten: ${normalizeMeasDirective(plain)}`);
    const tran = ".tran 1m 40m";
    if (normalizeMeasDirective(tran) !== tran) fail(`non-.meas line touched: ${normalizeMeasDirective(tran)}`);
  } },
];

CASES.push(
  { name: ".param without an equals sign is rewritten for ngspice", run: (fail) => {
    // LTSpice writes `.param T 1ms`; ngspice needs `.param T=1ms`. Handed the
    // space form the bundled engine does not report a syntax error — it never returns,
    // and because runSim() blocks the thread the run timeout cannot fire either.
    // A08_PWM4.asc sat on "running" for ever because of this one missing `=`.
    const cases: [string, string][] = [
      [".param T 1ms", ".param T=1ms"],
      [".param Rvar 1k", ".param Rvar=1k"],
      [".param a 1 b 2", ".param a=1 b=2"],
      [".param x {a+b}", ".param x={a+b}"],
      [".PARAM  T  1ms", ".PARAM  T=1ms"],
    ];
    for (const [input, want] of cases) {
      const got = normalizeParamDirective(input);
      if (got !== want) fail(`"${input}" became "${got}", expected "${want}"`);
    }
  } },

  { name: ".meas PARAM gets the equals sign ngspice insists on", run: (fail) => {
    // LTSpice writes `.meas TRAN P PARAM <expr>`; ngspice answers "syntax error
    // for measure statement; missing '='!" and reports the measurement as
    // `failed`. Isolated against the engine: the Ohm suffix, the ** operator and
    // the reference to an earlier .meas result are all fine once the `=` is
    // there — the sign was the only thing missing.
    const cases: [string, string][] = [
      [".meas TRAN PR1 PARAM U1eff**2/10Ohm", ".meas TRAN PR1 PARAM='U1eff**2/10Ohm'"],
      [".meas TRAN P PARAM a + b", ".meas TRAN P PARAM='a + b'"],
    ];
    for (const [input, want] of cases) {
      const got = normalizeMeasDirective(input);
      if (got !== want) fail(`"${input}" became "${got}", expected "${want}"`);
    }
    // `AT` needs the same sign: LTSpice writes `FIND V(x) AT 2ms`, ngspice
    // answers "bad syntax of WHEN" and fails the measurement.
    if (normalizeMeasDirective(".meas TRAN F FIND V(U1) AT 2ms") !== ".meas TRAN F FIND V(U1) at=2ms") {
      fail(`FIND … AT was not rewritten: ${normalizeMeasDirective(".meas TRAN F FIND V(U1) AT 2ms")}`);
    }
    // Already-correct forms must survive untouched, however they are delimited.
    for (const line of [".meas TRAN PR1 PARAM='a/10'", ".meas TRAN P PARAM={a+b}", ".meas TRAN U1eff RMS V(U1)"]) {
      if (normalizeMeasDirective(line) !== line) fail(`"${line}" was rewritten`);
    }
  } },

  { name: ".param already in ngspice form is left alone", run: (fail) => {
    // Rewriting an expression that merely contains spaces would corrupt it.
    const untouched = [".param ti=g*T/100", ".param a=1 b=2", ".param lonely"];
    for (const line of untouched) {
      const got = normalizeParamDirective(line);
      if (got !== line) fail(`"${line}" was rewritten to "${got}"`);
    }
    // Spaces around the equals sign are LTSpice-legal and must collapse, not split.
    if (normalizeParamDirective(".param ti = g*T/100") !== ".param ti=g*T/100") {
      fail("`.param ti = g*T/100` did not collapse to `ti=g*T/100`");
    }
    // Only .param lines are touched.
    if (normalizeParamDirective(".tran 4u 4ms uic") !== ".tran 4u 4ms uic") {
      fail("a .tran line was rewritten");
    }
  } },
);

export function runNetlistPrefixTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];

  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}