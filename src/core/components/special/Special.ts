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
  }

  protected createPorts(): Port[] {
    return this.portNames.map(
      (name, i) =>
        new Port(`${this.id}-${name}`, name, { x: i % 2 === 0 ? -50 : 50, y: (i * 30) - 30 }),
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
