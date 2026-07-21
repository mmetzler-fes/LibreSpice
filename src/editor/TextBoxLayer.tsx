import { useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { renderMarkdown } from "./markdown.js";
import { TEXTBOX_MIN_W, TEXTBOX_MIN_H, type TextBox } from "@core/circuit/textBox.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "./pointerDrag.js";

/**
 * Free text annotations on the sheet.
 *
 * Two modes, as a note on a schematic wants: display mode renders Markdown,
 * edit mode shows the source in a plain textarea. Double-click enters editing,
 * clicking away leaves it — the same gesture as the captions elsewhere.
 *
 * Drawn in flow coordinates like the data flags, so a box stays put on the sheet
 * while the view pans and zooms. It is an annotation, not a part: it has no pins
 * and never reaches the netlist.
 */
export function TextBoxLayer() {
  const vp = useViewport();
  const boxes = useCircuitStore((s) => s.textBoxes);
  const update = useCircuitStore((s) => s.updateTextBox);
  const remove = useCircuitStore((s) => s.removeTextBox);
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const theme = useTheme();
  const [editing, setEditing] = useState<string | null>(null);

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const startMove = (e: React.PointerEvent, box: TextBox) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y };
    trackPointerDrag(e, (ev) => {
      const d = drag.current;
      if (!d) return;
      update(box.id, { x: d.ox + (ev.clientX - d.sx) / vp.zoom, y: d.oy + (ev.clientY - d.sy) / vp.zoom });
    }, () => { drag.current = null; });
  };

  const startResize = (e: React.PointerEvent, box: TextBox) => {
    if (canvasLocked || !isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, w0 = box.width, h0 = box.height;
    trackPointerDrag(e, (ev) => {
      update(box.id, {
        width: Math.max(TEXTBOX_MIN_W, w0 + (ev.clientX - sx) / vp.zoom),
        height: Math.max(TEXTBOX_MIN_H, h0 + (ev.clientY - sy) / vp.zoom),
      });
    });
  };

  if (boxes.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {boxes.map((box) => {
        const isEditing = editing === box.id;
        return (
          <div
            key={box.id}
            onDoubleClick={() => !canvasLocked && setEditing(box.id)}
            style={{
              position: "absolute",
              left: vp.x + box.x * vp.zoom,
              top: vp.y + box.y * vp.zoom,
              // Size in flow units; the scale below turns it into screen size.
              // Multiplying here as well would apply the zoom twice.
              width: box.width,
              height: box.height,
              // One transform for the whole box: the text scales with the sheet
              // instead of staying at screen size, so a note keeps its place in
              // the drawing at every zoom level.
              transform: `scale(${vp.zoom})`,
              transformOrigin: "top left",
              pointerEvents: "auto",
              display: "flex", flexDirection: "column",
              background: theme.panelBg,
              border: `1px solid ${isEditing ? "#2563eb" : theme.border}`,
              borderRadius: 4,
              boxShadow: "0 1px 3px #0000001f",
              overflow: "hidden",
            }}
          >
            {/* Title bar — the whole strip drags the box, not just the grip
                glyph: that is the part of a window one reaches for, and an 8 px
                target was easy to miss entirely. The buttons on it stop the
                gesture so pressing one does not also start a drag. */}
            <div
              onPointerDown={(e) => startMove(e, box)}
              title="Textfeld verschieben"
              style={{
                ...DRAG_TOUCH_ACTION,
                display: "flex", alignItems: "center", gap: 2, flexShrink: 0,
                padding: "1px 2px", background: theme.headerBg,
                borderBottom: `1px solid ${theme.borderMuted}`, fontSize: 10,
                cursor: "move", userSelect: "none",
              }}
            >
              <span style={{ color: "#94a3b8", padding: "0 3px", letterSpacing: -1 }}>
                ⠿
              </span>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => update(box.id, { markdown: !box.markdown })}
                title={box.markdown ? "Markdown wird ausgewertet — auf Rohtext umschalten" : "Rohtext — Markdown auswerten"}
                style={{
                  border: "none", background: "transparent", cursor: "pointer", fontSize: 10,
                  color: box.markdown ? "#2563eb" : "#94a3b8", fontWeight: box.markdown ? 600 : 400, padding: "0 3px",
                }}
              >
                MD
              </button>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setEditing(isEditing ? null : box.id)}
                title={isEditing ? "Bearbeiten beenden" : "Text bearbeiten (oder Doppelklick)"}
                style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 10, color: isEditing ? "#2563eb" : "#94a3b8", padding: "0 3px" }}
              >
                ✎
              </button>
              <span style={{ flex: 1 }} />
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => remove(box.id)}
                title="Textfeld entfernen"
                style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, color: "#94a3b8", padding: "0 3px" }}
              >
                ×
              </button>
            </div>

            {/* Body: source while editing, rendered otherwise. */}
            {isEditing ? (
              <textarea
                autoFocus
                value={box.text}
                onChange={(e) => update(box.id, { text: e.target.value })}
                onBlur={() => setEditing(null)}
                // The canvas binds single keys (r rotates, Del deletes); without
                // this every keystroke would also drive the editor behind it.
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Text… (Markdown mit MD)"
                style={{
                  flex: 1, resize: "none", border: "none", outline: "none",
                  padding: "4px 6px", fontFamily: "monospace", fontSize: 11, lineHeight: 1.45,
                  background: "transparent", color: theme.textStrong,
                }}
              />
            ) : (
              <div
                style={{
                  flex: 1, overflow: "auto", padding: "4px 6px",
                  fontSize: 11, lineHeight: 1.45, color: theme.textStrong,
                  // Wrap long lines and break a word that is longer than the box,
                  // so widening and narrowing reflows instead of clipping.
                  whiteSpace: box.markdown ? "normal" : "pre-wrap",
                  overflowWrap: "break-word",
                }}
              >
                {box.text.trim() === ""
                  ? <span style={{ color: "#94a3b8" }}>Doppelklick zum Bearbeiten</span>
                  : box.markdown ? renderMarkdown(box.text) : box.text}
              </div>
            )}

            {/* Resize grip, bottom-right. */}
            <div
              onPointerDown={(e) => startResize(e, box)}
              title="Größe ändern"
              style={{
                ...DRAG_TOUCH_ACTION,
                position: "absolute", right: 0, bottom: 0, width: 14, height: 14,
                cursor: "nwse-resize",
                background: `linear-gradient(135deg, transparent 50%, ${theme.border} 50%)`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
