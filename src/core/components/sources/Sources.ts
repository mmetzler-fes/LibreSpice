import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export abstract class Source extends SpiceComponent {
  dcValue: number;
  acAmplitude: number;

  constructor(id: string, label: string, position?: Point, dcValue = 0, acAmplitude = 0) {
    super(id, label, position);
    this.dcValue = dcValue;
    this.acAmplitude = acAmplitude;
  }

  protected createPorts(): Port[] {
    return [
      new Port(`${this.id}-p`, "positive", { x: 0, y: -40 }),
      new Port(`${this.id}-n`, "negative", { x: 0, y: 40 }),
    ];
  }
}

export class VoltageSource extends Source {
  constructor(id: string, label: string, position?: Point, dcValue = 5) {
    super(id, label, position, dcValue);
  }

  getNetlistLine(): string {
    const p = this.nodeOrGnd(this.ports[0].netId);
    const n = this.nodeOrGnd(this.ports[1].netId);
    return `${this.label} ${p} ${n} DC ${this.dcValue} AC ${this.acAmplitude}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "dcValue", label: "DC Voltage", value: this.dcValue, unit: "V", type: "number" },
      { key: "acAmplitude", label: "AC Amplitude", value: this.acAmplitude, unit: "V", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "dcValue") this.dcValue = Number(value);
    if (key === "acAmplitude") this.acAmplitude = Number(value);
  }

  clone(): VoltageSource {
    const v = new VoltageSource(this.id, this.label, { ...this.position }, this.dcValue);
    v.acAmplitude = this.acAmplitude;
    v.rotation = this.rotation;
    return v;
  }
}

export class CurrentSource extends Source {
  constructor(id: string, label: string, position?: Point, dcValue = 1e-3) {
    super(id, label, position, dcValue);
  }

  getNetlistLine(): string {
    const p = this.nodeOrGnd(this.ports[0].netId);
    const n = this.nodeOrGnd(this.ports[1].netId);
    return `${this.label} ${p} ${n} DC ${this.dcValue} AC ${this.acAmplitude}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "dcValue", label: "DC Current", value: this.dcValue, unit: "A", type: "number" },
      { key: "acAmplitude", label: "AC Amplitude", value: this.acAmplitude, unit: "A", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "dcValue") this.dcValue = Number(value);
    if (key === "acAmplitude") this.acAmplitude = Number(value);
  }

  clone(): CurrentSource {
    const i = new CurrentSource(this.id, this.label, { ...this.position }, this.dcValue);
    i.acAmplitude = this.acAmplitude;
    i.rotation = this.rotation;
    return i;
  }
}

export class SineSource extends VoltageSource {
  frequency: number;
  amplitude: number;
  offset: number;

  constructor(id: string, label: string, position?: Point, amplitude = 1, frequency = 1000, offset = 0) {
    super(id, label, position, offset);
    this.amplitude = amplitude;
    this.frequency = frequency;
    this.offset = offset;
  }

  getNetlistLine(): string {
    const p = this.nodeOrGnd(this.ports[0].netId);
    const n = this.nodeOrGnd(this.ports[1].netId);
    return `${this.label} ${p} ${n} SIN(${this.offset} ${this.amplitude} ${this.frequency})`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "amplitude", label: "Amplitude", value: this.amplitude, unit: "V", type: "number" },
      { key: "frequency", label: "Frequency", value: this.frequency, unit: "Hz", type: "number" },
      { key: "offset", label: "Offset", value: this.offset, unit: "V", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "amplitude") this.amplitude = Number(value);
    if (key === "frequency") this.frequency = Number(value);
    if (key === "offset") this.offset = Number(value);
  }

  clone(): SineSource {
    const s = new SineSource(this.id, this.label, { ...this.position }, this.amplitude, this.frequency, this.offset);
    s.rotation = this.rotation;
    return s;
  }
}

export class PulseSource extends VoltageSource {
  initialValue: number;
  pulsedValue: number;
  delay: number;
  riseTime: number;
  fallTime: number;
  pulseWidth: number;
  period: number;

  constructor(
    id: string,
    label: string,
    position?: Point,
    initialValue = 0,
    pulsedValue = 5,
    period = 1e-3,
  ) {
    super(id, label, position, initialValue);
    this.initialValue = initialValue;
    this.pulsedValue = pulsedValue;
    this.delay = 0;
    this.riseTime = 1e-9;
    this.fallTime = 1e-9;
    this.pulseWidth = period / 2;
    this.period = period;
  }

  getNetlistLine(): string {
    const p = this.nodeOrGnd(this.ports[0].netId);
    const n = this.nodeOrGnd(this.ports[1].netId);
    return (
      `${this.label} ${p} ${n} PULSE(${this.initialValue} ${this.pulsedValue} ` +
      `${this.delay} ${this.riseTime} ${this.fallTime} ${this.pulseWidth} ${this.period})`
    );
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "initialValue", label: "Initial Value", value: this.initialValue, unit: "V", type: "number" },
      { key: "pulsedValue", label: "Pulsed Value", value: this.pulsedValue, unit: "V", type: "number" },
      { key: "period", label: "Period", value: this.period, unit: "s", type: "number" },
      { key: "pulseWidth", label: "Pulse Width", value: this.pulseWidth, unit: "s", type: "number" },
      { key: "riseTime", label: "Rise Time", value: this.riseTime, unit: "s", type: "number" },
      { key: "fallTime", label: "Fall Time", value: this.fallTime, unit: "s", type: "number" },
      { key: "delay", label: "Delay", value: this.delay, unit: "s", type: "number" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    const num = Number(value);
    if (key === "initialValue") this.initialValue = num;
    if (key === "pulsedValue") this.pulsedValue = num;
    if (key === "period") this.period = num;
    if (key === "pulseWidth") this.pulseWidth = num;
    if (key === "riseTime") this.riseTime = num;
    if (key === "fallTime") this.fallTime = num;
    if (key === "delay") this.delay = num;
  }

  clone(): PulseSource {
    const ps = new PulseSource(this.id, this.label, { ...this.position }, this.initialValue, this.pulsedValue, this.period);
    ps.delay = this.delay;
    ps.riseTime = this.riseTime;
    ps.fallTime = this.fallTime;
    ps.pulseWidth = this.pulseWidth;
    ps.rotation = this.rotation;
    return ps;
  }
}
