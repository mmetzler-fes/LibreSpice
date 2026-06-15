import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export class Capacitor extends SpiceComponent {
  capacitance: number;

  constructor(id: string, label: string, position?: Point, capacitance = 1e-6) {
    super(id, label, position);
    this.capacitance = capacitance;
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
    return `${this.label} ${p} ${n} ${this.capacitance}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "capacitance", label: "Capacitance", value: this.capacitance, unit: "F", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "capacitance") this.capacitance = Number(value);
  }

  clone(): Capacitor {
    const c = new Capacitor(this.id, this.label, { ...this.position }, this.capacitance);
    c.rotation = this.rotation;
    return c;
  }
}
