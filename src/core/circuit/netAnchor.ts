import type { PortType } from "@core/components/special/Special.js";

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
