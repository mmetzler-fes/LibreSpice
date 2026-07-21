import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export type ClockEdge = "rising" | "falling";
/** Whether SET/RESET assert on a high or a low level. */
export type AsyncPolarity = "high" | "low";
/**
 * Which storage element this is. All three share the same latch cell; they
 * differ only in how many cells there are and what feeds the first one.
 */
export type FlipFlopKind = "dff" | "tff" | "dlatch";

export const KIND_LABELS: Record<FlipFlopKind, string> = {
  dff: "D Flip-Flop", tff: "T Flip-Flop", dlatch: "D Latch",
};

/**
 * A one-bit storage element — D flip-flop, T flip-flop or transparent D latch —
 * built from behavioural sources and capacitors.
 *
 * Unlike a logic gate a flip-flop has to *remember*, and a `B` source is purely
 * combinational — its output is a function of the present node voltages only.
 * The bundled ngspice has no XSPICE, so `d_dff` is not available either. State
 * therefore lives on a capacitor: a `B` current source drives the cap toward the
 * D level while its latch is transparent and goes open-circuit while it holds,
 * which is a sample-and-hold — verified against the engine, the cap keeps its
 * level after the input has moved away.
 *
 * Two of those in series make the edge trigger. The master is transparent while
 * the clock is inactive and the slave while it is active, so D reaches Q only by
 * being handed across at the moment the clock changes — one edge, no transparent
 * path from D to Q at any time. That is what makes a toggle connection (D tied
 * to ~Q) divide the clock by two instead of oscillating.
 *
 * The three kinds are the same cell wired differently: the D flip-flop is two
 * cells with D feeding the master, the T flip-flop is the same pair with the
 * master fed by its own output gated by T, and the latch is a single cell — so
 * it *is* transparent while enabled, which is the whole point of a latch.
 *
 * Like the logic gates this is ideal: the only delay is the latch time constant
 * (RON x CSTORE, a nanosecond), there is no setup/hold window and no fan-out
 * limit. Circuits that *depend* on real timing will not behave like hardware.
 */
export class DFlipFlop extends SpiceComponent {
  /** D flip-flop, T flip-flop or transparent D latch. */
  kind: FlipFlopKind = "dff";
  /**
   * Which clock edge samples the data input. For a latch there is no edge —
   * this selects the level the latch is transparent on instead ("rising" =
   * transparent while EN is high).
   */
  edge: ClockEdge = "rising";
  /** Level at which SET/RESET assert. */
  asyncPolarity: AsyncPolarity = "high";
  /** Input threshold: above this an input counts as logic 1. */
  threshold = 2.5;
  /** Output level for logic 1. */
  vHigh = 5;

  /**
   * Latch time constant, as a resistance and a capacitance. Small enough to be
   * invisible next to any realistic clock, large enough that the solver still
   * sees a smooth transition rather than a step it has to chase.
   */
  private static readonly RON = 1;
  private static readonly CSTORE = "1n";
  /**
   * Leakage across each storage node. A holding latch is an open circuit, and
   * ngspice rejects a node with no DC path to ground before it ever evaluates
   * the transient. 1 Tohm against 1 nF droops over ~1000 s — irrelevant next to
   * any clock, but enough to make the operating point solvable.
   */
  private static readonly RLEAK = "1t";

  constructor(id: string, label: string, position?: Point, kind: FlipFlopKind = "dff") {
    super(id, label, position);
    this.kind = kind;
    // The base constructor already built ports, but it ran before `kind` was
    // assigned, so the two input pins carry the D flip-flop's names.
    this.rebuildPorts();
  }

  protected createPorts(): Port[] {
    // Port *ids* stay the same across all three kinds — the .asc geometry table
    // and the editor's handles are keyed on them. Only the displayed names move.
    const data = this.kind === "tff" ? "T" : "D";
    const clock = this.kind === "dlatch" ? "EN" : "CLK";
    return [
      new Port(`${this.id}-d`, data, { x: -32, y: -24 }),
      new Port(`${this.id}-clk`, clock, { x: -32, y: 24 }),
      new Port(`${this.id}-set`, "SET", { x: 0, y: -48 }),
      new Port(`${this.id}-rst`, "RESET", { x: 0, y: 48 }),
      new Port(`${this.id}-q`, "Q", { x: 32, y: -24 }),
      new Port(`${this.id}-qn`, "~Q", { x: 32, y: 24 }),
    ];
  }

  /** Internal storage node, namespaced so two flip-flops never share one. */
  private internal(suffix: string): string {
    // Underscore-joined, so the net-label substitution in the netlist generator
    // (which matches whole words) cannot rewrite a fragment of it.
    return `n_${this.label.replace(/[^A-Za-z0-9]/g, "")}_${suffix}`;
  }

  private net(name: string): string {
    return this.nodeOrGnd(this.getPort(name)?.netId ?? null);
  }

  /** True when the pin is wired up; an open SET/RESET must not assert. */
  private connected(name: string): boolean {
    return !!this.getPort(name)?.netId;
  }

