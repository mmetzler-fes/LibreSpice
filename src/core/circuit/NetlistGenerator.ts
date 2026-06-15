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

/** Regex to detect analysis commands at the start of a directive line */
const ANALYSIS_RE = /^\.(tran|ac|dc|op)\b/i;

export class NetlistGenerator {
  generate(
    circuit: Circuit,
    config: SimulationConfig,
    directives = "",
    title = "LibreSpice Netlist",
  ): string {
    const lines: string[] = [`* ${title}`];

    for (const component of circuit.components.values()) {
      const line = component.getNetlistLine();
      if (line) lines.push(line);
    }

    // Parse directive lines – skip blank lines and full-line comments
    const directiveLines = directives
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("*"));

    // Only emit auto-generated analysis line when directives don't contain one
    const hasAnalysisInDirectives = directiveLines.some((l) => ANALYSIS_RE.test(l));
    if (!hasAnalysisInDirectives) {
      lines.push(this._analysisLine(config));
    }

    // Append custom directive lines
    for (const dl of directiveLines) {
      lines.push(dl);
    }

    lines.push(".end");

    let netlist = lines.join("\n");

    // Replace internal net IDs with user-defined labels
    for (const [id, net] of circuit.nets) {
      if (net.nodeLabel !== id && id !== "0") {
        // net IDs are alphanumeric (net1, net2, …) – word boundaries are safe
        const re = new RegExp(`\\b${id}\\b`, "g");
        netlist = netlist.replace(re, net.nodeLabel);
      }
    }

    return netlist;
  }

  private _analysisLine(config: SimulationConfig): string {
    switch (config.type) {
      case "tran":
        return `.tran ${config.stepTime} ${config.stopTime}${config.startTime ? ` ${config.startTime}` : ""}`;
      case "dc":
        return `.dc ${config.sourceName} ${config.start} ${config.stop} ${config.step}`;
      case "ac":
        return `.ac ${config.variation} ${config.points} ${config.startFreq} ${config.stopFreq}`;
      case "op":
        return ".op";
    }
  }
}
