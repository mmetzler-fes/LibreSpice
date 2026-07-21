import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";
import { dashArray } from "@core/circuit/sheetShape.js";

/**
 * Frames, dividers and rings drawn on the sheet — LTSpice's `RECTANGLE`, `LINE`
 * and `CIRCLE`. Annotation only: they carry no connection and never reach the
 * netlist, so they are drawn beneath everything and take no pointer events.
 *
 * One SVG spanning the viewport, transformed like the canvas, so a shape keeps
 * its place on the sheet while the view pans and zooms.
 */
export function SheetShapeLayer() {
  const vp = useViewport();
  const shapes = useCircuitStore((s) => s.sheetShapes);
  const theme = useTheme();
  if (shapes.length === 0) return null;

  return (
    <svg
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "visible" }}
    >
      <g transform={`translate(${vp.x} ${vp.y}) scale(${vp.zoom})`}>
        {shapes.map((s) => {
          const common = {
            fill: "none",
            stroke: theme.border,
            strokeWidth: 1.5,
            strokeDasharray: dashArray(s.dash),
          };
          if (s.kind === "line") {
            return <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...common} />;
          }
          const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
          const w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
          if (s.kind === "circle") {
            return <ellipse key={s.id} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
          }
          return <rect key={s.id} x={x} y={y} width={w} height={h} {...common} />;
        })}
      </g>
    </svg>
  );
}
