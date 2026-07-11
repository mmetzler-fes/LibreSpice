import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { Diode, BJT, MOSFET } from "@core/components/semiconductors/Semiconductors.js";
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
];

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
