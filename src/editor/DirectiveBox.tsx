import { useRef } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "./pointerDrag.js";
import {
  DIRECTIVE_BORDER, DIRECTIVE_FONT_FAMILY, DIRECTIVE_FONT_SIZE, DIRECTIVE_LINE_HEIGHT,
  DIRECTIVE_PADDING_X, DIRECTIVE_PADDING_Y, DIRECTIVE_RADIUS, directiveLines, isDirectiveComment,
} from "./directiveBoxLayout.js";

/**
 * LTSpice-style on-schematic SPICE directive text box. Shown when "Display in
 * circuit" is enabled in the SPICE Directives dialog; draggable, positioned in
 * flow coordinates so it pans/zooms with the sheet. Double-click opens the
 * dialog to edit.
 */
export function DirectiveBox() {
  const vp = useViewport();
  const show = useCircuitStore((s) => s.showDirectivesOnCanvas);
  const directives = useCircuitStore((s) => s.spiceDirectives);
  const pos = useCircuitStore((s) => s.directivesPos);
  const moveBox = useCircuitStore((s) => s.moveDirectivesBox);
  const toggleDirectiveModal = useUIStore((s) => s.toggleDirectiveModal);
  const theme = useTheme();

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; zoom: number } | null>(null);

  if (!show || !directives.trim()) return null;

  const startDrag = (e: React.PointerEvent) => {
    if (!isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, zoom: vp.zoom };
    trackPointerDrag(
      e,
      (ev) => {
        const d = drag.current;
        if (!d) return;
        moveBox(d.ox + (ev.clientX - d.sx) / d.zoom, d.oy + (ev.clientY - d.sy) / d.zoom);
      },
      () => { drag.current = null; },
    );
  };

  const left = vp.x + pos.x * vp.zoom;
  const top = vp.y + pos.y * vp.zoom;
  const lines = directiveLines(directives);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 6 }}>
      <div
        onPointerDown={startDrag}
        onDoubleClick={(e) => { e.stopPropagation(); toggleDirectiveModal(); }}
        title="SPICE directives — drag to move, double-click to edit"
        style={{
          ...DRAG_TOUCH_ACTION,
          position: "absolute", left, top,
          transformOrigin: "top left", transform: `scale(${vp.zoom})`,
          pointerEvents: "auto", cursor: "move", userSelect: "none",
          // Geometry is shared with the SVG export (see directiveBoxLayout).
          fontFamily: DIRECTIVE_FONT_FAMILY, fontSize: DIRECTIVE_FONT_SIZE,
          lineHeight: `${DIRECTIVE_LINE_HEIGHT}px`,
          padding: `${DIRECTIVE_PADDING_Y}px ${DIRECTIVE_PADDING_X}px`,
          borderRadius: DIRECTIVE_RADIUS, whiteSpace: "pre",
          color: theme.text,
          background: theme.directiveBg,
          border: `${DIRECTIVE_BORDER}px solid ${theme.directiveBorder}`,
        }}
      >
        {lines.map((l, i) => (
          <div key={i} style={{ color: isDirectiveComment(l) ? "#64748b" : undefined }}>{l || " "}</div>
        ))}
      </div>
    </div>
  );
}
