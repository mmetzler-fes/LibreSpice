import { renderToStaticMarkup } from "react-dom/server";
import type { Node, Edge } from "@xyflow/react";
import { symbolForType, symbolBounds, type SymbolNorm } from "@sym/asyParser.js";
import { AsyGeometry, mapSymbol } from "@sym/AsySymbol.js";
import { NODE_SIZE, GRID, getNodePins } from "./pinGeometry.js";
import { netLabelShape } from "./netLabelShape.js";
import { orthoVertices, pointAtT, type ArrowDir, type FlowPoint, type WireData } from "./WireTool.js";
import { wireConnectorShape, wireNameTag } from "./wireLabelShape.js";
import { captionSvgPlacement, DEFAULT_HALF, LABEL_FONT_SIZE, VALUE_FONT_SIZE } from "./captionLayout.js";
import {
  DIRECTIVE_BORDER, DIRECTIVE_FONT_FAMILY, DIRECTIVE_FONT_SIZE, DIRECTIVE_RADIUS,
  directiveBoxGeometry, type DirectiveBoxGeometry,
} from "./directiveBoxLayout.js";
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

/**
 * Center-anchored orientation transform for an inner symbol. SVG applies the
 * list left-to-right as outermost-first, so the rotate is written *before* the
 * mirror to make the mirror happen first — LTSpice's `M<deg>` order, matching
 * the editor node and getLocalPins.
 */
function transformFor(rotation: number, mirrored: boolean, cx: number, cy: number): string | undefined {
  const parts: string[] = [];
  if (rotation) parts.push(`rotate(${rotation} ${cx} ${cy})`);
  if (mirrored) parts.push(`translate(${2 * cx} 0) scale(-1 1)`);
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

  if (type === "netlabel") {
    // Port connector: hollow terminal circle + direction arrow + name tag,
    // matching the editor's NetLabelNode (see netLabelShape).
    const name = data.label || "NET";
    const shape = netLabelShape(rotation);
    const th = 16;
    const tagW = Math.max(20, name.length * 6.8 + 12);
    const rectX = shape.tag.anchor === "start" ? shape.tag.x : shape.tag.x - tagW / 2;
    const rectY = shape.tag.baseline === "middle" ? shape.tag.y - th / 2 : shape.tag.y - th;
    const textX = shape.tag.anchor === "start" ? rectX + 6 : shape.tag.x;
    const isConnector = !!data.connector;
    return (
      <g transform={`translate(${x} ${y})`}>
        {isConnector && (
          <>
            <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2} stroke="#334155" strokeWidth={1.6} strokeLinecap="round" />
            <polygon points={shape.head} fill="#334155" />
          </>
        )}
        <circle cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r} fill="#ffffff" stroke="#2563eb" strokeWidth={2} />
        <rect x={rectX} y={rectY} width={tagW} height={th} rx={4} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={1} />
        <text x={textX} y={rectY + th / 2 + 3.5} fontSize={11} fontFamily="monospace" fill="#0f172a" textAnchor={shape.tag.anchor}>{name}</text>
      </g>
    );
  }

  const sym = symbolForType(type, norm);
  // Native-scale mapping (margin 0, grid-snapped) — identical to the editor node
  // and to getNodePins, so the drawn symbol lands exactly on its pins (and thus
  // on the wire endpoints). A fit-to-box mapping would shrink/offset it.
  const mapping = sym ? mapSymbol(sym, NODE_SIZE, 0, GRID, true) : null;
  // Drawn half-extents in px, matching the editor, so captions hug the shape and
  // the user's dragged offset lands identically.
  const halfW = sym ? (symbolBounds(sym).width / 2) * mapping!.scale : DEFAULT_HALF.w;
  const halfH = sym ? (symbolBounds(sym).height / 2) * mapping!.scale : DEFAULT_HALF.h;

  const inner = sym ? (
    <g transform={transformFor(rotation, mirrored, NODE_SIZE / 2, NODE_SIZE / 2)}>
      <AsyGeometry sym={sym} mapping={mapping!} strokeWidth={1.6} />
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
  // Font sizes must match the editor's caption styles — the placement depends on
  // them (the line box is CAPTION_LINE_HEIGHT × fontSize).
  const labelPos = captionSvgPlacement("label", rotation, halfW, halfH, LABEL_FONT_SIZE, data.labelOffset);
  const valuePos = captionSvgPlacement("value", rotation, halfW, halfH, VALUE_FONT_SIZE, data.valueOffset);
  return (
    <g transform={`translate(${x} ${y})`} color="#0f172a">
      {inner}
      {showCaption && (
        <text x={labelPos.x} y={labelPos.y} textAnchor={labelPos.textAnchor} dominantBaseline={labelPos.baseline} fontSize={LABEL_FONT_SIZE} fontFamily="monospace" fill="#374151">{data.label}</text>
      )}
      {showCaption && data.valueLabel && (
        <text x={valuePos.x} y={valuePos.y} textAnchor={valuePos.textAnchor} dominantBaseline={valuePos.baseline} fontSize={VALUE_FONT_SIZE} fontFamily="monospace" fill="#6b7280">{data.valueLabel}</text>
      )}
    </g>
  );
}

