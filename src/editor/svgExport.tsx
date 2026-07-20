import { renderToStaticMarkup } from "react-dom/server";
import type { Node, Edge } from "@xyflow/react";
import { symbolForType, symbolBounds, type SymbolNorm } from "@sym/asyParser.js";
import { AsyGeometry, mapSymbol } from "@sym/AsySymbol.js";
import { NODE_SIZE, GRID, getNodePins } from "./pinGeometry.js";
import { netLabelShape, tagBoxOrigin } from "./netLabelShape.js";
import { terminalDirection } from "./netTerminalOrientation.js";
import type { PortType } from "@core/components/special/Special.js";
import { orthoVertices, pointAtT, type FlowPoint, type WireData } from "./WireTool.js";
import { wireNameTag } from "./wireLabelShape.js";
import { captionSvgPlacement, DEFAULT_HALF, LABEL_FONT_SIZE, VALUE_FONT_SIZE } from "./captionLayout.js";
import {
  DIRECTIVE_BORDER, DIRECTIVE_FONT_FAMILY, DIRECTIVE_FONT_SIZE, DIRECTIVE_RADIUS,
  directiveBoxGeometry, type DirectiveBoxGeometry,
} from "./directiveBoxLayout.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import {
  ResistorSymbol, CapacitorSymbol, InductorSymbol, DiodeSymbol, LEDSymbol,
  BJTNPNSymbol, BJTPNPSymbol, MOSFETNSymbol,
  VoltageSourceSymbol, CurrentSourceSymbol, SineSourceSymbol, PulseSourceSymbol, PWLSourceSymbol,
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
  PWL: PWLSourceSymbol,
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

function SymbolNode({ node, norm, dir }: { node: Node; norm: SymbolNorm; dir?: FlowPoint }) {
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

  if (type === "netlabel" || type === "netconnector") {
    // Net label / net connector: hollow terminal circle, the direction arrow for
    // the port type, and the name tag — matching the editor's NetTerminalNode
    // (see netLabelShape), including the tag's user-dragged offset and the tint
    // that tells a connector apart from a plain label.
    const isConnector = type === "netconnector";
    const name = data.label || (isConnector ? "PORT" : "NET");
    const portType: PortType = isConnector ? (data.portType as PortType) ?? "BiDir" : "None";
    const shape = netLabelShape(portType, dir);
    const th = 16;
    const tagW = Math.max(20, name.length * 6.8 + 12);
    const off = data.labelOffset ?? { x: 0, y: 0 };
    const origin = tagBoxOrigin(shape.tag, tagW, th);
    const rectX = origin.x + off.x, rectY = origin.y + off.y;
    return (
      <g transform={`translate(${x} ${y})`}>
        {shape.stem && (
          <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2} stroke="#334155" strokeWidth={1.6} strokeLinecap="round" />
        )}
        {shape.heads.map((points, i) => <polygon key={i} points={points} fill="#334155" />)}
        <circle cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r} fill="#ffffff" stroke="#2563eb" strokeWidth={2} />
        <rect x={rectX} y={rectY} width={tagW} height={th} rx={4} fill={isConnector ? "#fde9c8" : "#e2e8f0"} stroke="#94a3b8" strokeWidth={1} />
        <text x={rectX + tagW / 2} y={rectY + th / 2 + 3.5} fontSize={11} fontFamily="monospace" fill="#0f172a" textAnchor="middle">{name}</text>
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

/** A wire's on-screen net-name tag, resolved and positioned (see wireLabelShape). */
interface WireLabels {
  netLabel: string;
  anchor: FlowPoint;
}

/**
 * Resolve the name a wire displays, mirroring WireEdge's rules — minus
 * `selected`, which has no meaning in an export, so the tag shows exactly when
 * `showLabel` is on.
 */
function wireLabelsFor(edge: Edge, verts: FlowPoint[], circuit?: NetNameLookup): WireLabels | null {
  const data = edge.data as WireData | undefined;
  if (!circuit || verts.length === 0 || !data?.showLabel) return null;

  const port = circuit.components.get(edge.source)?.ports.find((p) => p.id === `${edge.source}-${edge.sourceHandle}`);
  const netId = port?.netId ?? null;
  const netLabel = netId ? (circuit.nets.get(netId)?.nodeLabel ?? netId) : null;
  if (!netLabel) return null;

  const labelT = typeof data.labelT === "number" ? data.labelT : 0.5;
  const off = (data.labelOffset as FlowPoint | undefined) ?? { x: 0, y: 0 };
  const dock = pointAtT(verts, labelT);
  return { netLabel, anchor: { x: dock.x + off.x, y: dock.y + off.y } };
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

  // The net names the wires carry. Resolved before the bounding box, since a
  // dragged name tag sits clear of the wire itself.
  const wireLabels = edges.map((e, i) => wireLabelsFor(e, wireVerts[i], circuit));

  // Bounding box over symbols, pins and every wire vertex (so a hand-routed
  // waypoint outside the component boxes is never clipped).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of nodes) { grow(n.position.x, n.position.y); grow(n.position.x + NODE_SIZE, n.position.y + NODE_SIZE); }
  for (const { x, y } of pinMap.values()) grow(x, y);
  for (const verts of wireVerts) for (const p of verts) grow(p.x, p.y);
  // A dragged net name sits above its anchor: without this it gets clipped at
  // the edge of the sheet.
  for (const l of wireLabels) {
    if (!l) continue;
    const t = wireNameTag(l.anchor, l.netLabel);
    grow(t.x, t.y);
    grow(t.x + t.width, t.y + t.height);
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
    const t = wireNameTag(l.anchor, l.netLabel);
    return (
      <g key={`wl${i}`}>
        <rect x={t.x} y={t.y} width={t.width} height={t.height} rx={3} fill="#2563eb" />
        <text x={t.textX} y={t.textY} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#fff">{l.netLabel}</text>
      </g>
    );
  });

  // Which way each net terminal faces, from the wire attached to its dock — the
  // same rule the editor node applies (see terminalDirection), so the exported
  // sheet is laid out exactly like the one on screen.
  const termDirs = new Map<string, FlowPoint>();
  for (const n of nodes) {
    const t = (n.data as ComponentNodeData).componentType;
    if (t !== "netlabel" && t !== "netconnector") continue;
    const dock = { x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 };
    const farEnds: FlowPoint[] = [];
    for (const e of edges) {
      const atSource = e.source === n.id;
      if (!atSource && e.target !== n.id) continue;
      const wps = ((e.data as WireData | undefined)?.waypoints ?? []);
      // Waypoints run source → target, so walk them from this terminal's end.
      const first = atSource ? wps[0] : wps[wps.length - 1];
      if (first) { farEnds.push(first); continue; }
      const far = atSource
        ? (e.target && e.targetHandle ? pinMap.get(`${e.target}-${e.targetHandle}`) : undefined)
        : (e.source && e.sourceHandle ? pinMap.get(`${e.source}-${e.sourceHandle}`) : undefined);
      if (far) farEnds.push(far);
    }
    termDirs.set(n.id, terminalDirection(dock, farEnds));
  }

  const svg = (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`${minX} ${minY} ${width} ${height}`}>
      <rect x={minX} y={minY} width={width} height={height} fill="#ffffff" />
      {wires}
      {labels}
      {nodes.map((n) => <SymbolNode key={n.id} node={n} norm={norm} dir={termDirs.get(n.id)} />)}
      {directiveBox && <DirectiveTextBox box={directiveBox} />}
    </svg>
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(svg)}`;
}
