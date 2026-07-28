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

/**
 * Take a port id apart into the component it belongs to and its handle.
 *
 * A port id is `<componentId>-<handle>`, and the split has to be on the *first*
 * dash: a component id never contains one (`comp_4`, `ground_1`, `junction_8`)
 * while a handle very much can. Splitting on the last dash — which four places
 * in the app used to do independently — works right up until a pin name *ends*
 * in a dash, and then it fails silently and in the worst possible way.
 *
 * `comp_4-In-` is the op-amp's inverting input. Cut at the last dash it yields
 * the component "comp_4-In", which does not exist, and an empty handle. Every
 * caller then took its "no such component" branch: the pin never became a route,
 * so a net name dropped on it bound to nothing, and the name the schematic
 * showed named no node at all. Measured on three converted sheets, where `N4`
 * sat exactly on the pin and resolved to nothing — the converter had placed it
 * correctly and the editor could not read it back.
 *
 * One helper rather than the split written out at each site, because the four
 * copies is how they came to disagree in the first place.
 */
export function splitPortId(portId: string): { componentId: string; handle: string } {
  const i = portId.indexOf("-");
  return i < 0
    ? { componentId: portId, handle: "" }
    : { componentId: portId.slice(0, i), handle: portId.slice(i + 1) };
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
