export interface Point {
  x: number;
  y: number;
}

export interface Property {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  type: "number" | "string" | "select";
  options?: string[];
}

export class Port {
  readonly id: string;
  readonly name: string;
  readonly relativePosition: Point;
  netId: string | null = null;

  constructor(id: string, name: string, relativePosition: Point) {
    this.id = id;
    this.name = name;
    this.relativePosition = relativePosition;
  }

  connect(netId: string): void {
    this.netId = netId;
  }

  disconnect(): void {
    this.netId = null;
  }

  clone(): Port {
    const p = new Port(this.id, this.name, { ...this.relativePosition });
    p.netId = this.netId;
    return p;
  }
}
