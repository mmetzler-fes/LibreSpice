import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export abstract class Semiconductor extends SpiceComponent {
  model: string;

  constructor(id: string, label: string, model: string, position?: Point) {
    super(id, label, position);
    this.model = model;
  }
}

export class Diode extends Semiconductor {
  constructor(id: string, label: string, position?: Point, model = "D1N4148") {
    super(id, label, model, position);
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-a`, "anode", { x: 0, y: -30 }),
      new Port(`${this.id}-k`, "cathode", { x: 0, y: 30 }),
    ];
  }

  getNetlistLine(): string {
    const a = this.nodeOrGnd(this.ports[0].netId);
    const k = this.nodeOrGnd(this.ports[1].netId);
    return `${this.label} ${a} ${k} ${this.model}`;
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

  clone(): Diode {
    const d = new Diode(this.id, this.label, { ...this.position }, this.model);
    d.rotation = this.rotation;
    return d;
  }
}

export type LEDColor = "red" | "green" | "blue" | "yellow" | "white";

export class LED extends Diode {
  color: LEDColor;

  constructor(id: string, label: string, position?: Point, color: LEDColor = "red") {
    super(id, label, position, "DLED");
    this.color = color;
  }

  getProperties(): Property[] {
    return [
      ...super.getProperties(),
      {
        key: "color",
        label: "Color",
        value: this.color,
        type: "select",
        options: ["red", "green", "blue", "yellow", "white"],
      },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "color") this.color = value as LEDColor;
    else super.setProperty(key, value);
  }

  clone(): LED {
    const l = new LED(this.id, this.label, { ...this.position }, this.color);
    l.model = this.model;
    l.rotation = this.rotation;
    return l;
  }
}

export class Zener extends Diode {
  constructor(id: string, label: string, position?: Point, model = "DZener") {
    super(id, label, position, model);
  }

  clone(): Zener {
    const z = new Zener(this.id, this.label, { ...this.position }, this.model);
    z.rotation = this.rotation;
    return z;
  }
}

export class Schottky extends Diode {
  constructor(id: string, label: string, position?: Point, model = "DSchottky") {
    super(id, label, position, model);
  }

  clone(): Schottky {
    const s = new Schottky(this.id, this.label, { ...this.position }, this.model);
    s.rotation = this.rotation;
    return s;
  }
}

export type BJTType = "NPN" | "PNP";

export class BJT extends Semiconductor {
  type: BJTType;

  constructor(id: string, label: string, position?: Point, type: BJTType = "NPN", model = "Q2N2222") {
    super(id, label, model, position);
    this.type = type;
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-c`, "collector", { x: 0, y: -40 }),
      new Port(`${this.id}-b`, "base", { x: -40, y: 0 }),
      new Port(`${this.id}-e`, "emitter", { x: 0, y: 40 }),
    ];
  }

  getNetlistLine(): string {
    const c = this.nodeOrGnd(this.ports[0].netId);
    const b = this.nodeOrGnd(this.ports[1].netId);
    const e = this.nodeOrGnd(this.ports[2].netId);
    return `${this.label} ${c} ${b} ${e} ${this.model}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "type", label: "Type", value: this.type, type: "select", options: ["NPN", "PNP"] },
      { key: "model", label: "Model", value: this.model, type: "string" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "type") this.type = value as BJTType;
    if (key === "model") this.model = String(value);
  }

  clone(): BJT {
    const q = new BJT(this.id, this.label, { ...this.position }, this.type, this.model);
    q.rotation = this.rotation;
    return q;
  }
}

export type MOSFETType = "NMOS" | "PMOS";

export class MOSFET extends Semiconductor {
  type: MOSFETType;

  constructor(id: string, label: string, position?: Point, type: MOSFETType = "NMOS", model = "MNMOS") {
    super(id, label, model, position);
    this.type = type;
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-d`, "drain", { x: 0, y: -40 }),
      new Port(`${this.id}-g`, "gate", { x: -40, y: 0 }),
      new Port(`${this.id}-s`, "source", { x: 0, y: 40 }),
      new Port(`${this.id}-b`, "bulk", { x: 20, y: 0 }),
    ];
  }

  getNetlistLine(): string {
    const d = this.nodeOrGnd(this.ports[0].netId);
    const g = this.nodeOrGnd(this.ports[1].netId);
    const s = this.nodeOrGnd(this.ports[2].netId);
    const b = this.nodeOrGnd(this.ports[3].netId);
    return `${this.label} ${d} ${g} ${s} ${b} ${this.model}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "type", label: "Type", value: this.type, type: "select", options: ["NMOS", "PMOS"] },
      { key: "model", label: "Model", value: this.model, type: "string" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "type") this.type = value as MOSFETType;
    if (key === "model") this.model = String(value);
  }

  clone(): MOSFET {
    const m = new MOSFET(this.id, this.label, { ...this.position }, this.type, this.model);
    m.rotation = this.rotation;
    return m;
  }
}
