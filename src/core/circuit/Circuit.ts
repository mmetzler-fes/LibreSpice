import type { SpiceComponent } from "../components/base/SpiceComponent.js";
import { Ground } from "../components/special/Special.js";
import { Net } from "./Net.js";

export class Circuit {
  readonly components: Map<string, SpiceComponent> = new Map();
  readonly nets: Map<string, Net> = new Map();
  private _netCounter = 1;

  addComponent(component: SpiceComponent): void {
    this.components.set(component.id, component);
    if (component instanceof Ground) {
      component.ports[0].connect("0");
      this._ensureNet("0", "GND");
      this.nets.get("0")!.addPort(component.ports[0].id);
    }
  }

  removeComponent(id: string): void {
    const component = this.components.get(id);
    if (!component) return;
    for (const port of component.ports) {
      if (port.netId) this._disconnectPort(port.id, port.netId);
    }
    this.components.delete(id);
  }

  connectPorts(portIdA: string, portIdB: string): string {
    const portA = this._findPort(portIdA);
    const portB = this._findPort(portIdB);
    if (!portA || !portB) throw new Error(`Port not found: ${portIdA} or ${portIdB}`);

    if (portA.netId && portA.netId === portB.netId) return portA.netId;

    if (portA.netId && portB.netId) {
      // The ground net "0" must always survive a merge so the circuit keeps a
      // single ground node (and the netlist keeps referencing node 0).
      if (portB.netId === "0") return this._mergeNets("0", portA.netId);
      return this._mergeNets(portA.netId, portB.netId);
    }

    const existingNetId = portA.netId ?? portB.netId;
    const netId = existingNetId ?? this._createNetId();
    const net = this._ensureNet(netId);
    portA.connect(netId);
    portB.connect(netId);
    net.addPort(portIdA);
    net.addPort(portIdB);
    return netId;
  }

  disconnectPorts(portIdA: string, portIdB: string): void {
    const portA = this._findPort(portIdA);
    const portB = this._findPort(portIdB);
    if (!portA || !portB || !portA.netId) return;

    const netId = portA.netId;
    const net = this.nets.get(netId);
    if (!net) return;

    net.removePort(portIdA);
    net.removePort(portIdB);
    portA.disconnect();
    portB.disconnect();

    if (net.isEmpty) this.nets.delete(netId);
  }

  clear(): void {
    this.components.clear();
    this.resetNets();
  }

  /**
   * Drop every net and start numbering again from one.
   *
   * The counter has to go back with them. A rebuild derives the nets afresh from
   * the wiring, so the *same* net comes out with a new id every time — and while
   * the ids were being minted from a counter that only ever went up, two
   * consecutive rebuilds of an untouched schematic produced entirely different
   * ones. On a six-net sheet the names had climbed to `net94` by the time anyone
   * looked, which is what put a reader on to this.
   *
   * That matters beyond the odd name. An unnamed net *is* its id as far as the
   * netlist and the waveform names are concerned, so a trace plotted against one
   * stopped resolving the moment anything was touched — and nothing that wants to
   * remember a net across an edit could do so at all.
   *
   * With the reset the ids are a function of the circuit rather than of how often
   * it has been rebuilt: identical wiring, identical numbering. Nothing stores
   * them (`.asc` has no net ids either — LTSpice derives its nets from the
   * geometry the same way), so nothing has to migrate.
   */
  resetNets(): void {
    this.nets.clear();
    this._netCounter = 1;
  }

  private _ensureNet(id: string, label?: string): Net {
    if (!this.nets.has(id)) {
      this.nets.set(id, new Net(id, label ?? id));
    }
    return this.nets.get(id)!;
  }

  private _createNetId(): string {
    return `net${this._netCounter++}`;
  }

  private _mergeNets(keepId: string, removeId: string): string {
    const keepNet = this.nets.get(keepId)!;
    const removeNet = this.nets.get(removeId);
    if (!removeNet) return keepId;

    for (const portId of removeNet.connectedPortIds) {
      const port = this._findPort(portId);
      if (port) port.connect(keepId);
      keepNet.addPort(portId);
    }
    this.nets.delete(removeId);
    return keepId;
  }

  private _disconnectPort(portId: string, netId: string): void {
    const net = this.nets.get(netId);
    if (!net) return;
    net.removePort(portId);
    if (net.isEmpty) this.nets.delete(netId);
  }

  private _findPort(portId: string) {
    for (const component of this.components.values()) {
      const port = component.ports.find((p) => p.id === portId);
      if (port) return port;
    }
    return undefined;
  }
}
