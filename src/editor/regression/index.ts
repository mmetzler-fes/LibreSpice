import { runSvgExportTests } from "./svgExport.test.js";
import { runSvgPositionTests } from "./svgPositions.test.js";
import { runComponentValueTests } from "./componentValue.test.js";
import { runPointerDragTests } from "./pointerDrag.test.js";
import { runLongPressTests } from "./longPress.test.js";
import { runNetlistPrefixTests } from "./netlistPrefix.test.js";
import { runAscConnectivityTests } from "./ascConnectivity.test.js";
import { runShareLinkTests } from "./shareLink.test.js";
import { runPlacementTests } from "./placement.test.js";
import { runNetLabelTests } from "./netLabel.test.js";
import { runNetlabelProbeTests } from "./netlabelProbe.test.js";
import { runNetRenameTests } from "./netRename.test.js";
import { runAutoConnectTests } from "./autoConnect.test.js";
import { runKeyboardViewportTests } from "./keyboardViewport.test.js";
import { runToolbarTests } from "./toolbar.test.js";
import { runExpressionTests } from "../../simulation/regression/expression.test.js";
import { runPlotSettingsTests } from "../../simulation/regression/plotSettings.test.js";
import { runProbeSelectionTests } from "../../simulation/regression/probeSelection.test.js";

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
    { name: "Plot settings (.plt)", ...runPlotSettingsTests() },
    { name: "Probe selection", ...runProbeSelectionTests() },
    { name: "Netlist prefixes", ...runNetlistPrefixTests() },
    { name: "ASC connectivity", ...runAscConnectivityTests() },
    { name: "Placement ghost", ...runPlacementTests() },
    { name: "Auto-connect docking", ...runAutoConnectTests() },
    // Net-label consistency drives the store, whose rebuilds are deferred a tick.
    { name: "Net labels", ...(await runNetLabelTests()) },
    { name: "Net-label probe menu", ...(await runNetlabelProbeTests()) },
    { name: "Net rename propagation", ...(await runNetRenameTests()) },
    { name: "Keyboard viewport", ...runKeyboardViewportTests() },
    { name: "Toolbar", ...runToolbarTests() },
    // Share links/QR codes decompress asynchronously.
    { name: "Share links", ...(await runShareLinkTests()) },
  ];
}
