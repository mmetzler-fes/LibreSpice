import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export class Ground extends SpiceComponent {
  constructor(id: string, position?: Point) {
    super(id, "0", position);
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-gnd`, "gnd", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getProperties(): Property[] {
    return [];
  }

  setProperty(_key: string, _value: string | number): void {}

  clone(): Ground {
    const g = new Ground(this.id, { ...this.position });
    g.rotation = this.rotation;
    return g;
  }
}

/**
 * Net-label terminal (LTSpice `FLAG name`): a single-pin connector that names
 * the net it touches. It emits no device line — its only effect is to label its
 * net, so any two terminals with the same name become one node (connecting
 * distant parts) and the potential there can be probed by that name.
 */
export class NetLabel extends SpiceComponent {
  constructor(id: string, label: string, position?: Point) {
    super(id, label || "NET", position);
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-t`, "t", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getNetLabel(): string | null {
    const name = this.label.trim();
    return name ? name : null;
  }

  getProperties(): Property[] {
    return [{ key: "label", label: "Net name", value: this.label, type: "string" }];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
  }

  clone(): NetLabel {
    const n = new NetLabel(this.id, this.label, { ...this.position });
    n.rotation = this.rotation;
    return n;
  }
}

/**
 * Port type of a net connector, spelled exactly as LTSpice writes it in an
 * `IOPIN` line. `None` has no `IOPIN` at all — it is a bare `FLAG`, LTSpice's
 * "Port Type: None" — so the value doubles as the export mapping.
 */
export type PortType = "None" | "In" | "Out" | "BiDir";

export const PORT_TYPES: PortType[] = ["None", "In", "Out", "BiDir"];

/**
 * Net connector (LTSpice `FLAG name` + `IOPIN x y In|Out|BiDir`): a net label
 * that additionally declares the net as an interface to the outside, so it
 * becomes a pin when the sheet is used as a subcircuit.
 *
 * Electrically identical to a {@link NetLabel} — it names its net and nothing
 * else — but kept as its own component because LTSpice stores the two
 * differently, and because it carries a direction the label does not.
 */
export class NetConnector extends SpiceComponent {
  portType: PortType;

  constructor(id: string, label: string, position?: Point, portType: PortType = "BiDir") {
    super(id, label || "PORT", position);
    this.portType = portType;
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-t`, "t", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getNetLabel(): string | null {
    const name = this.label.trim();
    return name ? name : null;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Net name", value: this.label, type: "string" },
      { key: "portType", label: "Port type", value: this.portType, type: "select", options: PORT_TYPES },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    else if (key === "portType" && PORT_TYPES.includes(value as PortType)) {
      this.portType = value as PortType;
    }
  }

  clone(): NetConnector {
    const n = new NetConnector(this.id, this.label, { ...this.position }, this.portType);
    n.rotation = this.rotation;
    return n;
  }
}

/**
 * Five-terminal operational amplifier backed by the LTSpice UniversalOpAmp2
 * symbol. Emits an `X` subcircuit call; the referenced model must be available
 * (e.g. imported via the library) for the circuit to simulate.
 */
export class OpAmp extends SpiceComponent {
  model: string;

  // `level2` is the subcircuit name defined by the shipped UniversalOpAmp2.lib
  // (matching the LTSpice symbol's `SYMATTR SpiceModel level2`).
  constructor(id: string, label: string, position?: Point, model = "level2") {
    super(id, label, position);
    this.model = model;
  }

  protected createPorts(): Port[] {
    // SPICE pin order: In+, In-, V+, V-, OUT (matches UniversalOpAmp2).
    return [
      new Port(`${this.id}-inp`, "In+", { x: -32, y: 16 }),
      new Port(`${this.id}-inn`, "In-", { x: -32, y: -16 }),
      new Port(`${this.id}-vcc`, "V+", { x: 0, y: -32 }),
      new Port(`${this.id}-vee`, "V-", { x: 0, y: 32 }),
      new Port(`${this.id}-out`, "OUT", { x: 32, y: 0 }),
    ];
  }

  getNetlistLine(): string {
    const nodes = this.ports.map((p) => this.nodeOrGnd(p.netId)).join(" ");
    const ref = this.label.startsWith("X") ? this.label : `X${this.label}`;
    return `${ref} ${nodes} ${this.model}`;
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

  clone(): OpAmp {
    const o = new OpAmp(this.id, this.label, { ...this.position }, this.model);
    o.rotation = this.rotation;
    return o;
  }
}

export class CustomSubcircuit extends SpiceComponent {
  spiceModel: string;
  portNames: string[];

  constructor(
    id: string,
    label: string,
    position?: Point,
    spiceModel = "",
    portNames: string[] = ["in", "out", "gnd"],
  ) {
    super(id, label, position);
    this.spiceModel = spiceModel;
    this.portNames = portNames;
    // The base constructor calls createPorts() before portNames is assigned, so
    // the real ports are (re)built here once portNames is known.
    this.ports.length = 0;
    this.ports.push(...CustomSubcircuit.buildPorts(id, portNames));
  }

  protected createPorts(): Port[] {
    // portNames is undefined during super() construction – ports are populated
    // by the constructor once it is set (see above).
    return CustomSubcircuit.buildPorts(this.id, this.portNames ?? []);
  }

  private static buildPorts(id: string, portNames: string[]): Port[] {
    return portNames.map(
      (name, i) =>
        new Port(`${id}-${name}`, name, { x: i % 2 === 0 ? -50 : 50, y: (i * 30) - 30 }),
    );
  }

  getNetlistLine(): string {
    const nodes = this.ports.map((p) => this.nodeOrGnd(p.netId)).join(" ");
    const subcktName = this.spiceModel.split("\n")[0]?.match(/\.subckt\s+(\S+)/i)?.[1] ?? "UNKNOWN";
    return `${this.label} ${nodes} ${subcktName}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "spiceModel", label: "SPICE Model", value: this.spiceModel, type: "string" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "spiceModel") this.spiceModel = String(value);
  }

  clone(): CustomSubcircuit {
    const c = new CustomSubcircuit(this.id, this.label, { ...this.position }, this.spiceModel, [...this.portNames]);
    c.rotation = this.rotation;
    return c;
  }
}
