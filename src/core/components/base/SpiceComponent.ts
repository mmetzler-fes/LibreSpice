import { Port, type Point, type Property } from "./Port.js";

export type Rotation = 0 | 90 | 180 | 270;

export abstract class SpiceComponent {
  readonly id: string;
  label: string;
  position: Point;
  rotation: Rotation;
  readonly ports: Port[];
  /**
   * Raw value expression (e.g. `{Cvar}` or `2*Cbase`) that overrides the numeric
   * value in the netlist, enabling `.param`/`.step` sweeps. Undefined = use the
   * component's numeric field.
   */
  valueExpr?: string;

  constructor(id: string, label: string, position: Point = { x: 0, y: 0 }) {
    this.id = id;
    this.label = label;
    this.position = position;
    this.rotation = 0;
    this.ports = this.createPorts();
  }

  protected abstract createPorts(): Port[];

  abstract getNetlistLine(): string;

  /**
   * A fallback `.model` directive so the device simulates even when no library
   * model is imported. Emitted by the netlist generator only if nothing else
   * (an imported library or a user directive) already defines the model name.
   * Returns `null` for components that don't reference a model.
   */
  getModelDirective(): string | null {
    return null;
  }

  /**
   * The net name this component forces onto its connected net (a net-label /
   * terminal). Nets that share a name become one node in the netlist, which is
   * how distant parts connect by name. Returns `null` for normal components.
   */
  getNetLabel(): string | null {
    return null;
  }

  abstract getProperties(): Property[];

  abstract setProperty(key: string, value: string | number): void;

  abstract clone(): SpiceComponent;

  getPort(name: string): Port | undefined {
    return this.ports.find((p) => p.name === name);
  }

  getPortIds(): string[] {
    return this.ports.map((p) => p.id);
  }

  rotate(degrees: 90 | 180 | 270 = 90): void {
    this.rotation = ((this.rotation + degrees) % 360) as Rotation;
  }

  protected nodeOrGnd(netId: string | null): string {
    return netId ?? "0";
  }

  /** Netlist value token: the raw expression if set, else the numeric value. */
  protected fmtVal(numeric: number | string): string {
    return this.valueExpr ?? String(numeric);
  }
}
