import { SpiceComponent } from "../base/SpiceComponent.js";
import { Port, type Point, type Property } from "../base/Port.js";

export class Ground extends SpiceComponent {
  constructor(id: string, position?: Point) {
    super(id, "0", position);
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-gnd`, "gnd", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getProperties(): Property[] {
    return [];
  }

  setProperty(_key: string, _value: string | number): void {}

  clone(): Ground {
    const g = new Ground(this.id, { ...this.position });
    g.rotation = this.rotation;
    return g;
  }
}

/**
 * Net-label terminal (LTSpice `FLAG name`): a single-pin connector that names
 * the net it touches. It emits no device line — its only effect is to label its
 * net, so any two terminals with the same name become one node (connecting
 * distant parts) and the potential there can be probed by that name.
 */
export class NetLabel extends SpiceComponent {
  constructor(id: string, label: string, position?: Point) {
    super(id, label || "NET", position);
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-t`, "t", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getNetLabel(): string | null {
    const name = this.label.trim();
    return name ? name : null;
  }

  getProperties(): Property[] {
    return [{ key: "label", label: "Net name", value: this.label, type: "string" }];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
  }

  clone(): NetLabel {
    const n = new NetLabel(this.id, this.label, { ...this.position });
    n.rotation = this.rotation;
    return n;
  }
}

/**
 * Port type of a net connector, spelled exactly as LTSpice writes it in an
 * `IOPIN` line. `None` has no `IOPIN` at all — it is a bare `FLAG`, LTSpice's
 * "Port Type: None" — so the value doubles as the export mapping.
 */
export type PortType = "None" | "In" | "Out" | "BiDir";

export const PORT_TYPES: PortType[] = ["None", "In", "Out", "BiDir"];

/**
 * Net connector (LTSpice `FLAG name` + `IOPIN x y In|Out|BiDir`): a net label
 * that additionally declares the net as an interface to the outside, so it
 * becomes a pin when the sheet is used as a subcircuit.
 *
 * Electrically identical to a {@link NetLabel} — it names its net and nothing
 * else — but kept as its own component because LTSpice stores the two
 * differently, and because it carries a direction the label does not.
 */
export class NetConnector extends SpiceComponent {
  portType: PortType;

