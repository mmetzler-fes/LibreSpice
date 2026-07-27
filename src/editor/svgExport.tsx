import { renderToStaticMarkup } from "react-dom/server";
import type { Node, Edge } from "@xyflow/react";
import { symbolByName, symbolForType, symbolBounds, type SymbolNorm } from "@sym/asyParser.js";
import { AsyGeometry, mapSymbol } from "@sym/AsySymbol.js";
import { NODE_SIZE, GRID, getNodePins, getLocalPins, edgeRouteHints } from "./pinGeometry.js";
import { netLabelShape, tagBoxOrigin } from "./netLabelShape.js";
import { LEADER_MIN, tagOffset } from "@core/circuit/netAnchor.js";
import type { NetAnchor, BusTap } from "@core/circuit/netAnchor.js";
import { terminalDirection, terminalTagSide, sampleWire } from "./netTerminalOrientation.js";
import type { PortType } from "@core/components/special/Special.js";
import { orthoVertices, type FlowPoint, type WireData } from "./WireTool.js";
import { flattenForExport } from "./markdown.js";
import { TEXT_SIZE_DEFAULT, textScale, textFlow, type TextBox } from "@core/circuit/textBox.js";
import { dashArray, type SheetShape } from "@core/circuit/sheetShape.js";
import { captionSvgPlacement, captionSide, DEFAULT_HALF, LABEL_FONT_SIZE, VALUE_FONT_SIZE } from "./captionLayout.js";
import {
  DIRECTIVE_BORDER, DIRECTIVE_FONT_FAMILY, DIRECTIVE_FONT_SIZE, DIRECTIVE_RADIUS,
  directiveBoxGeometry, type DirectiveBoxGeometry,
} from "./directiveBoxLayout.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import {
  ResistorSymbol, CapacitorSymbol, InductorSymbol, DiodeSymbol, LEDSymbol,
  BJTNPNSymbol, BJTPNPSymbol, MOSFETNSymbol, JFETNSymbol, JFETPSymbol,
  VoltageSourceSymbol, CurrentSourceSymbol, SineSourceSymbol, PulseSourceSymbol, PWLSourceSymbol,
  GroundSymbol, LogicGateSymbol, DFlipFlopSymbol,
} from "./nodes/symbols/Symbols.js";