/**
 * The on-schematic SPICE directive box ("Display in circuit"), at the position
 * the user dragged it to. Colours follow the editor's light theme, since the
 * export is always drawn on white.
 */
function DirectiveTextBox({ box }: { box: DirectiveBoxGeometry }) {
  return (
    // Named so the box can be selected as a unit in a vector editor.
    <g className="spice-directives">
      <rect
        x={box.x} y={box.y} width={box.width} height={box.height} rx={DIRECTIVE_RADIUS}
        fill="#ffffff" stroke="#94a3b8" strokeWidth={DIRECTIVE_BORDER}
      />
      {box.lines.map((l, i) => (
        <text
          key={i} x={l.x} y={l.y} dominantBaseline="central"
          fontSize={DIRECTIVE_FONT_SIZE} fontFamily={DIRECTIVE_FONT_FAMILY}
          // Directives are indentation-sensitive to read; keep leading spaces.
          xmlSpace="preserve"
          fill={l.comment ? "#64748b" : "#1e293b"}
        >
          {l.text}
        </text>
      ))}
    </g>
  );
}

/** The on-canvas directive box, when the user enabled "Display in circuit". */
export interface DirectiveOverlay {
  text: string;
  pos: { x: number; y: number };
}

/** Serialise the current schematic to a standalone SVG string. */
/**
 * The bit of the circuit model needed to resolve a wire's net name. A wire
 * stores only *whether* to show a label, never the text: the name is derived
 * from the wire's source port → its net → the net's `nodeLabel` (see WireEdge).
 * Structural, not a `Circuit` import, so the regression suite can pass a stub.
 */
export interface NetNameLookup {
  components: Map<string, { ports: { id: string; netId?: string | null }[] }>;
  nets: Map<string, { nodeLabel?: string }>;
}

/** A wire's on-screen labels, resolved and positioned (see wireLabelShape). */
interface WireLabels {
  netLabel: string | null;
  connName: string | null;
  connector: boolean;
  arrowDir: ArrowDir;
  dock: FlowPoint;
  anchor: FlowPoint;
  showBox: boolean;
}

/**
 * Resolve what a wire displays, mirroring WireEdge's rules — minus `selected`,
 * which has no meaning in an export: the net-name box shows when `showLabel` is
 * on, or when a connector carries a *different* name (so both stay readable).
 */
function wireLabelsFor(edge: Edge, verts: FlowPoint[], circuit?: NetNameLookup): WireLabels | null {
  const data = edge.data as WireData | undefined;
  const showLabel = !!data?.showLabel;
  const connector = !!data?.connector;
  if (!circuit || verts.length === 0 || (!showLabel && !connector)) return null;

  const port = circuit.components.get(edge.source)?.ports.find((p) => p.id === `${edge.source}-${edge.sourceHandle}`);
  const netId = port?.netId ?? null;
  const netLabel = netId ? (circuit.nets.get(netId)?.nodeLabel ?? netId) : null;
  const connectorLabel = (data?.connectorLabel as string | undefined)?.trim() || undefined;
  const connName = connector ? (connectorLabel ?? netLabel) : null;
  const connDiffers = !!(connector && connectorLabel && connectorLabel !== netLabel);

  const labelT = typeof data?.labelT === "number" ? data.labelT : 0.5;
  const off = (data?.labelOffset as FlowPoint | undefined) ?? { x: 0, y: 0 };
  const dock = pointAtT(verts, labelT);
  return {
    netLabel, connName, connector,
    arrowDir: (data?.arrowDir as ArrowDir | undefined) ?? "right",
    dock,
    anchor: { x: dock.x + off.x, y: dock.y + off.y },
    showBox: !!netLabel && (showLabel || connDiffers),
  };
}