  constructor(id: string, label: string, position?: Point, portType: PortType = "BiDir") {
    super(id, label || "PORT", position);
    this.portType = portType;
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-t`, "t", { x: 0, y: 0 })];
  }

  getNetlistLine(): string {
    return "";
  }

  getNetLabel(): string | null {
    const name = this.label.trim();
    return name ? name : null;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Net name", value: this.label, type: "string" },
      { key: "portType", label: "Port type", value: this.portType, type: "select", options: PORT_TYPES },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    else if (key === "portType" && PORT_TYPES.includes(value as PortType)) {
      this.portType = value as PortType;
    }
  }

  clone(): NetConnector {
    const n = new NetConnector(this.id, this.label, { ...this.position }, this.portType);
    n.rotation = this.rotation;
    return n;
  }
}

/**
 * Five-terminal operational amplifier backed by the LTSpice UniversalOpAmp2
 * symbol. Emits an `X` subcircuit call; the referenced model must be available
 * (e.g. imported via the library) for the circuit to simulate.
 */
export class OpAmp extends SpiceComponent {
  model: string;

  // `level2` is the subcircuit name defined by the shipped UniversalOpAmp2.lib
  // (matching the LTSpice symbol's `SYMATTR SpiceModel level2`).
  constructor(id: string, label: string, position?: Point, model = "level2") {
    super(id, label, position);
    this.model = model;
  }

  protected createPorts(): Port[] {
    // SPICE pin order: In+, In-, V+, V-, OUT (matches UniversalOpAmp2).
    return [
      new Port(`${this.id}-inp`, "In+", { x: -32, y: 16 }),
      new Port(`${this.id}-inn`, "In-", { x: -32, y: -16 }),
      new Port(`${this.id}-vcc`, "V+", { x: 0, y: -32 }),
      new Port(`${this.id}-vee`, "V-", { x: 0, y: 32 }),
      new Port(`${this.id}-out`, "OUT", { x: 32, y: 0 }),
    ];
  }

  getNetlistLine(): string {
    const nodes = this.ports.map((p) => this.nodeOrGnd(p.netId)).join(" ");
    const ref = this.label.startsWith("X") ? this.label : `X${this.label}`;
    return `${ref} ${nodes} ${this.model}`;
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

  clone(): OpAmp {
    const o = new OpAmp(this.id, this.label, { ...this.position }, this.model);
    o.rotation = this.rotation;
    return o;
  }
}

export class CustomSubcircuit extends SpiceComponent {
  spiceModel: string;
  portNames: string[];
  /**
   * Instance parameters for the `X` line, as SPICE spells them
   * (`Rtot=10k wiper=0.5`) — LTSpice's `SYMATTR SpiceLine`, which is where a
   * symbol declares its defaults and where a `.asc` carries the edited values.
   *
   * Without this a `.subckt` with `params:` could only ever run on its defaults,
   * so a sheet with two potentiometers had one wiper position between them. It
   * is kept as the raw string rather than a parsed map because the values are
   * SPICE expressions ({R1*2}, a `.param` name), not numbers.
   */
  params: string;

  constructor(
    id: string,
    label: string,
    position?: Point,
    spiceModel = "",
    portNames: string[] = ["in", "out", "gnd"],
    params = "",
  ) {
    super(id, label, position);
    this.spiceModel = spiceModel;
    this.portNames = portNames;
    this.params = params;
    // The base constructor calls createPorts() before portNames is assigned, so
    // the real ports are (re)built here once portNames is known.
    this.ports.length = 0;
    this.ports.push(...CustomSubcircuit.buildPorts(id, portNames));
  }

  protected createPorts(): Port[] {
    // portNames is undefined during super() construction – ports are populated
    // by the constructor once it is set (see above).
    return CustomSubcircuit.buildPorts(this.id, this.portNames ?? []);
  }

  private static buildPorts(id: string, portNames: string[]): Port[] {
    return portNames.map(
      (name, i) =>
        new Port(`${id}-${name}`, name, { x: i % 2 === 0 ? -50 : 50, y: (i * 30) - 30 }),
    );
  }

  getNetlistLine(): string {
    const nodes = this.ports.map((p) => this.nodeOrGnd(p.netId)).join(" ");
    const subcktName = this.spiceModel.split("\n")[0]?.match(/\.subckt\s+(\S+)/i)?.[1] ?? "UNKNOWN";
    const params = this.params.trim();
    return `${this.label} ${nodes} ${subcktName}${params ? ` ${params}` : ""}`;
  }

  getProperties(): Property[] {
    return [
      { key: "label", label: "Reference", value: this.label, type: "string" },
      { key: "spiceModel", label: "SPICE Model", value: this.spiceModel, type: "string" },
      { key: "params", label: "Parameter", value: this.params, type: "string" },
    ];
  }

  setProperty(key: string, value: string | number): void {
    if (key === "label") this.label = String(value);
    if (key === "spiceModel") this.spiceModel = String(value);
    if (key === "params") this.params = String(value);
  }

  clone(): CustomSubcircuit {
    const c = new CustomSubcircuit(this.id, this.label, { ...this.position }, this.spiceModel, [...this.portNames], this.params);
    c.rotation = this.rotation;
    return c;
  }
}

/**
 * A point where wires meet that is not a part's pin.
 *
 * Our wires are edges between two pins, which is what makes them follow the
 * parts they are drawn to — an edge references the pin, not a coordinate, so
 * moving a part takes its wires along. A `.asc` wire has no such notion: it is
 * four numbers, and it may perfectly well end somewhere that is not a pin at
 * all. The stub between a part and a net name is exactly that shape.
 *
 * Such a segment used to be set aside as raw geometry, drawn by nobody and
 * editable by no one, under the name "orphan wire". The name was wrong twice
 * over: of the 176 in the bundled examples only two were actually alone, and the
 * rest were ordinary wires in the middle of a network — set apart purely because
 * our data structure could not hold them.
 *
 * A junction is the missing pin. It sits where the wire ends, carries one port
 * and nothing else: no symbol, no netlist line, no properties. With it every
 * wire is an ordinary edge again, and the category disappears rather than being
 * given a second implementation of everything a wire can do.
 */
export class Junction extends SpiceComponent {
  constructor(id: string, position?: Point) {
    super(id, "", position);
  }

  protected createPorts(): Port[] {
    return [new Port(`${this.id}-j`, "j", { x: 0, y: 0 })];
  }

  /** Nothing: a junction is a place, not a device. */
  getNetlistLine(): string {
    return "";
  }

  getProperties(): Property[] {
    return [];
  }

  setProperty(): void { /* nothing to set */ }

  clone(): Junction {
    const j = new Junction(this.id, { ...this.position });
    j.rotation = this.rotation;
    return j;
  }
}
