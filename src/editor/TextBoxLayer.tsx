import { useRef } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { renderMarkdown } from "./markdown.js";
import { TEXT_SIZE_DEFAULT, TEXTBOX_MIN_W, textScale, textFlow, type TextBox } from "@core/circuit/textBox.js";
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
 * It now follows its text in both directions: as wide as the longest line, as
 * tall as the line count, breaking only where Return was typed. That is what
 * LTSpice does, and all its file format can express — see `textBox`. A width the
 * user sets by hand overrides it, and then the text wraps into that width.
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
  // In the UI store, not local: a box that was just placed on the canvas arrives
  // with its editor already open (see SchematicCanvas.placeTextBox).
  const editing = useUIStore((s) => s.editingTextBoxId);
  const setEditing = useUIStore((s) => s.setEditingTextBoxId);

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
        // A box that follows its text takes the width of its longest line and
        // breaks nowhere else — LTSpice's behaviour, and the only one its file
        // format can carry (see textBox). A hand-set width still wraps: there
        // the width is the answer the user gave, and the text flows into it.
        const auto = !!box.autoSized && !box.markdown;
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
              // it into screen size. The height is whatever the text needs. An
              // auto box asks the browser instead — `max-content` is the longest
              // line measured for real, rather than our own estimate of it.
              width: auto ? "max-content" : box.width,
              minWidth: auto ? TEXTBOX_MIN_W : undefined,
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
                // No soft wrapping while typing an auto box: a line ends where
                // Return says it does, and the field grows with it. Wrapping
                // here would show a break the saved file cannot reproduce.
                wrap={auto ? "off" : "soft"}
                style={{
                  display: "block", resize: "none",
                  // The measured width (kept current by the store on every
                  // keystroke), with room for the caret past the last glyph.
                  width: auto ? box.width + fontSize : "100%",
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
                  // An auto box breaks only where the text does (`pre`); a
                  // hand-set width wraps long lines and breaks a word that is
                  // longer than the box, so narrowing reflows instead of
                  // clipping.
                  whiteSpace: auto ? "pre" : box.markdown ? "normal" : "pre-wrap",
                  overflowWrap: auto ? "normal" : "break-word",
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
