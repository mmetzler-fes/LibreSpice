import { runSvgExportTests } from "./svgExport.test.js";
import { runExpressionTests } from "../../simulation/regression/expression.test.js";

export interface Suite { name: string; total: number; passed: number; failures: { name: string; reason: string }[] }

/** Every non-library regression suite (SVG export, plot expressions). */
export function runAllSuites(): Suite[] {
  return [
    { name: "SVG export", ...runSvgExportTests() },
    { name: "Plot expressions", ...runExpressionTests() },
  ];
}
