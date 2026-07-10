import { runSvgExportTests } from "./svgExport.test.js";
import { runSvgPositionTests } from "./svgPositions.test.js";
import { runComponentValueTests } from "./componentValue.test.js";
import { runPointerDragTests } from "./pointerDrag.test.js";
import { runLongPressTests } from "./longPress.test.js";
import { runExpressionTests } from "../../simulation/regression/expression.test.js";

export interface Suite { name: string; total: number; passed: number; failures: { name: string; reason: string }[] }

/** Every non-library regression suite (SVG export, plot expressions). */
export async function runAllSuites(): Promise<Suite[]> {
  return [
    { name: "SVG export", ...runSvgExportTests() },
    { name: "SVG positions", ...runSvgPositionTests() },
    { name: "Component values", ...runComponentValueTests() },
    { name: "Pointer drag", ...runPointerDragTests() },
    // Long press waits on real timers, so this suite is asynchronous.
    { name: "Long press", ...(await runLongPressTests()) },
    { name: "Plot expressions", ...runExpressionTests() },
  ];
}
