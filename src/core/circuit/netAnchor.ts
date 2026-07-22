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
