import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export class Resistor extends SpiceComponent {
  resistance: number;

  constructor(id: string, label: string, position?: Point, resistance = 1000) {
    super(id, label, position);
    this.resistance = resistance;
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
    return `${this.label} ${p} ${n} ${this.resistance}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "resistance", label: "Resistance", value: this.resistance, unit: "Ω", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "resistance") this.resistance = Number(value);
  }

  clone(): Resistor {
    const r = new Resistor(this.id, this.label, { ...this.position }, this.resistance);
    r.rotation = this.rotation;
    return r;
  }
}
