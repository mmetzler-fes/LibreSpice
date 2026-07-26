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
import { runWireConnectorTests } from "./wireConnector.test.js";
import { runAscExamplesTests } from "./ascExamples.test.js";
import { runAscFidelityTests } from "./ascFidelity.test.js";
import { runPinReseatTests } from "./pinReseat.test.js";
import { runClipboardTests } from "./clipboard.test.js";
import { runNetAnchorTests } from "./netAnchor.test.js";
import { runMs14Tests } from "./ms14.test.js";
import { runPwlSourceTests } from "./pwlSource.test.js";
import { runPulseSourceTests } from "./pulseSource.test.js";
import { runLogicGateTests } from "./logicGate.test.js";
import { runDFlipFlopTests } from "./dFlipFlop.test.js";
import { runDigitalGeometryTests } from "./digitalGeometry.test.js";
import { runSymbolSourceTests } from "./symbolSources.test.js";
import { runImportedRouteTests } from "./importedRoutes.test.js";
import { runWireDragTests } from "./wireDrag.test.js";
import { runNetTerminalRoundTripTests } from "./netTerminalRoundTrip.test.js";
import { runTextBoxTests, runSheetShapeTests } from "./textBox.test.js";
import { runExpressionTests } from "../../simulation/regression/expression.test.js";
import { runPlotSettingsTests } from "../../simulation/regression/plotSettings.test.js";
import { runProbeSelectionTests } from "../../simulation/regression/probeSelection.test.js";
import { runTerminalCurrentTests } from "../../simulation/regression/terminalCurrent.test.js";
import { runCurrentMeasureTests } from "../../simulation/regression/currentMeasure.test.js";
import { runDcSweepTests } from "../../simulation/regression/dcSweep.test.js";
import { runModelTests } from "../../simulation/regression/models.test.js";
import { runConvertedNetlistTests } from "../../simulation/regression/convertedNetlist.test.js";

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
    { name: "DC sweep + .step", ...runDcSweepTests() },
    // Runs every shipped .model through ngspice — a wrong-class parameter kills it.
    { name: "Shipped device models", ...(await runModelTests()) },
    { name: "Probe selection", ...runProbeSelectionTests() },
    { name: "Current measurements", ...runCurrentMeasureTests() },
    { name: "Terminal currents", ...runTerminalCurrentTests() },
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
    { name: "Wire connector", ...runWireConnectorTests() },
    // Reads every examples/*.asc, saves it to a temp file and re-reads it.
    { name: "ASC examples round-trip", ...(await runAscExamplesTests()) },
    // Compares the saved *text* against the source file, not just the circuit.
    { name: "ASC file fidelity", ...(await runAscFidelityTests()) },
    // Rotating a two-pin part re-seats its wires and reverses its node order.
    { name: "Pin re-seating on rotate", ...(await runPinReseatTests()) },
    // Cut/copy/paste of a selection as a .asc fragment, incl. across schematics.
    { name: "Clipboard fragments", ...(await runClipboardTests()) },
    // Proves net anchors carry what the net-label nodes carry (Phase B).
    { name: "Net anchors", ...(await runNetAnchorTests()) },
    { name: "Multisim 14 files", ...(await runMs14Tests()) },
    { name: "Converted netlists", ...(await runConvertedNetlistTests()) },
    { name: "PWL source", ...runPwlSourceTests() },
    { name: "Pulse source", ...(await runPulseSourceTests()) },
    { name: "Logic gates", ...runLogicGateTests() },
    { name: "D flip-flop", ...runDFlipFlopTests() },
    { name: "Digital part geometry", ...runDigitalGeometryTests() },
    { name: "Symbol sources", ...(await runSymbolSourceTests()) },
    { name: "Imported wire routes", ...runImportedRouteTests() },
    // Grabbing a point of a drawn wire and moving it (see wireDrag.ts).
    { name: "Wire correction by hand", ...runWireDragTests() },
    { name: "Net terminal round-trip", ...(await runNetTerminalRoundTripTests()) },
    { name: "Text boxes", ...(await runTextBoxTests()) },
    { name: "Sheet shapes", ...(await runSheetShapeTests()) },
    // Share links/QR codes decompress asynchronously.
    { name: "Share links", ...(await runShareLinkTests()) },
  ];
}
