import { Simulation, type ResultType } from "eecircuit-engine";
import type { SimulationResult } from "@store/simulationStore.js";
import { useSimulationStore } from "@store/simulationStore.js";

let sim: Simulation | null = null;

async function getSimulation(): Promise<Simulation> {
  if (!sim) {
    sim = new Simulation();
    await sim.start();
  }
  return sim;
}

/** Read the ngspice stdout/stderr log from the engine and push it to the store. */
function captureLog(engine: Simulation, netlist: string): void {
  const parts: string[] = [];
  const tryGet = (fn: () => string | string[]): string => {
    try {
      const v = fn();
      return Array.isArray(v) ? v.join("\n") : v;
    } catch {
      return "";
    }
  };
  parts.push("===== Netlist =====", netlist.trim());
  const info = tryGet(() => engine.getInfo());
  const errors = tryGet(() => engine.getError());
  if (info.trim()) parts.push("===== ngspice output =====", info.trim());
  if (errors.trim()) parts.push("===== Errors / warnings =====", errors.trim());
  useSimulationStore.getState().setLog(parts.join("\n\n"));
}

export async function runSimulation(netlist: string): Promise<SimulationResult> {
  let engine: Simulation | undefined;
  try {
    engine = await getSimulation();
    engine.setNetList(netlist);
    const result: ResultType = await engine.runSim();
    captureLog(engine, netlist);
    return convertResult(result);
  } catch (e) {
    if (engine) captureLog(engine, netlist);
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
