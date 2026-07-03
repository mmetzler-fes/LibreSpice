import { renderToStaticMarkup } from "react-dom/server";
import type { Node, Edge } from "@xyflow/react";
import { symbolForType, type SymbolNorm } from "@sym/asyParser.js";
import { AsyGeometry, mapSymbol } from "@sym/AsySymbol.js";
import { NODE_SIZE, NODE_MARGIN, getNodePins } from "./pinGeometry.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import {
  ResistorSymbol, CapacitorSymbol, InductorSymbol, DiodeSymbol, LEDSymbol,
  BJTNPNSymbol, BJTPNPSymbol, MOSFETNSymbol,
  VoltageSourceSymbol, CurrentSourceSymbol, SineSourceSymbol, PulseSourceSymbol,
  GroundSymbol,
} from "./nodes/symbols/Symbols.js";

/** Hand-drawn fallback symbols (viewBox -40..40), for types without an .asy. */
const FALLBACK: Partial<Record<ComponentType, React.FC>> = {
  resistor: ResistorSymbol, capacitor: CapacitorSymbol, inductor: InductorSymbol,
  diode: DiodeSymbol, led: LEDSymbol, zener: DiodeSymbol, schottky: DiodeSymbol,
  bjt_npn: BJTNPNSymbol, bjt_pnp: BJTPNPSymbol, mosfet_n: MOSFETNSymbol, mosfet_p: MOSFETNSymbol,
  vsource: VoltageSourceSymbol, isource: CurrentSourceSymbol,
  sinesource: SineSourceSymbol, pulsesource: PulseSourceSymbol, ground: GroundSymbol,
};
const SOURCE_FALLBACK: Record<string, React.FC> = {
  DC: VoltageSourceSymbol, Sine: SineSourceSymbol, Pulse: PulseSourceSymbol,
};

/** Center-anchored rotate + horizontal-mirror transform for an inner symbol. */
function transformFor(rotation: number, mirrored: boolean, cx: number, cy: number): string | undefined {
  const parts: string[] = [];
  if (mirrored) parts.push(`translate(${2 * cx} 0) scale(-1 1)`);
  if (rotation) parts.push(`rotate(${rotation} ${cx} ${cy})`);
  return parts.length ? parts.join(" ") : undefined;
}

function SymbolNode({ node, norm }: { node: Node; norm: SymbolNorm }) {
  const data = node.data as ComponentNodeData;
  const type = data.componentType;
  const rotation = data.rotation ?? 0;
  const mirrored = !!data.mirrored;
  const { x, y } = node.position;

  if (type === "subcircuit") {
    return (
      <g transform={`translate(${x} ${y})`} color="#334155">
        <rect x={10} y={4} width={NODE_SIZE - 20} height={NODE_SIZE - 8} rx={4} fill="#f8fafc" stroke="currentColor" strokeWidth={1.6} />
        <text x={NODE_SIZE / 2} y={NODE_SIZE / 2 + 3} fontSize={11} fontWeight={600} textAnchor="middle" fill="currentColor">{data.subName ?? "X"}</text>
      </g>
    );
  }

  const sym = symbolForType(type, norm);
  const inner = sym ? (
    <g transform={transformFor(rotation, mirrored, NODE_SIZE / 2, NODE_SIZE / 2)}>
      <AsyGeometry sym={sym} mapping={mapSymbol(sym, NODE_SIZE, NODE_MARGIN)} strokeWidth={1.6} />
    </g>
  ) : (() => {
    const Fallback = type === "vsource"
      ? SOURCE_FALLBACK[data.sourceType ?? "DC"] ?? VoltageSourceSymbol
      : FALLBACK[type] ?? ResistorSymbol;
    // Fallback symbols draw in a -40..40 space centered at the origin.
    return (
      <g transform={`translate(${NODE_SIZE / 2} ${NODE_SIZE / 2}) ${transformFor(rotation, mirrored, 0, 0) ?? ""}`}>
        <Fallback />
      </g>
    );
  })();

  const showCaption = type !== "ground";
  return (
    <g transform={`translate(${x} ${y})`} color="#0f172a">
      {inner}
      {showCaption && (
        <text x={2} y={NODE_SIZE / 2 - 6} fontSize={11} fontFamily="monospace" fill="#374151" textAnchor="end">{data.label}</text>
      )}
      {showCaption && data.valueLabel && (
        <text x={2} y={NODE_SIZE / 2 + 9} fontSize={10} fontFamily="monospace" fill="#6b7280" textAnchor="end">{data.valueLabel}</text>
      )}
    </g>
  );
}

/** Serialise the current schematic to a standalone SVG string. */
export function buildSchematicSvg(nodes: Node[], edges: Edge[], norm: SymbolNorm): string {
  // Pin lookup for drawing wires.
  const pinMap = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    for (const p of getNodePins(node, norm)) pinMap.set(`${p.nodeId}-${p.handleId}`, { x: p.x, y: p.y });
  }

  // Bounding box over symbols and wire endpoints.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of nodes) { grow(n.position.x, n.position.y); grow(n.position.x + NODE_SIZE, n.position.y + NODE_SIZE); }
  for (const { x, y } of pinMap.values()) grow(x, y);
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = NODE_SIZE; maxY = NODE_SIZE; }
  const pad = 24;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = Math.round(maxX - minX);
  const height = Math.round(maxY - minY);

  const wires = edges.map((e, i) => {
    const a = e.source && e.sourceHandle ? pinMap.get(`${e.source}-${e.sourceHandle}`) : undefined;
    const b = e.target && e.targetHandle ? pinMap.get(`${e.target}-${e.targetHandle}`) : undefined;
    if (!a || !b) return null;
    // Orthogonal 2-segment route (horizontal then vertical), matching the editor.
    return <polyline key={`w${i}`} points={`${a.x},${a.y} ${b.x},${a.y} ${b.x},${b.y}`} fill="none" stroke="#1e293b" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />;
  });

  const svg = (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`${minX} ${minY} ${width} ${height}`}>
      <rect x={minX} y={minY} width={width} height={height} fill="#ffffff" />
      {wires}
      {nodes.map((n) => <SymbolNode key={n.id} node={n} norm={norm} />)}
    </svg>
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(svg)}`;
}
