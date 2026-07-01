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
 * Five-terminal operational amplifier backed by the LTSpice UniversalOpAmp2
 * symbol. Emits an `X` subcircuit call; the referenced model must be available
 * (e.g. imported via the library) for the circuit to simulate.
 */
export class OpAmp extends SpiceComponent {
  model: string;

  constructor(id: string, label: string, position?: Point, model = "UniversalOpAmp2") {
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
