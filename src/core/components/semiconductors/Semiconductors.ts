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
    return `${this.spiceRef("D")} ${a} ${k} ${this.model}`;
  }

  /** Generic silicon-diode fallback (1N4148-like) so a bare diode simulates. */
  getModelDirective(): string | null {
    return `.model ${this.model} D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 Tt=20n Bv=100 Ibv=100u)`;
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
    return `${this.spiceRef("Q")} ${c} ${b} ${e} ${this.model}`;
  }

  /**
   * Generic BJT fallback, used when the model name is defined nowhere else (a
   * freshly placed part, or a schematic naming a type we don't ship).
   *
   * Mirrors the general-purpose small-signal transistors in
   * `library/sub/Discretes.lib` — a 2N2222 for NPN, a 2N2907 for PNP — because
   * that is what an unqualified "transistor" in a teaching schematic means.
   *
   * `IKF` is the parameter that matters most here and the one the old
   * three-parameter fallback lacked. Without it the current gain never rolls off
   * at high collector current, so an output-characteristic sweep kept climbing
   * until it hit the load line instead of flattening out near 1 A: with
   * Ib = 20 mA it delivered 1.99 A where the real device manages 0.95 A.
   */
  getModelDirective(): string | null {
    return this.type === "PNP"
      ? `.model ${this.model} PNP(IS=1e-14 BF=200 VAF=80 IKF=0.4 ISE=1.2e-14 NE=1.6 BR=4 RB=12 RE=0.15 RC=0.6 CJC=8p CJE=30p TF=796p TR=20n XTB=1.5)`
      : `.model ${this.model} NPN(IS=1e-14 BF=200 VAF=100 IKF=0.3 ISE=1e-14 NE=1.5 BR=3 RB=10 RE=0.1 RC=0.3 CJC=8p CJE=25p TF=531p TR=10n XTB=1.5)`;
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
    return `${this.spiceRef("M")} ${d} ${g} ${s} ${b} ${this.model}`;
  }

  /**
   * Generic MOSFET fallback, mirroring the small-signal switches in
   * `library/sub/Discretes.lib` — a 2N7002 for N-channel, a BSS84 for P-channel.
   *
   * The old `Kp=20u` was not merely imprecise: at Vgs = 5 V it passed 0.09 mA
   * where a real 2N7002 passes ~155 mA, so nothing it switched could drive a
   * load. `KP` and `RD`/`RS` here are the values fitted to the datasheet
   * Rds(on) figures (see the shipped library and models.test).
   *
   * `KAPPA`, never `LAMBDA`: LAMBDA belongs to LEVEL 1, and in a LEVEL-3 model
   * ngspice does not ignore it but exits with "strtod: Invalid argument", which
   * reaches the user only as a run that never returns.
   */
  getModelDirective(): string | null {
    return this.type === "PMOS"
      ? `.model ${this.model} PMOS(LEVEL=3 VTO=-1.4 KP=0.16 GAMMA=0.6 PHI=0.6 KAPPA=0.2 RD=3.5 RS=3.5 CBD=10p CBS=10p TOX=1e-7)`
      : `.model ${this.model} NMOS(LEVEL=3 VTO=2.1 KP=0.4391 GAMMA=0.5 PHI=0.6 KAPPA=0.2 RD=0.45 RS=0.45 CBD=25p CBS=25p TOX=1e-7)`;
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
