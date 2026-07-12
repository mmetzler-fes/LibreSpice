import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "../Toolbar.js";
import { useUIStore } from "@store/uiStore.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { createSpiceComponent, nextComponentId } from "../componentFactory.js";
import { NODE_SIZE, snapToGrid } from "../pinGeometry.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The toolbar's placement buttons. Ground sits with the sources — a source needs a
 * reference node, and that is where the eye looks for it. The pan button is gone:
 * dragging empty canvas already pans in select mode, and the lock covers "navigate
 * without touching anything", so it was a third way to do what those two do (and
 * its tooltip even promised a Space shortcut that never existed).
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** Every button in the rendered toolbar, in DOM order, by its title. */
function toolbarButtons(): string[] {
  const html = renderToStaticMarkup(createElement(Toolbar));
  return [...html.matchAll(/<button[^>]*title="([^"]*)"/g)].map((m) => m[1]);
}

const CASES: Case[] = [
  { name: "the toolbar renders and has no pan button", run: (fail) => {
    const titles = toolbarButtons();
    if (titles.length === 0) { fail("the toolbar rendered no buttons at all"); return; }
    const pan = titles.find((t) => /\bpan\b/i.test(t));
    if (pan) fail(`the pan button is still there: "${pan}"`);
  } },

  { name: "ground sits to the right of the sources", run: (fail) => {
    const titles = toolbarButtons();
    const at = (re: RegExp) => titles.findIndex((t) => re.test(t));
    const v = at(/voltage source/i);
    const i = at(/current source/i);
    const g = at(/ground/i);
    if (v < 0 || i < 0 || g < 0) { fail(`missing button — V:${v} I:${i} GND:${g} of ${titles.join(" | ")}`); return; }
    if (!(g > v && g > i)) fail(`ground is at ${g}, not right of the sources (V:${v}, I:${i})`);
  } },

  { name: "the ground button places a ground that carries the reference node", run: (fail) => {
    // The functional half: what the button triggers (startPlacing → placeComponent)
    // must yield a ground part whose single pin is the reference node "0".
    useUIStore.getState().startPlacing("ground");
    if (useUIStore.getState().pendingPlaceType !== "ground") {
      fail(`the button's action left pendingPlaceType at ${useUIStore.getState().pendingPlaceType}`);
      return;
    }

    // …and placing it, exactly as the canvas does on the following click.
    const circuit = useCircuitStore.getState();
    circuit.clearCircuit();
    const id = nextComponentId("ground", []);
    const x = snapToGrid(100) - NODE_SIZE / 2, y = snapToGrid(100) - NODE_SIZE / 2;
    const comp = createSpiceComponent("ground", id, "0", x, y);
    circuit.addComponent(comp, { id, type: "component", position: { x, y }, data: { componentType: "ground", label: "0" } });
    useCircuitStore.getState().rebuildConnections();

    const placed = useCircuitStore.getState().circuit.components.get(id);
    if (!placed) { fail("no ground component in the circuit"); return; }
    if (placed.ports.length !== 1) fail(`${placed.ports.length} ports != 1`);
    if (placed.ports[0]?.netId !== "0") fail(`the ground pin is on net ${placed.ports[0]?.netId}, not on "0"`);
    if (placed.getNetlistLine() !== "") fail("ground must not emit a device line");
    useUIStore.getState().cancelPlacing();
  } },
];

export function runToolbarTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}
