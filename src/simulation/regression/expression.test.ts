import type { SimulationResult } from "@store/simulationStore.js";
import { evalExpression } from "../expression.js";

export interface TestReport {
  total: number;
  passed: number;
  failures: { name: string; reason: string }[];
}

/** Build a tiny result with a shared time base and named series. */
function makeResult(series: Record<string, number[]>): SimulationResult {
  const time = new Float64Array([0, 1, 2]);
  const data: Record<string, Float64Array> = { time };
  for (const [k, v] of Object.entries(series)) data[k] = new Float64Array(v);
  return { variables: ["time", ...Object.keys(series)], data, time };
}

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  {
    name: "arithmetic over two probes",
    run: (fail) => {
      const res = makeResult({ "v(a)": [3, 4, 5], "v(b)": [1, 1, 1] });
      const r = evalExpression(res, "V(a)-V(b)");
      if (r.error) return fail(r.error);
      if (!r.values || Array.from(r.values).join(",") !== "2,3,4") fail(`got ${r.values && Array.from(r.values)}`);
    },
  },
  {
    name: "{param} resolves a component value (I(R1)*{R1})",
    run: (fail) => {
      const res = makeResult({ "i(r1)": [0.1, 0.2, 0.3] });
      const r = evalExpression(res, "I(R1)*{R1}", { R1: 100 });
      if (r.error) return fail(r.error);
      // 0.1*100, 0.2*100, 0.3*100
      const got = r.values && Array.from(r.values).map((v) => Math.round(v));
      if (!got || got.join(",") !== "10,20,30") fail(`got ${got}`);
    },
  },
  {
    name: "{param} lookup is case-insensitive",
    run: (fail) => {
      const res = makeResult({ "v(a)": [2, 2, 2] });
      const r = evalExpression(res, "V(a)*{r1}", { R1: 3 });
      if (r.error) return fail(r.error);
      if (!r.values || Array.from(r.values).join(",") !== "6,6,6") fail(`got ${r.values && Array.from(r.values)}`);
    },
  },
  {
    name: "unknown {param} reports an error",
    run: (fail) => {
      const res = makeResult({ "v(a)": [1, 1, 1] });
      const r = evalExpression(res, "V(a)*{Rx}", { R1: 3 });
      if (!r.error) fail("expected an error for unknown parameter");
    },
  },
];

export function runExpressionTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}
