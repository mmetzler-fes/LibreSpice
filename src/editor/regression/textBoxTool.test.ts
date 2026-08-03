import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "../Toolbar.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { placeTextBoxAt } from "../textBoxPlacement.js";
import { snapToGrid } from "../pinGeometry.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The text tool (the "T" in the toolbar): arm it, then click the sheet.
 *
 * It used to drop a box the moment the button was pressed, at a point derived
 * from the circuit's own top-left corner. On a panned or zoomed view that corner
 * is usually off screen, so the button looked broken — a box appeared somewhere
 * nobody was looking, and no amount of clicking the canvas produced one where
 * the user was aiming.
 *
 * Both commit paths in `SchematicCanvas` (the mouse's pane click, the touch/pen
 * pointer-up) go through {@link placeTextBoxAt}, which is what these cases drive
 * — the canvas only hands it the flow coordinate the pointer was over.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const ui = () => useUIStore.getState();
const st = () => useCircuitStore.getState();

/** A clean sheet with the tool disarmed, as every case wants to start. */
function reset() {
  st().clearCircuit();
  ui().cancelPlacing();
  ui().setSelectedTextBoxId(null);
  ui().setEditingTextBoxId(null);
}

/** Every button in the rendered toolbar, in DOM order, by its title. */
function toolbarButtons(): string[] {
  const html = renderToStaticMarkup(createElement(Toolbar));
  return [...html.matchAll(/<button[^>]*title="([^"]*)"/g)].map((m) => m[1]);
}

// Cursor positions deliberately off-grid, spread over the quadrants.
const CURSORS: [number, number][] = [[0, 0], [733, 511], [101, 99], [-57, 244], [1234.6, 87.2]];

const CASES: Case[] = [
  {
    name: "the toolbar offers the text button, and it asks for a click on the sheet",
    run: (fail) => {
      const titles = toolbarButtons();
      const t = titles.find((x) => /textfeld/i.test(x));
      if (!t) { fail(`no text button among ${titles.join(" | ")}`); return; }
      if (!/zeichenfl/i.test(t)) fail(`the button does not say where the note goes: "${t}"`);
    },
  },

  {
    // The whole bug: pressing the button used to *be* the placement.
    name: "pressing the button arms the tool and adds nothing yet",
    run: (fail) => {
      reset();
      ui().startPlacingTextBox();
      if (ui().editorMode !== "place") fail(`editorMode is ${ui().editorMode}, not "place"`);
      if (!ui().pendingTextBox) fail("the tool is not armed");
      if (st().textBoxes.length !== 0) fail(`${st().textBoxes.length} box(es) appeared before any click`);
    },
  },

  {
    name: "the click on the sheet puts the box where the pointer aimed",
    run: (fail) => {
      for (const [cx, cy] of CURSORS) {
        reset();
        ui().startPlacingTextBox();
        const id = placeTextBoxAt(cx, cy);
        const b = st().textBoxes.find((x) => x.id === id);
        if (!b) { fail(`no box for cursor (${cx}, ${cy})`); return; }
        if (b.x !== snapToGrid(cx) || b.y !== snapToGrid(cy)) {
          fail(`cursor (${cx}, ${cy}) → box at (${b.x}, ${b.y}), expected (${snapToGrid(cx)}, ${snapToGrid(cy)})`);
        }
      }
    },
  },

  {
    // The old placement read the parts' bounding box, so on a panned view the
    // note landed off screen. Parts far from the cursor must not pull it.
    name: "the aimed point wins over wherever the parts happen to be",
    run: (fail) => {
      reset();
      const far = { x: 5000, y: 5000 };
      st().addNetAnchor(far.x, far.y, "WEIT");
      ui().startPlacingTextBox();
      const id = placeTextBoxAt(120, 80);
      const b = st().textBoxes.find((x) => x.id === id);
      if (!b) { fail("no box was placed"); return; }
      if (b.x !== snapToGrid(120) || b.y !== snapToGrid(80)) {
        fail(`the box landed at (${b.x}, ${b.y}) instead of the aimed (${snapToGrid(120)}, ${snapToGrid(80)})`);
      }
    },
  },

  {
    // A part is often placed several times in a row; a note never is — what
    // follows dropping one is writing in it.
    name: "placing disarms the tool and opens the new box for typing",
    run: (fail) => {
      reset();
      ui().startPlacingTextBox();
      const id = placeTextBoxAt(64, 48);
      if (ui().pendingTextBox) fail("the tool stayed armed after the click");
      if (ui().editorMode !== "select") fail(`editorMode stayed at ${ui().editorMode}`);
      if (ui().selectedTextBoxId !== id) fail(`the new box is not selected (${ui().selectedTextBoxId})`);
      if (ui().editingTextBoxId !== id) fail(`the new box is not open for typing (${ui().editingTextBoxId})`);
      if (st().textBoxes.find((x) => x.id === id)?.text !== "") fail("a fresh note is not empty");
    },
  },

  {
    name: "Escape disarms the tool without leaving a box behind",
    run: (fail) => {
      reset();
      ui().startPlacingTextBox();
      // What the canvas' Escape handler does (see SchematicCanvas' keydown).
      ui().cancelPlacing();
      ui().setEditorMode("select");
      if (ui().pendingTextBox) fail("the tool is still armed");
      if (st().textBoxes.length !== 0) fail(`${st().textBoxes.length} box(es) were left behind`);
    },
  },

  {
    // One thing is being placed at a time: reaching for a part while the text
    // tool is armed must not leave the next click placing both.
    name: "the text tool and a part placement cancel one another",
    run: (fail) => {
      reset();
      ui().startPlacingTextBox();
      ui().startPlacing("resistor");
      if (ui().pendingTextBox) fail("the text tool survived a part placement");

      ui().startPlacingTextBox();
      if (ui().pendingPlaceType !== null) fail(`the part survived the text tool (${ui().pendingPlaceType})`);

      ui().setEditorMode("wire");
      if (ui().pendingTextBox) fail("the text tool survived the wire mode");
    },
  },

  {
    // The editor lives in the UI store now (the canvas has to open it on a
    // freshly placed box), so it has to be closed when the selection moves on —
    // an editor left open elsewhere would keep swallowing the keyboard.
    name: "selecting something else closes the open editor",
    run: (fail) => {
      reset();
      ui().startPlacingTextBox();
      const first = placeTextBoxAt(64, 48);
      ui().startPlacingTextBox();
      const second = placeTextBoxAt(200, 160);
      if (ui().editingTextBoxId !== second) fail("the second box did not take the editor");

      ui().setSelectedTextBoxId(first);
      if (ui().editingTextBoxId !== null) fail(`the editor stayed open on ${ui().editingTextBoxId}`);

      ui().setEditingTextBoxId(first);
      ui().setSelectedAnchorId("dummy");
      if (ui().editingTextBoxId !== null) fail("selecting a name left the text editor open");
      ui().setSelectedAnchorId(null);
    },
  },
];

export function runTextBoxToolTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