export function buildSchematicSvg(
  nodes: Node[],
  edges: Edge[],
  norm: SymbolNorm,
  directives?: DirectiveOverlay,
  circuit?: NetNameLookup,
): string {
  const directiveBox = directives?.text.trim() ? directiveBoxGeometry(directives.text, directives.pos) : null;

  // Pin lookup for drawing wires.
  const pinMap = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    for (const p of getNodePins(node, norm)) pinMap.set(`${p.nodeId}-${p.handleId}`, { x: p.x, y: p.y });
  }

  // Route every wire first (endpoints + stored waypoints/taps, expanded to right
  // angles exactly like the editor's WireEdge) so the exported wire matches what's
  // on screen — and so the bounding box can include every vertex.
  const wireVerts: FlowPoint[][] = [];
  for (const e of edges) {
    const data = e.data as WireData | undefined;
    // A wire that taps an existing wire draws to its junction point, otherwise to
    // the true pin centre.
    const a = data?.sourceTap ?? (e.source && e.sourceHandle ? pinMap.get(`${e.source}-${e.sourceHandle}`) : undefined);
    const b = data?.targetTap ?? (e.target && e.targetHandle ? pinMap.get(`${e.target}-${e.targetHandle}`) : undefined);
    if (!a || !b) { wireVerts.push([]); continue; }
    const waypoints = data?.waypoints ?? [];
    wireVerts.push(orthoVertices([a as FlowPoint, ...waypoints, b as FlowPoint]));
  }

  // Labels the wires carry (net name / connector). Resolved before the bounding
  // box, since a connector's arrow and name box stick well clear of the wire.
  const wireLabels = edges.map((e, i) => wireLabelsFor(e, wireVerts[i], circuit));

  // Bounding box over symbols, pins and every wire vertex (so a hand-routed
  // waypoint outside the component boxes is never clipped).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of nodes) { grow(n.position.x, n.position.y); grow(n.position.x + NODE_SIZE, n.position.y + NODE_SIZE); }
  for (const { x, y } of pinMap.values()) grow(x, y);
  for (const verts of wireVerts) for (const p of verts) grow(p.x, p.y);
  // A connector's arrow + name box reach ~50px past the wire, and a dragged net
  // name sits above its anchor: without these the labels get clipped at the edge.
  for (const l of wireLabels) {
    if (!l) continue;
    if (l.connector) {
      const s = wireConnectorShape(l.dock, l.arrowDir, l.connName ?? "");
      grow(s.tag.x, s.tag.y);
      grow(s.tag.x + s.tag.width, s.tag.y + s.tag.height);
    }
    if (l.showBox && l.netLabel) {
      const t = wireNameTag(l.anchor, l.netLabel);
      grow(t.x, t.y);
      grow(t.x + t.width, t.y + t.height);
    }
  }
  // The directive box is usually dragged clear of the parts, so it drives the
  // bounds as much as they do.
  if (directiveBox) {
    grow(directiveBox.x, directiveBox.y);
    grow(directiveBox.x + directiveBox.width, directiveBox.y + directiveBox.height);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = NODE_SIZE; maxY = NODE_SIZE; }
  const pad = 24;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = Math.round(maxX - minX);
  const height = Math.round(maxY - minY);

  const wires = wireVerts.map((verts, i) =>
    verts.length === 0 ? null : (
      <polyline key={`w${i}`} points={verts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#1e293b" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    ),
  );

  // Wire labels are drawn over the wires but under the symbols, exactly as the
  // editor stacks them (edges render below nodes in React Flow).
  const labels = wireLabels.map((l, i) => {
    if (!l) return null;
    const s = l.connector ? wireConnectorShape(l.dock, l.arrowDir, l.connName ?? "") : null;
    const t = l.showBox && l.netLabel ? wireNameTag(l.anchor, l.netLabel) : null;
    return (
      <g key={`wl${i}`}>
        {s && (
          <>
            <circle cx={s.circle.cx} cy={s.circle.cy} r={s.circle.r} fill="none" stroke="#334155" strokeWidth={1.4} opacity={0.7} />
            <line x1={s.stem.x1} y1={s.stem.y1} x2={s.stem.x2} y2={s.stem.y2} stroke="#334155" strokeWidth={1.6} strokeLinecap="round" />
            <polygon points={s.head} fill="#334155" />
            {l.connName && (
              <>
                <rect x={s.tag.x} y={s.tag.y} width={s.tag.width} height={s.tag.height} rx={3} fill="#475569" />
                <text x={s.tag.textX} y={s.tag.textY} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#fff">{l.connName}</text>
              </>
            )}
          </>
        )}
        {t && (
          <>
            <rect x={t.x} y={t.y} width={t.width} height={t.height} rx={3} fill="#2563eb" />
            <text x={t.textX} y={t.textY} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#fff">{l.netLabel}</text>
          </>
        )}
      </g>
    );
  });

  const svg = (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`${minX} ${minY} ${width} ${height}`}>
      <rect x={minX} y={minY} width={width} height={height} fill="#ffffff" />
      {wires}
      {labels}
      {nodes.map((n) => <SymbolNode key={n.id} node={n} norm={norm} />)}
      {directiveBox && <DirectiveTextBox box={directiveBox} />}
    </svg>
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(svg)}`;
}
