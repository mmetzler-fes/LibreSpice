import { Simulation, type ResultType } from "eecircuit-engine";
import type { SimulationResult } from "@store/simulationStore.js";

let sim: Simulation | null = null;

async function getSimulation(): Promise<Simulation> {
  if (!sim) {
    sim = new Simulation();
    await sim.start();
  }
  return sim;
}

export async function runSimulation(netlist: string): Promise<SimulationResult> {
  try {
    const engine = await getSimulation();
    engine.setNetList(netlist);
    const result: ResultType = await engine.runSim();
    return convertResult(result);
  } catch (e) {
    sim = null;
    throw new Error(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function convertResult(result: ResultType): SimulationResult {
  const variables = result.variableNames;
  const data: Record<string, Float64Array> = {};

  if (result.dataType === "real") {
    for (const d of result.data) {
      data[d.name] = new Float64Array(d.values as number[]);
    }
  } else {
    for (const d of result.data) {
      const complexVals = d.values as Array<{ real: number; img: number }>;
      data[d.name] = new Float64Array(complexVals.map((v) => Math.sqrt(v.real ** 2 + v.img ** 2)));
    }
  }

  const time = data["time"] ?? data[variables[0]];
  return { variables, data, time };
}
