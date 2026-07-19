import { runSimulation } from "../simulationEngine.js";
import { useSimulationStore } from "@store/simulationStore.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Every model shipped in `library/sub/` must actually run, and must still hit
 * the datasheet figures it was fitted to.
 *
 * The "must run" half is not a formality. A parameter that does not belong to
 * its model class does not get ignored — `LAMBDA` in a LEVEL-3 MOSFET ends
 * ngspice with `strtod: Invalid argument` and exit(1), which surfaces in the app
 * only as a simulation that never returns. That is exactly how the first draft
 * of these models arrived, so the guard stays.
 *
 * The figures below are the manufacturer datasheet values; the tolerances are
 * wide enough for a fitted approximation but tight enough that a transposed
 * digit fails.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path, proc: (globalThis as any).process };
}

/** The shipped model text, so the test reads what the app would load. */
async function shippedModels(): Promise<string> {
  const { fs, path, proc } = await nodeApi();
  return fs.readFileSync(path.join(proc.cwd(), "library/sub/Discretes.lib"), "utf8");
}

async function sim(netlist: string): Promise<Record<string, Float64Array>> {
  useSimulationStore.getState().setStatus("running");
  return (await runSimulation(netlist)).data;
}
const last = (d: Record<string, Float64Array>, k: string) => {
  const a = d[k];
  return a ? a[a.length - 1] : NaN;
};
/** Relative deviation, as a fraction. */
const off = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);

