/**
 * A shape drawn on the sheet — a frame around a sub-circuit, a divider, a ring
 * around the part under discussion. Annotation, like a text box: no pins, no
 * netlist line, no bearing on the simulation.
 *
 * LTSpice writes them as `RECTANGLE|LINE|CIRCLE <style> x1 y1 x2 y2 [dash]`,
 * where the trailing number picks a dash pattern. They used to be dropped on
 * import, so a file that carried one lost it on the next save.
 */
export interface SheetShape {
  id: string;
  kind: "rect" | "line" | "circle";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** LTSpice dash pattern: 0 solid, 1 dash, 2 dot, 3 dash-dot, 4 dash-dot-dot. */
  dash: number;
}

const KEYWORD: Record<SheetShape["kind"], string> = {
  rect: "RECTANGLE",
  line: "LINE",
  circle: "CIRCLE",
};
const KIND: Record<string, SheetShape["kind"]> = {
  RECTANGLE: "rect",
  LINE: "line",
  CIRCLE: "circle",
};

/** SVG `stroke-dasharray` for an LTSpice dash pattern, or undefined for solid. */
export function dashArray(dash: number): string | undefined {
  switch (dash) {
    case 1: return "8 4";
    case 2: return "2 4";
    case 3: return "8 4 2 4";
    case 4: return "8 4 2 4 2 4";
    default: return undefined;
  }
}

/** Parse one `.asc` shape line, or null if it is not one. */
export function parseSheetShape(line: string, id: string): SheetShape | null {
  const m = /^(RECTANGLE|LINE|CIRCLE)\s+\S+\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+(\d+))?/i.exec(line.trim());
  if (!m) return null;
  return {
    id,
    kind: KIND[m[1].toUpperCase()],
    x1: Number(m[2]), y1: Number(m[3]), x2: Number(m[4]), y2: Number(m[5]),
    dash: m[6] ? Number(m[6]) : 0,
  };
}

/** The `.asc` line for a shape. `Normal` is LTSpice's own default line weight. */
export function formatSheetShape(s: SheetShape): string {
  const dash = s.dash ? ` ${s.dash}` : "";
  return `${KEYWORD[s.kind]} Normal ${Math.round(s.x1)} ${Math.round(s.y1)} ${Math.round(s.x2)} ${Math.round(s.y2)}${dash}`;
}
