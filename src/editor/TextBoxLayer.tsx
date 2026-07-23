import { useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { renderMarkdown } from "./markdown.js";
import { TEXT_SIZE_DEFAULT, textScale, textFlow, type TextBox } from "@core/circuit/textBox.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "./pointerDrag.js";

/**
 * Free text annotations on the sheet.
 *
 * Just the text. A note on a schematic is read far more often than it is edited,
 * so it carries no chrome of its own: no title bar, no buttons, no frame. What
 * used to sit on that bar — the size, the reading direction, Markdown, delete —
 * is in the properties panel now, where every other object's settings are, and
 * appears when the box is selected.
 *
 * Nothing is ever cut off. The box used to be a fixed rectangle with its
 * overflow scrolled out of sight, which quietly hid the end of a long note — and
 * once a text could be set at seven times the base size, most of a short one too.
 * Its height now follows its content; the stored width is the width the text
 * wraps at, which is the part of the size a user chooses on purpose.
 *
 * Drawn in flow coordinates like the data flags, so a box stays put on the sheet
 * while the view pans and zooms. It is an annotation, not a part: it has no pins
 * and never reaches the netlist.
 */
export function TextBoxLayer() {
  const vp = useViewport();
  const boxes = useCircuitStore((s) => s.textBoxes);
  const update = useCircuitStore((s) => s.updateTextBox);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const selected = useUIStore((s) => s.selectedTextBoxId);
  const setSelected = useUIStore((s) => s.setSelectedTextBoxId);
  const theme = useTheme();
  const [editing, setEditing] = useState<string | null>(null);

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const startMove = (e: React.PointerEvent, box: TextBox) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(box.id);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y };
    trackPointerDrag(e, (ev) => {
      const d = drag.current;
      if (!d) return;
      update(box.id, { x: d.ox + (ev.clientX - d.sx) / vp.zoom, y: d.oy + (ev.clientY - d.sy) / vp.zoom });
    }, () => { drag.current = null; });
  };

  if (boxes.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {boxes.map((box) => {
        const isEditing = editing === box.id;
        const isSelected = selected === box.id;
        // The size index and the justification are the text's own (see textBox):
        // 1.5 is LTSpice's default and the size everything here has always been
        // drawn at, so a scale of 1 leaves every existing sheet untouched.
        const fontSize = 11 * textScale(box.size ?? TEXT_SIZE_DEFAULT);
        const flow = textFlow(box.justify ?? "Left");
        return (
          <div
            key={box.id}
            onPointerDown={(e) => startMove(e, box)}
            onDoubleClick={(e) => { e.stopPropagation(); if (!canvasLocked) setEditing(box.id); }}
            title={canvasLocked ? undefined : "Ziehen zum Verschieben, Doppelklick zum Bearbeiten"}
            style={{
              ...DRAG_TOUCH_ACTION,
              position: "absolute",
              left: vp.x + box.x * vp.zoom,
              top: vp.y + box.y * vp.zoom,
              // The width the text wraps at, in flow units; the scale below turns
              // it into screen size. The height is whatever the text needs.
              width: box.width,
              // One transform for the whole box: the text scales with the sheet
              // instead of staying at screen size, so a note keeps its place in
              // the drawing at every zoom level.
              transform: `scale(${vp.zoom})`,
              transformOrigin: "top left",
              pointerEvents: "auto",
              cursor: canvasLocked ? "default" : "move",
              // Selection is the only chrome there is, and only while selected:
              // an outline, which takes no space, so the text does not shift when
              // it appears.
              outline: isSelected || isEditing ? `1px dashed ${theme.accent}` : "none",
              outlineOffset: 2,
            }}
          >
            {isEditing ? (
              <textarea
                autoFocus
                value={box.text}
                onChange={(e) => update(box.id, { text: e.target.value })}
                onBlur={() => setEditing(null)}
                onPointerDown={(e) => e.stopPropagation()}
                // The canvas binds single keys (r rotates, Del deletes); without
                // this every keystroke would also drive the editor behind it.
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Text…"
                rows={Math.max(2, box.text.split("\n").length)}
                style={{
                  display: "block", width: "100%", resize: "none",
                  border: "none", outline: "none", background: theme.panelBg,
                  padding: 0, fontFamily: "monospace", fontSize, lineHeight: 1.45,
                  color: theme.textStrong,
                }}
              />
            ) : (
              <div
                style={{
                  fontSize, lineHeight: 1.45, color: theme.textStrong,
                  textAlign: flow.align,
                  // A `V…` justification sets the text on its side, read bottom to
                  // top — LTSpice's only other orientation.
                  ...(flow.vertical
                    ? { writingMode: "vertical-rl" as const, transform: "rotate(180deg)" }
                    : {}),
                  // Wrap long lines and break a word that is longer than the box,
                  // so widening and narrowing reflows instead of clipping.
                  whiteSpace: box.markdown ? "normal" : "pre-wrap",
                  overflowWrap: "break-word",
                  userSelect: "none",
                }}
              >
                {box.text.trim() === ""
                  ? <span style={{ color: "#94a3b8" }}>Doppelklick zum Bearbeiten</span>
                  : box.markdown ? renderMarkdown(box.text) : box.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