const CASES: Case[] = [
  { name: "every shipped .model runs without killing ngspice", run: async (fail) => {
    const text = await shippedModels();
    const models = [...text.matchAll(/^\.model\s+(\S+)\s+(NPN|PNP|NMOS|PMOS)\b/gim)]
      .map((m) => ({ name: m[1], kind: m[2].toUpperCase() }));
    if (models.length === 0) { fail("no .model lines found in library/sub/Discretes.lib"); return; }
    for (const { name, kind } of models) {
      const dev = kind === "NPN" || kind === "PNP"
        ? `Q1 c b 0 ${name}\nVC c 0 DC ${kind === "NPN" ? 5 : -5}\nIB ${kind === "NPN" ? "0 b" : "b 0"} DC 10u`
        : `M1 d g 0 0 ${name}\nVG g 0 DC ${kind === "NMOS" ? 5 : -5}\nVD d 0 DC ${kind === "NMOS" ? 5 : -5}`;
      try {
        await sim(`* run ${name}\n${dev}\n${text}\n.options savecurrents\n.op\n.end\n`);
      } catch (e) {
        fail(`${name} (${kind}) did not simulate: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } },

  { name: "2N2222A meets its datasheet hFE and Vce(sat)", run: async (fail) => {
    const text = await shippedModels();
    // hFE 75..300 at Ic=10 mA (onsemi P2N2222A), fitted to ~200.
    const g = await sim(`* h\nQ1 c b 0 2N2222A\nVCE c 0 DC 10\nIB 0 b DC 50u\n${text}\n.options savecurrents\n.op\n.end\n`);
    const hfe = last(g, "i(@q1[ic])") / last(g, "i(@q1[ib])");
    if (!(hfe > 75 && hfe < 300)) fail(`hFE at Ic≈10 mA is ${hfe.toFixed(0)}, outside the datasheet band 75…300`);
    // Vce(sat) <= 0.3 V at Ic=150 mA, Ib=15 mA.
    const s = await sim(`* s\nQ1 c b 0 2N2222A\nIC 0 c DC 0.15\nIB 0 b DC 0.015\n${text}\n.op\n.end\n`);
    const vsat = Math.abs(last(s, "v(c)"));
    if (!(vsat <= 0.3)) fail(`Vce(sat) is ${vsat.toFixed(3)} V, above the datasheet limit 0.3 V`);
  } },

  { name: "2N2907A meets its datasheet hFE and Vce(sat)", run: async (fail) => {
    const text = await shippedModels();
    const g = await sim(`* h\nQ1 c b 0 2N2907A\nVCE c 0 DC -10\nIB b 0 DC 50u\n${text}\n.options savecurrents\n.op\n.end\n`);
    const hfe = Math.abs(last(g, "i(@q1[ic])") / last(g, "i(@q1[ib])"));
    if (!(hfe > 75 && hfe < 300)) fail(`hFE at |Ic|≈10 mA is ${hfe.toFixed(0)}, outside 75…300`);
    const s = await sim(`* s\nQ1 c b 0 2N2907A\nIC c 0 DC 0.15\nIB b 0 DC 0.015\n${text}\n.op\n.end\n`);
    const vsat = Math.abs(last(s, "v(c)"));
    if (!(vsat <= 0.4)) fail(`|Vce(sat)| is ${vsat.toFixed(3)} V, above the datasheet limit 0.4 V`);
  } },

  { name: "2N7002 hits Rds(on) at both datasheet points", run: async (fail) => {
    const text = await shippedModels();
    // Source and bulk at 0, current pushed *into* the drain — the other way round
    // the body diode conducts and one measures the diode, not the channel.
    const rds = async (vgs: number, id: number) => {
      const d = await sim(`* r\nM1 d g 0 0 2N7002\nVG g 0 DC ${vgs}\nID 0 d DC ${id}\n${text}\n.op\n.end\n`);
      return last(d, "v(d)") / id;
    };
    for (const [vgs, id, want] of [[10, 0.5, 1.2], [5, 0.05, 1.7]] as const) {
      const got = await rds(vgs, id);
      if (off(got, want) > 0.15) fail(`Rds(on) at Vgs=${vgs} V, Id=${id * 1000} mA is ${got.toFixed(3)} Ω, datasheet typ ${want} Ω`);
    }
  } },

  { name: "BSS84 hits Rds(on) at both datasheet points", run: async (fail) => {
    const text = await shippedModels();
    // P-channel: source and bulk at the positive rail, current drawn *out* of
    // the drain (same body-diode trap as above, mirrored).
    const rds = async (vgs: number, id: number, vdd = 20) => {
      const d = await sim(`* r\nVS s 0 DC ${vdd}\nM1 d g s s BSS84\nVG g 0 DC ${vdd + vgs}\nID d 0 DC ${id}\n${text}\n.op\n.end\n`);
      return (vdd - last(d, "v(d)")) / id;
    };
    for (const [vgs, id, want] of [[-4.5, 0.15, 9.9], [-10, 0.15, 8.0]] as const) {
      const got = await rds(vgs, id);
      if (off(got, want) > 0.15) fail(`Rds(on) at Vgs=${vgs} V, |Id|=${id * 1000} mA is ${got.toFixed(3)} Ω, datasheet ${want} Ω`);
    }
  } },
];

CASES.push(
  { name: "output characteristics of 05-1-2_Transistor2 match the LTSpice reference", run: async (fail) => {
    // The circuit that exposed the problem: `.dc V1 0 20 0.1  I1 list 1m…20m`
    // over a 2N2222 with a 10 Ω collector resistor. Reference values read off a
    // plot produced in LTSpice with its own 2N2222 model, at V1 = 20 V.
    //
    // What made this fail was a *missing* parameter, not a wrong one: the
    // generic fallback `NPN(Bf=200 Is=1f Vaf=100)` carries no IKF, so hFE never
    // rolls off at high current. Ic then rose to the load-line limit of
    // V1/R1 = 2 A instead of the ~1 A the real device manages, and the top three
    // curves collapsed onto each other.
    const text = await shippedModels();
    const ref: Record<string, number> = {
      "1m": 0.150, "2m": 0.245, "3m": 0.320, "5m": 0.420,
      "7m": 0.550, "10m": 0.640, "15m": 0.810, "20m": 0.950,
    };
    const d = await sim(
      `* Transistor2\nQ1 C B 0 2N2222\nI1 0 B DC 5m\nR1 U1 C 10\nV1 U1 0 DC 10\n${text}\n` +
      `.options savecurrents\n.dc V1 0V 20V 0.1V I1 list 1mA 2mA 3mA 5mA 7mA 10mA 15mA 20mA\n.end\n`,
    );
    const curves = Object.keys(d).filter((k) => k.includes("q1[ic]"));
    if (curves.length !== 8) { fail(`expected 8 stepped curves, got ${curves.length}`); return; }
    for (const key of curves) {
      const ib = key.match(/I1=(\S+)$/)?.[1] ?? "";
      const want = ref[ib];
      if (want === undefined) { fail(`unexpected step tag in "${key}"`); continue; }
      const got = last(d, key);
      // 20 %: the reference is read off a plot, and the model is a fit.
      if (off(got, want) > 0.2) {
        fail(`Ic at Ib=${ib} is ${(got * 1e3).toFixed(0)} mA, LTSpice gives ${(want * 1e3).toFixed(0)} mA`);
      }
    }
  } },
);

export async function runModelTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}
