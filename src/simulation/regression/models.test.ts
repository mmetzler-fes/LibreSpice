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
  return shippedLib("Discretes.lib");
}

/** Any one shipped library file, by name. */
async function shippedLib(name: string): Promise<string> {
  const { fs, path, proc } = await nodeApi();
  return fs.readFileSync(path.join(proc.cwd(), "library/sub", name), "utf8");
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
    const models = [...text.matchAll(/^\.model\s+(\S+)\s+(NPN|PNP|NMOS|PMOS|NJF|PJF)\b/gim)]
      .map((m) => ({ name: m[1], kind: m[2].toUpperCase() }));
    if (models.length === 0) { fail("no .model lines found in library/sub/Discretes.lib"); return; }
    for (const { name, kind } of models) {
      // A JFET conducts at Vgs = 0 and pinches off the other way round, so its
      // rig grounds the gate rather than driving it.
      const dev = kind === "NPN" || kind === "PNP"
        ? `Q1 c b 0 ${name}\nVC c 0 DC ${kind === "NPN" ? 5 : -5}\nIB ${kind === "NPN" ? "0 b" : "b 0"} DC 10u`
        : kind === "NJF" || kind === "PJF"
          ? `J1 d 0 0 ${name}\nVD d 0 DC ${kind === "NJF" ? 5 : -5}`
          : `M1 d g 0 0 ${name}\nVG g 0 DC ${kind === "NMOS" ? 5 : -5}\nVD d 0 DC ${kind === "NMOS" ? 5 : -5}`;
      try {
        await sim(`* run ${name}\n${dev}\n${text}\n.options savecurrents\n.op\n.end\n`);
      } catch (e) {
        fail(`${name} (${kind}) did not simulate: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } },

  { name: "MMBF4393L meets its datasheet Idss and rds(on)", run: async (fail) => {
    const text = await shippedModels();
    // Idss 5…30 mA at Vds = 15 V, Vgs = 0 (onsemi MMBF4393), fitted to ~20 mA.
    const d = await sim(`* idss\nJ1 d 0 0 MMBF4393L\nVD d 0 DC 15\n${text}\n.options savecurrents\n.op\n.end\n`);
    const idss = Math.abs(last(d, "i(vd)"));
    if (!(idss > 5e-3 && idss < 30e-3)) {
      fail(`Idss at Vds=15 V is ${(idss * 1e3).toFixed(1)} mA, outside the datasheet band 5…30 mA`);
    }
    // rds(on) <= 100 Ohm at Vgs = 0, read at a Vds small enough to stay ohmic.
    // This is the figure the Wien oscillator's amplitude control depends on.
    const r = await sim(`* rds\nJ1 d 0 0 MMBF4393L\nVD d 0 DC 0.1\n${text}\n.options savecurrents\n.op\n.end\n`);
    const rds = 0.1 / Math.abs(last(r, "i(vd)"));
    if (!(rds > 0 && rds <= 100)) fail(`rds(on) is ${rds.toFixed(1)} Ohm, above the datasheet limit 100 Ohm`);
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

  { name: "LM317 holds its 1.25 V reference across the load range", run: async (fail) => {
    // The regulator's one defining figure. Wired as a constant-current source —
    // which is what the schematic that needs it does — a 62 ohm resistor between
    // out and adj should pass 1.25/62 = 20.2 mA whatever the load, so both the
    // reference voltage and the fact that it *regulates* are checked at once.
    const text = await shippedLib("LM317.lib");
    const currents: number[] = [];
    for (const rload of [100, 400, 800]) {
      const d = await sim(
        `* lm317\nV1 in 0 24\nX1 in adj out LM317/TI\nR1 out adj 62\nRload adj 0 ${rload}\n${text}\n.op\n.end\n`,
      );
      const drop = last(d, "v(out)") - last(d, "v(adj)");
      if (!(drop > 1.15 && drop < 1.35)) {
        fail(`reference is ${drop.toFixed(3)} V at Rload=${rload}, outside 1.15…1.35 V`);
        return;
      }
      currents.push(drop / 62);
    }
    // Regulation: the current must not drift more than a few percent as the
    // load changes eightfold. A model that merely sat at 1.25 V open-circuit
    // would pass the check above but fail this one.
    const spread = (Math.max(...currents) - Math.min(...currents)) / Math.min(...currents);
    if (spread > 0.05) fail(`current varies by ${(spread * 100).toFixed(1)}% across the load range`);
  } },

  { name: "74LS93 counts 0..15 and clears on both reset inputs", run: async (fail) => {
    // Four counting flip-flops and a reset NAND. QA is wired to CKB, which is
    // how the datasheet makes the two dividers one 4-bit counter, so this walks
    // the whole cycle rather than just checking that something toggles.
    const text = await shippedLib("74LS93.lib");
    const d = await sim(
      `* 74ls93\nVck cka 0 PULSE(5 0 0 1n 1n 2u 4u)\n` +
      `Vr1 r01 0 PULSE(5 0 1u 1n 1n 100u 200u)\nVr2 r02 0 PULSE(5 0 1u 1n 1n 100u 200u)\n` +
      `X1 cka qa r01 r02 qa qb qc qd 74LS93\n${text}\n.tran 0.05u 72u\n.end\n`,
    );
    const time = d["time"];
    const bits = ["v(qa)", "v(qb)", "v(qc)", "v(qd)"].map((k) => d[k]);
    if (bits.some((b) => !b)) { fail(`missing outputs: ${Object.keys(d).join(",")}`); return; }
    const countAt = (us: number) => {
      let i = 0;
      for (let k = 0; k < time.length; k++) if (time[k] <= us * 1e-6) i = k;
      return bits.reduce((acc, b, n) => acc + (b[i] > 2.5 ? 1 << n : 0), 0);
    };
    // Both resets are high until 1 us, so the counter must be held at zero.
    if (countAt(0.5) !== 0) fail(`reset did not clear: count = ${countAt(0.5)}`);
    // Then one full cycle plus the roll-over, sampled between clock edges.
    for (let n = 0; n <= 16; n++) {
      const got = countAt(3 + n * 4);
      if (got !== n % 16) { fail(`step ${n}: counted ${got}, expected ${n % 16}`); return; }
    }
  } },

  { name: "SCR latches on a gate pulse and holds after it is released", run: async (fail) => {
    // The defining thyristor behaviour, and the one the model got wrong at
    // first: with the gate pin left out of the subcircuit it could never be
    // triggered at all. Gate pulse at 2 ms, gone again by 2.2 ms.
    const text = await shippedLib("Thyristor.lib");
    const d = await sim(
      `* scr\nV1 vcc 0 DC 12\nRload vcc load 100\nX1 load gate 0 SCR\n` +
      `Vg src 0 PULSE(0 3 2m 1u 1u 0.2m 100m)\nRg src gate 100\n${text}\n.tran 0.02m 10m\n.end\n`,
    );
    const time = d["time"], load = d["v(load)"];
    if (!load) { fail(`no v(load): ${Object.keys(d).join(",")}`); return; }
    const at = (ms: number) => {
      let i = 0;
      for (let k = 0; k < time.length; k++) if (time[k] <= ms * 1e-3) i = k;
      return load[i];
    };
    // Blocking: the load carries no current, so it sits at the supply.
    if (at(1) < 11) fail(`did not block before the trigger: v(load) = ${at(1).toFixed(2)} V`);
    // Conducting: the anode-cathode drop is a volt or so.
    if (at(3) > 2) fail(`did not fire: v(load) = ${at(3).toFixed(2)} V`);
    // Latched: still on long after the gate went away.
    if (at(9) > 2) fail(`did not stay latched: v(load) = ${at(9).toFixed(2)} V`);
  } },

  { name: "BZB84-B6V2 breaks down at its 6.2 V rating", run: async (fail) => {
    // Reverse-biased through a resistor: the zener must clamp near 6.2 V, and
    // conduct normally in the forward direction.
    const text = await shippedModels();
    const rev = await sim(`* z\nV1 in 0 DC 15\nR1 in k 1k\nD1 0 k BZB84B6V2\n${text}\n.op\n.end\n`);
    const vz = last(rev, "v(k)");
    if (!(vz > 5.8 && vz < 6.8)) fail(`breakdown is ${vz.toFixed(2)} V, outside the 5.8…6.6 V band`);
    const fwd = await sim(`* z\nV1 in 0 DC 5\nR1 in a 1k\nD1 a 0 BZB84B6V2\n${text}\n.op\n.end\n`);
    const vf = last(fwd, "v(a)");
    if (!(vf > 0.4 && vf < 1.0)) fail(`forward drop is ${vf.toFixed(2)} V, not a conducting diode`);
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
