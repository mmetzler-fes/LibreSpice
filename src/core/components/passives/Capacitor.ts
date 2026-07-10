import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";
import { isParametricValue, toComponentNumber } from "../base/componentValue.js";

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
    return `${this.label} ${p} ${n} ${this.fmtVal(this.capacitance)}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      this.valueExpr
        ? { key: "capacitance", label: "Capacitance", value: this.valueExpr, type: "string" }
        : { key: "capacitance", label: "Capacitance", value: this.capacitance, unit: "F", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "capacitance") {
      if (isParametricValue(value)) this.valueExpr = value;
      else { this.valueExpr = undefined; this.capacitance = toComponentNumber(value, this.capacitance); }
    }
  }

  clone(): Capacitor {
    const c = new Capacitor(this.id, this.label, { ...this.position }, this.capacitance);
    c.rotation = this.rotation;
    c.valueExpr = this.valueExpr;
    return c;
  }
}
