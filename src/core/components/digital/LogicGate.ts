import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export type GateType = "and" | "or" | "nand" | "nor" | "xor" | "xnor" | "not" | "buffer";

/** Gates with a fixed single input; the input count is not editable for these. */
const SINGLE_INPUT: GateType[] = ["not", "buffer"];

export const GATE_LABELS: Record<GateType, string> = {
  and: "AND", or: "OR", nand: "NAND", nor: "NOR",
  xor: "XOR", xnor: "XNOR", not: "NOT", buffer: "Buffer",
};

/**
 * A logic gate, simulated as a behavioural source.
 *
 * The bundled ngspice is built without XSPICE, so its digital code models
 * (`d_and`, `adc_bridge`, …) are not available — they are rejected as unknown
 * device types. What the expression parser does support is `&&`, `||`, `!=`
 * and the ternary operator, so each gate becomes one `B` source that compares
 * its inputs against a threshold and drives the output to the logic-high level.
 *
 * This is an ideal gate: zero output impedance, no propagation delay, no fan-out
 * limit. For the teaching circuits it serves that is the useful abstraction —
 * but it means timing-dependent circuits (ring oscillators, race conditions)
 * will not behave like real hardware, and a feedback loop through gates has no
 * delay to make it settle.
 */
export class LogicGate extends SpiceComponent {
  gateType: GateType;
  /** Number of inputs (1 for NOT/Buffer, otherwise 2…5). */
  inputs: number;
  /** Input threshold: above this an input counts as logic 1. */
  threshold = 2.5;
  /** Output level for logic 1. */
  vHigh = 5;

  constructor(id: string, label: string, position?: Point, gateType: GateType = "and", inputs = 2) {
    super(id, label, position);
    this.gateType = gateType;
    this.inputs = SINGLE_INPUT.includes(gateType) ? 1 : inputs;
    // The base constructor already built ports, but it ran before these fields
    // existed — so the pin count it used was the fallback, not this gate's.
    this.rebuildPorts();
  }

  protected createPorts(): Port[] {
    // Called once from the base constructor before this class's fields are
    // assigned, hence the fallbacks; the constructor rebuilds straight after.
    const n = SINGLE_INPUT.includes(this.gateType) ? 1 : (this.inputs ?? 2);
    const ports: Port[] = [];
    // Inputs spread down the left edge, output centred on the right.
    const span = 48;
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      ports.push(new Port(`${this.id}-in${i + 1}`, `In${i + 1}`, { x: -32, y: Math.round(y) }));
    }
    ports.push(new Port(`${this.id}-out`, "Out", { x: 32, y: 0 }));
    return ports;
  }

  /** SPICE reference; ngspice keys the device type off the leading letter. */
  private bref(): string {
    return /^b/i.test(this.label) ? this.label : `B${this.label}`;
  }

  /**
   * The boolean expression for this gate, over its input terms.
   *
   * Negated gates are not written with a `!` — instead the ternary's two arms
   * are swapped, which needs no operator beyond the ones the parser is known to
   * accept.
   */
  private expression(terms: string[]): { cond: string; inverted: boolean } {
    switch (this.gateType) {
      case "and": return { cond: terms.join(" && "), inverted: false };
      case "nand": return { cond: terms.join(" && "), inverted: true };
      case "or": return { cond: terms.join(" || "), inverted: false };
      case "nor": return { cond: terms.join(" || "), inverted: true };
      // XOR over several inputs is odd parity, which chains as a fold of `!=`.
      case "xor": return { cond: terms.join(" != "), inverted: false };
      case "xnor": return { cond: terms.join(" != "), inverted: true };
      case "not": return { cond: terms[0], inverted: true };
      default: return { cond: terms[0], inverted: false };
    }
  }

  getNetlistLine(): string {
    const inPorts = this.ports.slice(0, this.ports.length - 1);
    const out = this.nodeOrGnd(this.ports[this.ports.length - 1].netId);
    const terms = inPorts.map((p) => `(v(${this.nodeOrGnd(p.netId)})>${this.threshold})`);
    const { cond, inverted } = this.expression(terms);
    const [hi, lo] = inverted ? ["0", String(this.vHigh)] : [String(this.vHigh), "0"];
    return `${this.bref()} ${out} 0 V = (${cond}) ? ${hi} : ${lo}`;
  }

  getProperties(): Property[] {
    const props: Property[] = [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      {
        key: "gateType", label: "Gate", value: this.gateType, type: "select",
        options: Object.keys(GATE_LABELS),
      },
    ];
    if (!SINGLE_INPUT.includes(this.gateType)) {
      props.push({ key: "inputs", label: "Inputs", value: this.inputs, type: "number" });
    }
    props.push(
      { key: "threshold", label: "Input threshold", value: this.threshold, unit: "V", type: "number" },
      { key: "vHigh", label: "Output high", value: this.vHigh, unit: "V", type: "number" },
    );
    return props;
  }

  setProperty(key: string, value: string | number): void {
    switch (key) {
      case "label": this.label = String(value); break;
      case "gateType": {
        this.gateType = String(value) as GateType;
        // Switching to NOT/Buffer drops the extra pins; switching away restores
        // a sane count rather than leaving the gate with a single input.
        if (SINGLE_INPUT.includes(this.gateType)) this.inputs = 1;
        else if (this.inputs < 2) this.inputs = 2;
        this.rebuildPorts();
        break;
      }
      case "inputs": {
        const n = Math.max(2, Math.min(5, Math.round(Number(value)) || 2));
        if (!SINGLE_INPUT.includes(this.gateType)) {
          this.inputs = n;
          this.rebuildPorts();
        }
        break;
      }
      case "threshold": this.threshold = Number(value); break;
      case "vHigh": this.vHigh = Number(value); break;
    }
  }

  /** Re-create the ports after the pin count changed. */
  rebuildPorts(): void {
    this.ports.length = 0;
    this.ports.push(...this.createPorts());
  }

  serialize(): Record<string, string | number> {
    return {
      label: this.label, gateType: this.gateType, inputs: this.inputs,
      threshold: this.threshold, vHigh: this.vHigh,
    };
  }

  clone(): LogicGate {
    const g = new LogicGate(this.id, this.label, { ...this.position }, this.gateType, this.inputs);
    g.threshold = this.threshold;
    g.vHigh = this.vHigh;
    g.rotation = this.rotation;
    return g;
  }
}
