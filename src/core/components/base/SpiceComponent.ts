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

  /**
   * Full persistable state. A superset of {@link getProperties}, which only
   * returns the fields the UI currently shows — a source in DC mode hides its
   * sine fields, so saving the property list alone silently dropped e.g. a
   * configured phase. Subclasses with hidden state override this.
   */
  serialize(): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const p of this.getProperties()) out[p.key] = p.value;
    if (this.valueExpr) out.valueExpr = this.valueExpr;
    return out;
  }

  /** Restore a {@link serialize} payload. */
  deserialize(props: Record<string, string | number>): void {
    for (const [key, value] of Object.entries(props)) {
      if (key === "valueExpr") this.valueExpr = String(value);
      else if (key !== "rawSpec") this.setProperty(key, value);
    }
    // rawSpec last: setProperty clears it (a UI edit overrides an imported spec),
    // so it must be re-applied after the structured fields are restored.
    if (typeof props.rawSpec === "string" && "rawSpec" in this) {
      (this as unknown as { rawSpec: string }).rawSpec = props.rawSpec;
    }
  }

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

  /**
   * Reference designator with the SPICE device letter guaranteed. ngspice keys a
   * device off the first letter of its name (R=resistor, C, L, V, I, D, Q, M,
   * X…), so a component the user named against convention — e.g. a resistor
   * labelled "U1" — must still emit a line starting with its own letter, or
   * ngspice mis-parses it (here "U…" as a lossy/URC line) and the whole
   * simulation fails. The letter is prepended only when the label doesn't
   * already start with it, so conventional names (R1, C2, …) are unchanged.
   */
  protected spiceRef(prefix: string): string {
    return this.label.toUpperCase().startsWith(prefix.toUpperCase())
      ? this.label
      : `${prefix}${this.label}`;
  }

  /** Netlist value token: the raw expression if set, else the numeric value. */
  protected fmtVal(numeric: number | string): string {
    return this.valueExpr ?? String(numeric);
  }
}
