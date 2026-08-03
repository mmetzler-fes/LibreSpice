import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

/**
 * The voltage-controlled switch — SPICE's `S` device, LTSpice's `sw` symbol.
 *
 * Four terminals: two contacts whose resistance is switched, and a control pair
 * whose voltage does the switching. `S<name> n+ n- nc+ nc- <model>`, where the
 * named `.model … SW(…)` carries Ron, Roff, the threshold Vt and the hysteresis
 * Vh. The model lives in the sheet's directives, not on the instance — that is
 * SPICE's split, and it is why the switch carries a model *name* like a diode
 * does rather than a value.
 *
 * A part in its own right rather than the `vcspst` subcircuit we also ship: a
 * sheet drawn in LTSpice writes `SYMBOL sw` with a `.model` beside it, and only
 * an `S` line uses that model. Read as a subcircuit it would ask ngspice for a
 * `.subckt` by the model's name and find none.
 *
 * Pin order is LTSpice's own (sw.asy, SpiceOrder 1..4): A, B, NC+, NC-. The
 * control is measured NC+ minus NC-, so swapping those two inverts the switch —
 * silently, since it still simulates, just never closing.
 */
export class VSwitch extends SpiceComponent {
  /** Name of the `.model … SW(…)` this instance switches by. */
  model: string;

  constructor(id: string, label: string, position?: Point, model = "SW") {
    super(id, label, position);
    this.model = model;
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-a`, "A", { x: 0, y: -30 }),
      new Port(`${this.id}-b`, "B", { x: 0, y: 30 }),
      new Port(`${this.id}-ncp`, "NC+", { x: -50, y: 10 }),
      new Port(`${this.id}-ncn`, "NC-", { x: -50, y: -10 }),
    ];
  }

  getNetlistLine(): string {
    const [a, b, ncp, ncn] = this.ports.map((p) => this.nodeOrGnd(p.netId));
    return `${this.spiceRef("S")} ${a} ${b} ${ncp} ${ncn} ${this.model}`;
  }

  /**
   * A usable switch for a sheet that names no model of its own.
   *
   * Only ever emitted when nothing else defines that name (see
   * NetlistGenerator), so a sheet carrying its own `.model SW1 SW(…)` keeps it.
   * Without a fallback a freshly placed switch aborts the run with "could not
   * find a valid modelname", which reads as a broken part rather than a missing
   * directive. 1 V threshold with a little hysteresis suits a logic-level
   * control; `Vh` is not zero because an exactly-at-threshold control chatters.
   */
  getModelDirective(): string | null {
    return `.model ${this.model} SW(Ron=0.01 Roff=1Meg Vt=1 Vh=0.1)`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "model", label: "Model", value: this.model, type: "string" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "model") this.model = String(value);
  }

  clone(): VSwitch {
    const s = new VSwitch(this.id, this.label, { ...this.position }, this.model);
    s.rotation = this.rotation;
    return s;
  }
}