  getNetlistLine(): string {
    const ref = this.label.replace(/[^A-Za-z0-9]/g, "");
    const { threshold: t, vHigh: hi } = this;
    const nm = this.internal("m");
    const ns = this.internal("s");
    const dataPin = this.kind === "tff" ? "T" : "D";
    const clockPin = this.kind === "dlatch" ? "EN" : "CLK";
    const [d, clk, q, qn] = [this.net(dataPin), this.net(clockPin), this.net("Q"), this.net("~Q")];

    // An unconnected SET/RESET is left out of the expression entirely rather
    // than read as 0 V: with active-low pins that would assert it permanently
    // and pin the output.
    const assert = (pin: string) =>
      this.connected(pin)
        ? this.asyncPolarity === "low"
          ? `(v(${this.net(pin)})<${t})`
          : `(v(${this.net(pin)})>${t})`
        : null;
    const S = assert("SET");
    const R = assert("RESET");

    // SET outranks RESET, and both outrank the clock. `want` is the logic level
    // the cell is driven to once it is transparent, as a boolean expression.
    const level = (want: string) => {
      let expr = `(${want} ? ${hi} : 0)`;
      if (R) expr = `(${R} ? 0 : ${expr})`;
      if (S) expr = `(${S} ? ${hi} : ${expr})`;
      return expr;
    };
    // The latch is transparent while `open` holds, and while an async input is
    // asserted — that is what makes SET/RESET take effect without a clock edge.
    const drive = (node: string, want: string, open: string) => {
      const gate = [S, R, open].filter(Boolean).join(" || ");
      return `(${gate}) ? (v(${node}) - ${level(want)})/${DFlipFlop.RON} : 0`;
    };
    /** One storage cell: the driver, its capacitor and its leak to ground. */
    const cell = (suffix: string, node: string, want: string, open: string) => [
      `B${ref}${suffix} ${node} 0 I = ${drive(node, want, open)}`,
      `C${ref}${suffix} ${node} 0 ${DFlipFlop.CSTORE}`,
      `R${ref}${suffix} ${node} 0 ${DFlipFlop.RLEAK}`,
    ];

    const high = (n: string) => `(v(${n})>${t})`;
    // The level the clock input has to be at for the *output* cell to be
    // transparent. For the latch that is simply when EN is asserted.
    const active = this.edge === "rising" ? high(clk) : `(v(${clk})<${t})`;
    const inactive = this.edge === "rising" ? `(v(${clk})<${t})` : high(clk);

    let lines: string[];
    let out: string;
    if (this.kind === "dlatch") {
      // A latch is one cell, transparent the whole time EN is asserted — there
      // is a straight path from D to Q, which is exactly what makes it a latch
      // and not a flip-flop.
      out = ns;
      lines = cell("S", ns, high(d), active);
    } else {
      // Master transparent while the clock is away from the active edge, slave
      // while it is at it, so data crosses only on the edge itself.
      // The T flip-flop differs from the D only in what the master samples: its
      // own inverted output, gated by T. Reading the slave (not the master) is
      // what keeps the feedback safe — the slave holds while the master is open.
      out = ns;
      const want = this.kind === "tff"
        ? `(${high(d)} != ${high(ns)})`
        : high(d);
      lines = [...cell("M", nm, want, inactive), ...cell("S", ns, high(nm), active)];
    }

    // Only drive an output that is actually wired to something; a `B` source on
    // a dangling node is harmless but shows up as a stray vector in the plot.
    if (this.connected("Q")) lines.push(`B${ref}Q ${q} 0 V = ${high(out)} ? ${hi} : 0`);
    if (this.connected("~Q")) lines.push(`B${ref}N ${qn} 0 V = ${high(out)} ? 0 : ${hi}`);
    return lines.join("\n");
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "kind", label: "Type", value: this.kind, type: "select", options: Object.keys(KIND_LABELS) },
      this.kind === "dlatch"
        ? { key: "edge", label: "Transparent while EN", value: this.edge === "rising" ? "high" : "low", type: "select", options: ["high", "low"] }
        : { key: "edge", label: "Clock edge", value: this.edge, type: "select", options: ["rising", "falling"] },
      {
        key: "asyncPolarity", label: "Set/Reset active", value: this.asyncPolarity,
        type: "select", options: ["high", "low"],
      },
      { key: "threshold", label: "Input threshold", value: this.threshold, unit: "V", type: "number" },
      { key: "vHigh", label: "Output high", value: this.vHigh, unit: "V", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    switch (key) {
      case "label": this.label = String(value); break;
      case "kind": {
        this.kind = String(value) as FlipFlopKind;
        // The data and clock pins are named after the kind, so they have to be
        // rebuilt — otherwise a latch keeps showing "CLK".
        this.rebuildPorts();
        break;
      }
      // The latch reuses this field for its enable level, and the properties
      // panel offers it as high/low there.
      case "edge":
        this.edge = (value === "falling" || value === "low") ? "falling" : "rising";
        break;
      case "asyncPolarity": this.asyncPolarity = String(value) as AsyncPolarity; break;
      case "threshold": this.threshold = Number(value); break;
      case "vHigh": this.vHigh = Number(value); break;
    }
  }

  /** Re-create the ports after the kind changed. */
  rebuildPorts(): void {
    this.ports.length = 0;
    this.ports.push(...this.createPorts());
  }

  serialize(): Record<string, string | number> {
    return {
      label: this.label, kind: this.kind, edge: this.edge, asyncPolarity: this.asyncPolarity,
      threshold: this.threshold, vHigh: this.vHigh,
    };
  }

  clone(): DFlipFlop {
    const f = new DFlipFlop(this.id, this.label, { ...this.position }, this.kind);
    f.edge = this.edge;
    f.asyncPolarity = this.asyncPolarity;
    f.threshold = this.threshold;
    f.vHigh = this.vHigh;
    f.rotation = this.rotation;
    return f;
  }
}
