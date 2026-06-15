import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export class Inductor extends SpiceComponent {
  inductance: number;

  constructor(id: string, label: string, position?: Point, inductance = 1e-3) {
    super(id, label, position);
    this.inductance = inductance;
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-p`, "p", { x: 0, y: -30 }),
      new Port(`${this.id}-n`, "n", { x: 0, y: 30 }),
    ];
  }

  getNetlistLine(): string {
    const p = this.nodeOrGnd(this.ports[0].netId);
    const n = this.nodeOrGnd(this.ports[1].netId);
    return `${this.label} ${p} ${n} ${this.inductance}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "inductance", label: "Inductance", value: this.inductance, unit: "H", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "inductance") this.inductance = Number(value);
  }

  clone(): Inductor {
    const l = new Inductor(this.id, this.label, { ...this.position }, this.inductance);
    l.rotation = this.rotation;
    return l;
  }
}
