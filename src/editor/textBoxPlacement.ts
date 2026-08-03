import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { snapToGrid } from "./pinGeometry.js";

/**
 * Put a note down where the user aimed, and open it for typing right away — an
 * empty box is never what was wanted, the text is. Snapped like everything else
 * on the sheet, so notes line up with the parts they describe.
 *
 * Placing ends here rather than staying armed (unlike a part, which is often
 * placed several times in a row): the next thing after dropping a note is
 * always writing in it.
 *
 * A module of its own, small as it is, because both commit paths in
 * `SchematicCanvas` (the mouse's pane click and the touch/pen pointer-up) and
 * the regression suite have to be running the same code — a test that re-derived
 * this would pass no matter what the canvas did.
 *
 * @param cx flow-coordinate x the pointer aimed at
 * @param cy flow-coordinate y the pointer aimed at
 * @returns the new box's id
 */
export function placeTextBoxAt(cx: number, cy: number): string {
  const id = useCircuitStore.getState().addTextBox(snapToGrid(cx), snapToGrid(cy));
  const ui = useUIStore.getState();
  ui.cancelPlacing();
  ui.setSelectedTextBoxId(id);
  ui.setEditingTextBoxId(id);
  return id;
}
