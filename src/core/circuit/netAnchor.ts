import type { PortType } from "@core/components/special/Special.js";
import { CENTER, GROUND_PIN } from "@core/ltspice/ltspiceGeometry.js";

/**
 * A name pinned to a coordinate, naming whatever net passes underneath.
 *
 * This is what a `.asc` `FLAG` actually is, and modelling it as anything else is
 * where our net labels went wrong: we made them nodes with a pin, joined by
 * edges, and so part of the topology. Everything that followed — a label
 * dragging its wire, `ascPassThrough`, splicing labels out of routes before
 * writing them, a second name on a net overwriting the first — comes from that
 * one decision.
 *
 * An anchor owns no pin, no edge and no netlist line. It says "the net here is
 * called this", and several may say it about the same net: `leitungstest.asc`,
 * drawn in LTSpice, carries `x1` and `x2` on one net and the connectors
 * `nc1`/`nc2` on another.
 *
 * Deliberately the same shape as {@link DataFlag}, {@link TextBox} and
 * {@link SheetShape} — the three annotations that already live beside the
 * circuit rather than inside it, each with its own overlay layer and its own
 * line in the file. A net anchor is the fourth, not a new idea.
 *
 * Introduced alongside the existing net-label nodes, not in place of them: the
 * differential test in `netAnchor.test.ts` proves the anchors reproduce every
 * `FLAG`/`IOPIN` line the exporter writes today, before anything switches over.
 */
export interface NetAnchor {
  id: string;
  /** Where the name sits, in the same coordinates the file uses. */
  x: number;
  y: number;
  /** The net's name here. `0` (and `GND`) mean ground, wherever they appear. */
  name: string;
  /** Set only for a connector: the `IOPIN` direction it declares. */
  portType?: PortType;
  /**
   * Where the *readable* tag sits, relative to the anchor point above.
   *
   * The anchor decides what is named; this decides only where the name is read.
   * Splitting the two is what lets a label be dragged clear of a crowded corner
   * without letting go of its net — the point stays on the wire and a leader
   * line runs out to the tag (see NetAnchorLayer).
   *
   * Absent means "wherever the automatic layout puts it", which is the normal
   * case and how every label starts out: LTSpice stores no offset either, and a
   * file that never needed one should not grow one. Only a tag the user has
   * actually dragged carries a pair here.
   *
   * Deliberately *not* in the `.asc`. There is no room for it in `FLAG x y name`
   * and no attribute line to hang it on, so it rides in our own snapshot
   * (share links, autosave) and is dropped on export. A schematic reopened in
   * LTSpice draws the name beside its point, which is where it belongs anyway —
   * the wiring is unaffected, so the loss is cosmetic and total, never partial.
   */
  tx?: number;
  ty?: number;
}

/**
 * How far a tag may sit from its anchor before the leader line is drawn.
 *
 * Below this the line would be shorter than the gap it spans and reads as a
 * smudge on the terminal; the automatic layout already puts every tag inside
 * this radius (`netLabelShape`'s reach is 14), so an untouched sheet draws no
 * leader lines at all. One grid step and a half.
 */
export const LEADER_MIN = 24;

/** The tag's own position: the anchor plus its offset, when it has one. */
export function tagOffset(a: NetAnchor): { dx: number; dy: number } | null {
  return a.tx === undefined || a.ty === undefined ? null : { dx: a.tx, dy: a.ty };
}

/**
 * The anchors a schematic currently has, read off its parts.
 *
 * Derived rather than stored, and that is the point: an anchor list kept as
 * state would be a second copy of where the names sit, correct only until the
 * user moved a label. Computing it means it cannot drift — and it is the
 * projection the switch runs on, since the eventual model is this list with the
 * nodes gone rather than the two side by side.
 *
 * The coordinate is the flag's, not the node's: a net terminal docks at its
 * centre, a ground at its pin. Those two offsets are what the exporter uses to
 * place `FLAG` lines, and using anything else here would put the name half a
 * symbol away from where the file says it is.
 */
export function anchorsFromNodes(nodes: { id: string; position: { x: number; y: number }; data: unknown }[]): NetAnchor[] {
  const out: NetAnchor[] = [];
  for (const n of nodes) {
    const d = n.data as { componentType?: string; label?: string; portType?: PortType };
    const name = String(d.label ?? "").trim();
    if (!name) continue;
    if (d.componentType === "ground") {
      out.push({ id: n.id, x: Math.round(n.position.x + GROUND_PIN.dx), y: Math.round(n.position.y + GROUND_PIN.dy), name: "0" });
    } else if (d.componentType === "netlabel" || d.componentType === "netconnector") {
      const portType = d.componentType === "netconnector" ? d.portType ?? "BiDir" : undefined;
      out.push({
        id: n.id,
        x: Math.round(n.position.x + CENTER),
        y: Math.round(n.position.y + CENTER),
        name,
        ...(portType && portType !== "None" ? { portType } : {}),
      });
    }
  }
  return out;
}

/** `0` and `GND` name the ground net wherever they appear. */
export function isGroundAnchor(a: NetAnchor): boolean {
  return /^(0|gnd)$/i.test(a.name.trim());
}

/**
 * The `.asc` lines for an anchor: a `FLAG`, plus the `IOPIN` that a connector's
 * direction rides on. LTSpice writes the pair in exactly this order.
 */
export function formatAnchor(a: NetAnchor): string[] {
  const lines = [`FLAG ${Math.round(a.x)} ${Math.round(a.y)} ${a.name}`];
  if (a.portType && a.portType !== "None") lines.push(`IOPIN ${Math.round(a.x)} ${Math.round(a.y)} ${a.portType}`);
  return lines;
}

/**
 * A bus tap: the short stub that hangs a wire off a bus (`BUSTAP x1 y1 x2 y2`).
 *
 * The same kind of thing as a {@link NetAnchor}, which is why it lives here — a
 * mark at a place, beside the circuit rather than inside it, with its own line in
 * the file and its own overlay layer. It differs only in what it says and how it
 * is drawn: a name says "the net here is called this" and draws a tag, a tap says
 * "the net here comes off a bus" and draws a triangle.
 *
 * It carries no name and no orientation. In LTSpice a bus tap always points the
 * same way — the arrowhead to the right — and can be neither rotated nor
 * mirrored, so the two coordinate pairs say where it is, never which way it
 * faces. Buses themselves are not modelled: a tap is imported, drawn and written
 * back so a file that has one keeps it, which is what it did *not* do before —
 * `test2.asc` lost its `BUSTAP` line on every save.
 */
export interface BusTap {
  id: string;
  /** The end on the wire — the point the triangle's tip sits at. */
  x: number;
  y: number;
  /** The end on the bus. */
  x2: number;
  y2: number;
}

/** The `.asc` line for a bus tap, in LTSpice's own order. */
export function formatBusTap(t: BusTap): string {
  return `BUSTAP ${Math.round(t.x)} ${Math.round(t.y)} ${Math.round(t.x2)} ${Math.round(t.y2)}`;
}

/** Parse a `BUSTAP` line, or null when it is not one. */
export function parseBusTap(line: string, id: string): BusTap | null {
  const m = /^BUSTAP\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i.exec(line.trim());
  return m ? { id, x: +m[1], y: +m[2], x2: +m[3], y2: +m[4] } : null;
}
