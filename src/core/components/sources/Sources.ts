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

export type VSourceType = "DC" | "Sine" | "Pulse";

/**
 * Generalized voltage source. A single component whose waveform is selected via
 * the `sourceType` property (DC / Sine / Pulse). Optional parasitic series
 * resistance and parallel capacitance are emitted as extra netlist elements.
 */
export class VoltageSource extends Source {
  sourceType: VSourceType = "DC";

  // Pulse parameters
  pV1 = 0; pV2 = 5; pTd = 0; pTr = 1e-9; pTf = 1e-9; pPw = 0.5e-3; pPer = 1e-3; pNp = 0;
  // Sine parameters
  sOffset = 0; sAmpl = 1; sFreq = 1000; sTd = 0; sTheta = 0; sPhi = 0; sNcycles = 0;
  // Parasitics (shared by all source types)
  seriesR = 0; parallelC = 0; showParasitics: "yes" | "no" = "no";

  constructor(id: string, label: string, position?: Point, dcValue = 5) {
    super(id, label, position, dcValue);
  }

  /** The SPICE source specification (after the node names). */
  protected spec(): string {
    switch (this.sourceType) {
      case "Sine":
        return `SIN(${this.sOffset} ${this.sAmpl} ${this.sFreq} ${this.sTd} ${this.sTheta} ${this.sPhi})`;
      case "Pulse":
        return `PULSE(${this.pV1} ${this.pV2} ${this.pTd} ${this.pTr} ${this.pTf} ${this.pPw} ${this.pPer}${this.pNp > 0 ? ` ${this.pNp}` : ""})`;
      default:
        return `DC ${this.dcValue}${this.acAmplitude ? ` AC ${this.acAmplitude}` : ""}`;
    }
  }

  getNetlistLine(): string {
    const pNode = this.nodeOrGnd(this.ports[0].netId);
    const nNode = this.nodeOrGnd(this.ports[1].netId);
    const lines: string[] = [];
    // Series resistance: insert an internal node between + terminal and source.
    let srcPos = pNode;
    if (this.seriesR > 0) {
      const mid = `${this.label}_a`;
      lines.push(`R${this.label}_ser ${pNode} ${mid} ${this.seriesR}`);
      srcPos = mid;
    }
    lines.push(`${this.label} ${srcPos} ${nNode} ${this.spec()}`);
    if (this.parallelC > 0) lines.push(`C${this.label}_par ${pNode} ${nNode} ${this.parallelC}`);
    return lines.join("\n");
  }

  getProperties(): Property[] {
    const props: Property[] = [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "sourceType", label: "Source Type", value: this.sourceType, type: "select", options: ["DC", "Sine", "Pulse"] },
    ];
    if (this.sourceType === "Sine") {
      props.push(
        { key: "sOffset", label: "DC offset", value: this.sOffset, unit: "V", type: "number" },
        { key: "sAmpl", label: "Amplitude", value: this.sAmpl, unit: "V", type: "number" },
        { key: "sFreq", label: "Frequency", value: this.sFreq, unit: "Hz", type: "number" },
        { key: "sTd", label: "Tdelay", value: this.sTd, unit: "s", type: "number" },
        { key: "sTheta", label: "Theta", value: this.sTheta, unit: "1/s", type: "number" },
        { key: "sPhi", label: "Phi", value: this.sPhi, unit: "°", type: "number" },
        { key: "sNcycles", label: "Ncycles", value: this.sNcycles, type: "number" },
      );
    } else if (this.sourceType === "Pulse") {
      props.push(
        { key: "pV1", label: "Vinitial", value: this.pV1, unit: "V", type: "number" },
        { key: "pV2", label: "Von", value: this.pV2, unit: "V", type: "number" },
        { key: "pTd", label: "Tdelay", value: this.pTd, unit: "s", type: "number" },
        { key: "pTr", label: "Trise", value: this.pTr, unit: "s", type: "number" },
        { key: "pTf", label: "Tfall", value: this.pTf, unit: "s", type: "number" },
        { key: "pPw", label: "Ton (width)", value: this.pPw, unit: "s", type: "number" },
        { key: "pPer", label: "Tperiod", value: this.pPer, unit: "s", type: "number" },
        { key: "pNp", label: "Ncycles", value: this.pNp, type: "number" },
      );
    } else {
      props.push(
        { key: "dcValue", label: "DC Value", value: this.dcValue, unit: "V", type: "number" },
        { key: "acAmplitude", label: "AC Amplitude", value: this.acAmplitude, unit: "V", type: "number" },
      );
    }
    props.push(
      { key: "seriesR", label: "Series Resistance", value: this.seriesR, unit: "Ω", type: "number" },
      { key: "parallelC", label: "Parallel Capacitance", value: this.parallelC, unit: "F", type: "number" },
      { key: "showParasitics", label: "Show parasitics", value: this.showParasitics, type: "select", options: ["no", "yes"] },
    );
    return props;
  }

  setProperty(key: string, value: string | number): void {
    const num = Number(value);
    switch (key) {
      case "label": this.label = String(value); break;
      case "sourceType": this.sourceType = String(value) as VSourceType; break;
      case "dcValue": this.dcValue = num; break;
      case "acAmplitude": this.acAmplitude = num; break;
      case "pV1": this.pV1 = num; break;
      case "pV2": this.pV2 = num; break;
      case "pTd": this.pTd = num; break;
      case "pTr": this.pTr = num; break;
      case "pTf": this.pTf = num; break;
      case "pPw": this.pPw = num; break;
      case "pPer": this.pPer = num; break;
      case "pNp": this.pNp = num; break;
      case "sOffset": this.sOffset = num; break;
      case "sAmpl": this.sAmpl = num; break;
      case "sFreq": this.sFreq = num; break;
      case "sTd": this.sTd = num; break;
      case "sTheta": this.sTheta = num; break;
      case "sPhi": this.sPhi = num; break;
      case "sNcycles": this.sNcycles = num; break;
      case "seriesR": this.seriesR = num; break;
      case "parallelC": this.parallelC = num; break;
      case "showParasitics": this.showParasitics = value === "yes" ? "yes" : "no"; break;
    }
  }

  clone(): VoltageSource {
    const v = new VoltageSource(this.id, this.label, { ...this.position }, this.dcValue);
    Object.assign(v, {
      sourceType: this.sourceType, acAmplitude: this.acAmplitude,
      pV1: this.pV1, pV2: this.pV2, pTd: this.pTd, pTr: this.pTr, pTf: this.pTf, pPw: this.pPw, pPer: this.pPer, pNp: this.pNp,
      sOffset: this.sOffset, sAmpl: this.sAmpl, sFreq: this.sFreq, sTd: this.sTd, sTheta: this.sTheta, sPhi: this.sPhi, sNcycles: this.sNcycles,
      seriesR: this.seriesR, parallelC: this.parallelC, showParasitics: this.showParasitics,
      rotation: this.rotation,
    });
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
