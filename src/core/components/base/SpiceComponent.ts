import { Port, type Point, type Property } from "./Port.js";

export type Rotation = 0 | 90 | 180 | 270;

export abstract class SpiceComponent {
  readonly id: string;
  label: string;
  position: Point;
  rotation: Rotation;
  readonly ports: Port[];

  constructor(id: string, label: string, position: Point = { x: 0, y: 0 }) {
    this.id = id;
    this.label = label;
    this.position = position;
    this.rotation = 0;
    this.ports = this.createPorts();
  }

  protected abstract createPorts(): Port[];

  abstract getNetlistLine(): string;

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
}
