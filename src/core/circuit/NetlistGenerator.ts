import type { Circuit } from "./Circuit.js";

export interface TransientConfig {
  type: "tran";
  stepTime: number;
  stopTime: number;
  startTime?: number;
}

export interface DCConfig {
  type: "dc";
  sourceName: string;
  start: number;
  stop: number;
  step: number;
}

export interface ACConfig {
  type: "ac";
  variation: "DEC" | "OCT" | "LIN";
  points: number;
  startFreq: number;
  stopFreq: number;
}

export interface OPConfig {
  type: "op";
}

export type SimulationConfig = TransientConfig | DCConfig | ACConfig | OPConfig;

export class NetlistGenerator {
  generate(circuit: Circuit, config: SimulationConfig, title = "LibreSpice Netlist"): string {
    const lines: string[] = [`* ${title}`];

    for (const component of circuit.components.values()) {
      const line = component.getNetlistLine();
      if (line) lines.push(line);
    }

    lines.push(this._analysisLine(config));
    lines.push(".end");

    return lines.join("\n");
  }

  private _analysisLine(config: SimulationConfig): string {
    switch (config.type) {
      case "tran":
        return `.tran ${config.stepTime} ${config.stopTime}${config.startTime ? ` ${config.startTime}` : ""}`;
      case "dc": {
        return `.dc ${config.sourceName} ${config.start} ${config.stop} ${config.step}`;
      }
      case "ac":
        return `.ac ${config.variation} ${config.points} ${config.startFreq} ${config.stopFreq}`;
      case "op":
        return ".op";
    }
  }
}
