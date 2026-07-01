import { type AsySymbol, type AsyPin, symbolBounds } from "./asyParser.js";

export interface MappedPin extends AsyPin {
  /** Pin position in the rendered NxN pixel box. */
  px: number;
  py: number;
}

export interface SymbolMapping {
  size: number;
  scale: number;
  /** Maps a symbol-space point into the NxN pixel box. */
  map: (x: number, y: number) => [number, number];
  pins: MappedPin[];
}

/**
 * Computes the transform that fits a symbol's geometry (and pins) into a square
 * pixel box of `size`, centered, leaving `margin` px on every side.
 */
export function mapSymbol(sym: AsySymbol, size: number, margin = 8): SymbolMapping {
  const b = symbolBounds(sym);
  const span = Math.max(b.width, b.height, 1);
  const scale = (size - 2 * margin) / span;
  const map = (x: number, y: number): [number, number] => [
    size / 2 + (x - b.cx) * scale,
    size / 2 + (y - b.cy) * scale,
  ];
  const pins = sym.pins.map((p) => {
    const [px, py] = map(p.x, p.y);
    return { ...p, px, py };
  });
  return { size, scale, map, pins };
}

function arcPoints(
  arc: AsySymbol["arcs"][number],
  map: (x: number, y: number) => [number, number],
): string {
  const cx = (arc.x1 + arc.x2) / 2;
  const cy = (arc.y1 + arc.y2) / 2;
  const rx = Math.abs(arc.x2 - arc.x1) / 2 || 0.001;
  const ry = Math.abs(arc.y2 - arc.y1) / 2 || 0.001;
  const a0 = Math.atan2((arc.sy - cy) / ry, (arc.sx - cx) / rx);
  let a1 = Math.atan2((arc.ey - cy) / ry, (arc.ex - cx) / rx);
  // LTSpice draws arcs visually counter-clockwise (decreasing angle with y-down).
  while (a1 > a0) a1 -= Math.PI * 2;
  const steps = Math.max(2, Math.ceil(Math.abs(a0 - a1) / (Math.PI / 16)));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const [px, py] = map(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return pts.join(" ");
}

interface AsyGeometryProps {
  sym: AsySymbol;
  mapping: SymbolMapping;
  strokeWidth?: number;
}

/** Renders the symbol's primitives (lines/rects/circles/arcs) as SVG. */
export function AsyGeometry({ sym, mapping, strokeWidth = 1.4 }: AsyGeometryProps) {
  const { map, scale } = mapping;
  const common = {
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <g>
      {sym.lines.map((l, i) => {
        const [x1, y1] = map(l.x1, l.y1);
        const [x2, y2] = map(l.x2, l.y2);
        return <line key={`l${i}`} x1={x1} y1={y1} x2={x2} y2={y2} {...common} />;
      })}
      {sym.rects.map((r, i) => {
        const [x1, y1] = map(r.x1, r.y1);
        const [x2, y2] = map(r.x2, r.y2);
        return (
          <rect
            key={`r${i}`}
            x={Math.min(x1, x2)}
            y={Math.min(y1, y2)}
            width={Math.abs(x2 - x1)}
            height={Math.abs(y2 - y1)}
            {...common}
          />
        );
      })}
      {sym.circles.map((c, i) => {
        const [cxp, cyp] = map((c.x1 + c.x2) / 2, (c.y1 + c.y2) / 2);
        return (
          <ellipse
            key={`c${i}`}
            cx={cxp}
            cy={cyp}
            rx={(Math.abs(c.x2 - c.x1) / 2) * scale}
            ry={(Math.abs(c.y2 - c.y1) / 2) * scale}
            {...common}
          />
        );
      })}
      {sym.arcs.map((a, i) => (
        <polyline key={`a${i}`} points={arcPoints(a, map)} {...common} />
      ))}
    </g>
  );
}

interface AsySymbolViewProps {
  sym: AsySymbol;
  size: number;
  margin?: number;
  strokeWidth?: number;
  color?: string;
}

/** Self-contained <svg> preview of a symbol — used by the palette. */
export function AsySymbolView({ sym, size, margin = 6, strokeWidth = 1.2, color }: AsySymbolViewProps) {
  const mapping = mapSymbol(sym, size, margin);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ color, display: "block" }}>
      <AsyGeometry sym={sym} mapping={mapping} strokeWidth={strokeWidth} />
    </svg>
  );
}
