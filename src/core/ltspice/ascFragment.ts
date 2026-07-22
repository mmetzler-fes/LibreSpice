import type { Node, Edge } from "@xyflow/react";
import { LTSpiceExporter } from "./LTSpiceExporter.js";

/**
 * Cut / copy / paste of a schematic selection, carried as a `.asc` fragment.
 *
 * The clipboard payload is plain `.asc` text rather than an internal structure,
 * which is what makes paste work *across* circuits: the system clipboard
 * survives loading another schematic, another tab and a reload, and the text can
 * be read back by the same parser that opens a file. It is also inspectable when
 * something goes wrong, and it is at least a candidate for exchanging fragments
 * with LTSpice itself.
 *
 * Almost nothing is lost on the way: everything our model holds beyond what
 * `.asc` defines already travels in `SYMATTR LibreSpice` (gate kind, flip-flop
 * polarity, a subcircuit's pin order), and unedited values keep the file's own
 * spelling through `ascRaw` (see ascPreserve). What a fragment deliberately does
 * *not* carry is sheet-global state — directives, plot settings, the sheet size:
 * those belong to the schematic, not to a handful of parts cut out of it.
 */

interface Pt { x: number; y: number }

/**
 * The selection as a `.asc` fragment, or `""` when nothing is selected.
 *
 * A wire is taken along only when *both* of its ends are in the selection: one
 * that reaches out of it has nothing to attach to at the far end, and carrying
 * it over as a stub would paste a wire dangling into empty space.
 */
export function buildFragment(nodes: Node[], edges: Edge[], circuit: any): string {
  const picked = nodes.filter((n) => n.selected);
  if (picked.length === 0) return "";
  const ids = new Set(picked.map((n) => n.id));
  const inner = edges.filter((e) => ids.has(e.source) && ids.has(e.target));

  // A library part references its `.subckt` by name only, so on its own it would
  // paste into a circuit that has never heard of that model and netlist as
  // `UNKNOWN`. The definition therefore travels *with* the fragment, written the
  // way LTSpice writes an inline model itself — one directive `TEXT` holding the
  // whole block (see the LM317 example). Handed over as `directiveRaw` so the
  // exporter keeps each block on a single line instead of exploding it into one
  // text box per SPICE line.
  const models = new Map<string, string>();
  for (const n of picked) {
    const raw = String((circuit?.components?.get(n.id) as { spiceModel?: string } | undefined)?.spiceModel ?? "").trim();
    const name = raw.match(/\.subckt\s+(\S+)/i)?.[1];
    if (name && !models.has(name.toLowerCase())) models.set(name.toLowerCase(), raw);
  }
  const blocks = [...models.values()];
  const directiveRaw = blocks.map((raw, i) => ({
    text: raw,
    raw: `TEXT ${MODEL_TEXT_X} ${MODEL_TEXT_Y + i * 32} Left 0 !${raw.replace(/\r?\n/g, "\\n")}`,
  }));

  // The full circuit goes in on purpose: the exporter only writes a net's flag
  // when one of that net's pins is actually among the nodes it was given, so the
  // extra nets fall away by themselves. Sheet state beyond the models is empty.
  //
  // No marker line of our own: `.asc` has no comment syntax outside a
  // `TEXT … ;…` (which would paste back as a stray text box), and an unknown
  // leading line is exactly the kind of thing that would stop LTSpice reading the
  // payload. A fragment is recognised by its shape instead — see isFragment.
  return LTSpiceExporter.export(picked, inner, blocks.join("\n"), circuit, [], [], [], { directiveRaw }) + "\n";
}

/** Where a carried `.subckt` block is parked on the fragment's sheet. */
const MODEL_TEXT_X = 0;
const MODEL_TEXT_Y = 0;

/** The `.subckt` definitions a fragment carries, keyed by subcircuit name. */
export function fragmentModels(directives: string): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = [];
  // `.subckt` … `.ends` blocks, however many lines each spans.
  const re = /^[ \t]*\.subckt\s+(\S+)[\s\S]*?^[ \t]*\.ends\b.*$/gim;
  for (const m of directives.matchAll(re)) out.push({ name: m[1], raw: m[0] });
  return out;
}

/** Does this text look like a schematic fragment we can paste? */
export function isFragment(text: string): boolean {
  const t = text.trimStart();
  return /^Version\s+\d/i.test(t) || /^SYMBOL\s+\S/im.test(t);
}

/**
 * Top-left corner of a parsed fragment's parts, used to move it under the
 * cursor. Measured over nodes only — a wire always runs between two of them.
 */
export function fragmentOrigin(nodes: Node[]): Pt {
  if (nodes.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...nodes.map((n) => n.position.x)),
    y: Math.min(...nodes.map((n) => n.position.y)),
  };
}

/**
 * A free reference designator of the same kind as `label`, given what is taken.
 *
 * Pasting `R1` beside an existing `R1` would put two identical designators in
 * the netlist, where SPICE has no way to tell them apart. The prefix is kept and
 * only the number moves on, so a pasted divider stays recognisably `R…`.
 * A label with no trailing number (a net name like `UE`) is returned unchanged —
 * see `pasteLabelFor` for why that is the right call there.
 */
export function freeLabel(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  const m = label.match(/^(.*?)(\d+)$/);
  if (!m) return label;
  const [, prefix] = m;
  for (let n = parseInt(m[2], 10) + 1; n < 10000; n++) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return label;
}

/**
 * The label a pasted part should carry.
 *
 * Devices are renumbered on collision; **net labels and connectors are not**. A
 * net name is not an identity but a *connection*: pasting a block whose input is
 * called `UE` next to a circuit that already has `UE` is how the two get joined,
 * and that is what LTSpice does too. Renaming it to `UE1` would quietly break
 * the connection the user was reaching for.
 */
export function pasteLabelFor(componentType: string | undefined, label: string, taken: Set<string>): string {
  if (componentType === "netlabel" || componentType === "netconnector" || componentType === "ground") return label;
  return freeLabel(label, taken);
}
