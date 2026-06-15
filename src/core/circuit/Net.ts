export class Net {
  readonly id: string;
  nodeLabel: string;
  readonly connectedPortIds: Set<string>;

  constructor(id: string, nodeLabel?: string) {
    this.id = id;
    this.nodeLabel = nodeLabel ?? id;
    this.connectedPortIds = new Set();
  }

  addPort(portId: string): void {
    this.connectedPortIds.add(portId);
  }

  removePort(portId: string): void {
    this.connectedPortIds.delete(portId);
  }

  get isEmpty(): boolean {
    return this.connectedPortIds.size === 0;
  }

  clone(): Net {
    const n = new Net(this.id, this.nodeLabel);
    this.connectedPortIds.forEach((pid) => n.connectedPortIds.add(pid));
    return n;
  }
}