/** Hand-drawn fallback symbols (viewBox -40..40), for types without an .asy. */
const FALLBACK: Partial<Record<ComponentType, React.FC>> = {
  resistor: ResistorSymbol, capacitor: CapacitorSymbol, inductor: InductorSymbol,
  diode: DiodeSymbol, led: LEDSymbol, zener: DiodeSymbol, schottky: DiodeSymbol,
  bjt_npn: BJTNPNSymbol, bjt_pnp: BJTPNPSymbol, mosfet_n: MOSFETNSymbol, mosfet_p: MOSFETNSymbol,
  jfet_n: JFETNSymbol, jfet_p: JFETPSymbol,
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

function SymbolNode({ node, norm }: { node: Node; norm: SymbolNorm }) {
  const data = node.data as ComponentNodeData;
  const type = data.componentType;
  const rotation = data.rotation ?? 0;
  const mirrored = !!data.mirrored;
  const { x, y } = node.position;

  // A junction is a place where wires meet, not a part (see Junction): the wires
  // running into it already show the connection, so it draws nothing.
  if (type === "junction") return null;

  // A library part draws its own `.asy`, exactly as the canvas does (see
  // ComponentNode's LibrarySymbolNode) — and through the same `mapSymbol`, so
  // the drawing lands on the pins the wires were routed to. Only a part whose
  // symbol is missing falls back to the named box, which is all a `.subckt`
  // dropped in without artwork can be drawn as.
  const libSym = type === "subcircuit" && data.symbolName
    ? symbolByName(data.symbolName, norm)
    : undefined;

  if (type === "subcircuit" && !libSym) {
    return (
      <g transform={`translate(${x} ${y})`} color="#334155">
        <rect x={10} y={4} width={NODE_SIZE - 20} height={NODE_SIZE - 8} rx={4} fill="#f8fafc" stroke="currentColor" strokeWidth={1.6} />
        <text x={NODE_SIZE / 2} y={NODE_SIZE / 2 + 3} fontSize={11} fontWeight={600} textAnchor="middle" fill="currentColor">{data.subName ?? "X"}</text>
      </g>
    );
  }

  const sym = libSym ?? symbolForType(type, norm);
  // Native-scale mapping (margin 0, grid-snapped) — identical to the editor node
  // and to getNodePins, so the drawn symbol lands exactly on its pins (and thus
  // on the wire endpoints). A fit-to-box mapping would shrink/offset it.
  const mapping = sym ? mapSymbol(sym, NODE_SIZE, 0, GRID, true) : null;
  // Drawn half-extents in px, matching the editor, so captions hug the shape and
  // the user's dragged offset lands identically.
  const halfW = sym ? (symbolBounds(sym).width / 2) * mapping!.scale : DEFAULT_HALF.w;
  const halfH = sym ? (symbolBounds(sym).height / 2) * mapping!.scale : DEFAULT_HALF.h;

  // The digital parts draw themselves from their properties (gate mark and lead
  // count; clock edge, kind and Set/Reset polarity), so they are bound with those
  // here — exactly as the editor node does. Left to the plain FALLBACK lookup they
  // came out of the export drawn as resistors.
  // Bound as an element rather than as a wrapper component: a function declared
  // here is a new component type on every render, which makes React rebuild the
  // subtree instead of updating it (see ComponentNode, where the same shape was
  // fixed).
  const digital =
    type === "dff"
      ? <DFlipFlopSymbol edge={data.edge} asyncPolarity={data.asyncPolarity} kind={data.kind} />
      : type === "logicgate"
      ? <LogicGateSymbol gate={data.gateType} inputs={data.inputs} />
      : null;

  const inner = digital ? (
    // Hand-drawn symbols live in a -40..40 space centred on the node.
    <g transform={`translate(${NODE_SIZE / 2} ${NODE_SIZE / 2}) ${transformFor(rotation, mirrored, 0, 0) ?? ""}`}>
      {digital}
    </g>
  ) : sym ? (
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
  // Same flank the editor chose, or a saved sheet would not match the screen.
  const side = captionSide(getLocalPins(data, norm));
  const labelPos = captionSvgPlacement("label", rotation, halfW, halfH, LABEL_FONT_SIZE, data.labelOffset, side);
  const valuePos = captionSvgPlacement("value", rotation, halfW, halfH, VALUE_FONT_SIZE, data.valueOffset, side);
  return (
    <g transform={`translate(${x} ${y})`} color="#0f172a">
      {inner}
      {showCaption && (
        <text x={labelPos.x} y={labelPos.y} textAnchor={labelPos.textAnchor} dominantBaseline={labelPos.baseline} fontSize={LABEL_FONT_SIZE} fontFamily="monospace" fill="#374151">{data.label}</text>
      )}
      {showCaption && data.valueLabel && !libSym && (
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

/**
 * A text box, laid out line by line — SVG has no flow layout, so the wrapping
 * the canvas gets from CSS has to be computed here (see flattenForExport).
 */
function TextBoxShape({ box }: { box: TextBox }) {
  // The text's own size and orientation (see textBox). A scale of 1 is LTSpice's
  // 1.5, which is what everything here has always been drawn at.
  const fontSize = 11 * textScale(box.size ?? TEXT_SIZE_DEFAULT);
  const flow = textFlow(box.justify ?? "Left");
  // Average glyph width of the sans-serif face at this size; good enough for a
  // greedy wrap, and erring narrow keeps the text inside the width.
  const charsPerLine = Math.max(4, Math.floor(box.width / (fontSize * 0.53)));
  const lines = flattenForExport(box.text, box.markdown, charsPerLine);
  const lineHeight = fontSize * 1.45;
  // No frame and no clipping, as on the canvas: a note is the text, and the
  // height it needs is however many lines it has. The old fixed rectangle cut
  // off the end of a long note and, at seven times the base size, most of a
  // short one.
  const height = Math.max(lineHeight, lines.length * lineHeight);
  const cx = box.x + box.width / 2, cy = box.y + height / 2;
  const align = flow.align === "center" ? "middle" : flow.align === "right" ? "end" : "start";
  const anchorX = flow.align === "center" ? box.x + box.width / 2
    : flow.align === "right" ? box.x + box.width
    : box.x;
  return (
    <g transform={flow.vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
      {lines.map((l, i) => (
        <text
          key={i}
          x={anchorX + l.indent * fontSize * 0.9}
          y={box.y + lineHeight * (i + 0.8)}
          fontSize={fontSize * l.scale}
          fontWeight={l.bold ? 600 : 400}
          fontFamily="sans-serif"
          textAnchor={align}
          fill="#0f172a"
          xmlSpace="preserve"
        >
          {l.text}
        </text>
      ))}
    </g>
  );
}

/**
 * How tall a text box comes out, for the bounding box. Mirrors TextBoxShape: the
 * height follows the content, so a long note is not cropped at the sheet edge.
 */
function textBoxHeight(box: TextBox): number {
  const fontSize = 11 * textScale(box.size ?? TEXT_SIZE_DEFAULT);
  const charsPerLine = Math.max(4, Math.floor(box.width / (fontSize * 0.53)));
  const lines = flattenForExport(box.text, box.markdown, charsPerLine);
  return Math.max(fontSize * 1.45, lines.length * fontSize * 1.45);
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
/** Height of a name's tag box. */
const TAG_H = 16;

/** Distance from a point to a segment — which wire a name is lying on. */
function distToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

export function buildSchematicSvg(
  nodes: Node[],
  edges: Edge[],
  norm: SymbolNorm,
  directives?: DirectiveOverlay,
  // Kept for call-site compatibility: the wires no longer carry a name of their
  // own, so nothing here needs to look one up.
  _circuit?: NetNameLookup,
  textBoxes: TextBox[] = [],
  sheetShapes: SheetShape[] = [],
  anchors: NetAnchor[] = [],
  busTaps: BusTap[] = [],
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
    wireVerts.push(orthoVertices([a as FlowPoint, ...waypoints, b as FlowPoint], edgeRouteHints(nodes, e, norm)));
  }

  // Where each name sits and which way it faces, from the wire it lies on — the
  // same rule as on screen (see terminalDirection), so the exported sheet is laid
  // out exactly like the one the user is looking at. Worked out here because the
  // bounding box below needs it as much as the drawing further down does.
  const anchorLayouts = anchors.map((a) => {
    const dock = { x: a.x, y: a.y };
    let best = 24, ends: FlowPoint[] = [];
    for (const verts of wireVerts) {
      for (let i = 0; i < verts.length - 1; i++) {
        const d = distToSegment(dock, verts[i], verts[i + 1]);
        if (d < best) { best = d; ends = [verts[i], verts[i + 1]]; }
      }
    }
    const dir = terminalDirection(dock, ends);
    const neighbours = nodes.map((o) => ({ x: o.position.x + NODE_SIZE / 2, y: o.position.y + NODE_SIZE / 2 }));
    for (const verts of wireVerts) neighbours.push(...sampleWire(verts, dock));
    const portType: PortType = a.portType ?? "None";
    const shape = netLabelShape(portType, dir, terminalTagSide(dock, dir, neighbours));
    const tagW = Math.max(20, a.name.length * 6.8 + 12);
    // Sheet coordinates for the tag's top-left: its anchor is local to the node
    // frame, so it is shifted out of that frame once, here.
    //
    // A tag the user has dragged off keeps its own offset instead, centred on
    // the point it was dragged to — the export has to show the sheet the way it
    // is on screen, and a picture that pulled every name back to its anchor
    // would be a different drawing from the one being exported. (The `.asc` does
    // pull them back, but that is a format without room for the offset; an image
    // has no such excuse — see NetAnchor.tx.)
    const off = tagOffset(a);
    const local = off
      ? { x: NODE_SIZE / 2 + off.dx - tagW / 2, y: NODE_SIZE / 2 + off.dy - TAG_H / 2 }
      : tagBoxOrigin(shape.tag, tagW, TAG_H);
    const tag = { x: a.x - NODE_SIZE / 2 + local.x, y: a.y - NODE_SIZE / 2 + local.y };
    const leader = off && Math.hypot(off.dx, off.dy) >= LEADER_MIN
      ? { x1: a.x, y1: a.y, x2: a.x + off.dx, y2: a.y + off.dy }
      : null;
    return { a, shape, portType, tagW, tag, leader };
  });

  // Bounding box over symbols, pins and every wire vertex (so a hand-routed
  // waypoint outside the component boxes is never clipped).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of nodes) { grow(n.position.x, n.position.y); grow(n.position.x + NODE_SIZE, n.position.y + NODE_SIZE); }
  for (const { x, y } of pinMap.values()) grow(x, y);
  for (const verts of wireVerts) for (const p of verts) grow(p.x, p.y);
  // A name's tag steps clear of its point and a long one reaches a long way, so
  // the box has to be grown by the tag actually drawn — estimating it as "about
  // half a symbol" cropped `SEHR_LANGER_NETZNAME` at the sheet edge.
  for (const t of busTaps) { grow(Math.min(t.x, t.x2), t.y - 6); grow(Math.max(t.x, t.x2) + 12, t.y + 6); }
  for (const l of anchorLayouts) {
    grow(l.tag.x, l.tag.y);
    grow(l.tag.x + l.tagW, l.tag.y + TAG_H);
    // A connector's arrow reaches out the other way.
    grow(l.a.x - NODE_SIZE / 2, l.a.y - NODE_SIZE / 2);
    grow(l.a.x + NODE_SIZE / 2, l.a.y + NODE_SIZE / 2);
  }
  // The directive box is usually dragged clear of the parts, so it drives the
  // bounds as much as they do.
  if (directiveBox) {
    grow(directiveBox.x, directiveBox.y);
    grow(directiveBox.x + directiveBox.width, directiveBox.y + directiveBox.height);
  }
  // Text boxes are usually placed clear of the circuit, so they drive the bounds
  // as much as the parts do.
  for (const t of textBoxes) {
    grow(t.x, t.y);
    grow(t.x + t.width, t.y + textBoxHeight(t));
  }
  for (const s of sheetShapes) { grow(s.x1, s.y1); grow(s.x2, s.y2); }
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

  // The names, drawn over the wires but under the symbols — the same stacking
  // the editor uses. Which way each one faces comes from the wire it lies on, by
  // the same rule as on screen (see terminalDirection), so the exported sheet is
  // laid out exactly like the one the user is looking at.
  const labels = anchorLayouts.map(({ a, shape, portType, tagW, tag, leader }) => (
    <g key={a.id}>
      {/* The leader line back to the anchor, where the tag has been dragged far
          enough that the pairing would otherwise be guesswork. Dashed and thin,
          as on screen: it points, it does not connect. */}
      {leader && (
        <line x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2}
          stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
      )}
      {/* The circle and arrow are laid out in the old node's local frame, whose
          centre is the dock — hence the shift by half a node box. The name tag is
          drawn in sheet coordinates instead: it is always upright, and keeping it
          absolute is what lets the bounding box above measure it directly. */}
      <g transform={`translate(${a.x - NODE_SIZE / 2} ${a.y - NODE_SIZE / 2})`}>
        {shape.stem && (
          <line x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2} stroke="#334155" strokeWidth={1.6} strokeLinecap="round" />
        )}
        {portType !== "None" && (
          <circle cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r} fill="#ffffff" stroke="#2563eb" strokeWidth={2} />
        )}
        {shape.heads.map((points, i) => <polygon key={i} points={points} fill="#334155" />)}
      </g>
      <rect x={tag.x} y={tag.y} width={tagW} height={TAG_H} rx={4}
        fill={portType === "None" ? "#e2e8f0" : "#fde9c8"} stroke="#94a3b8" strokeWidth={1} />
      <text x={tag.x + tagW / 2} y={tag.y + TAG_H / 2 + 3.5} fontSize={11} fontFamily="monospace" fill="#0f172a" textAnchor="middle">{a.name}</text>
    </g>
  ));

  const svg = (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`${minX} ${minY} ${width} ${height}`}>
      <rect x={minX} y={minY} width={width} height={height} fill="#ffffff" />
      {/* Sheet drawings sit beneath the circuit, as they do on the canvas. */}
      {sheetShapes.map((s) => {
        const common = { fill: "none", stroke: "#94a3b8", strokeWidth: 1.5, strokeDasharray: dashArray(s.dash) };
        if (s.kind === "line") return <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...common} />;
        const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
        const w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
        if (s.kind === "circle") return <ellipse key={s.id} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
        return <rect key={s.id} x={x} y={y} width={w} height={h} {...common} />;
      })}
      {wires}
      {busTaps.map((t) => {
        // Always pointing right — LTSpice offers no way to turn a bus tap.
        const x = Math.min(t.x, t.x2), y = t.y;
        return (
          <polygon key={t.id} fill="#1e293b"
            points={`${x},${y - 6} ${x},${y + 6} ${x + 12},${y}`} />
        );
      })}
      {labels}
      {nodes.map((n) => <SymbolNode key={n.id} node={n} norm={norm} />)}
      {textBoxes.map((t) => <TextBoxShape key={t.id} box={t} />)}
      {directiveBox && <DirectiveTextBox box={directiveBox} />}
    </svg>
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(svg)}`;
}
