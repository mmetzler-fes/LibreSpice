import type { MsSchematic, MsPart, Pt } from "./model.js";

/**
 * Reading Multisim Live's `.msjs` into the neutral schematic model.
 *
 * The file is a length-prefixed JSON blob describing a whole session:
 *
 *   blueprints.components       part *types* (name, refdes prefix, conn↔pin map)
 *   blueprints.symbols          SVG artwork; pin coordinates live in `oecl:` attrs
 *   sheettemplates[].template   the placed schematic: parts, wires, connectors
 *   sheettemplates[].instances  per-part refdes and model parameter values
 *
 * All four are needed to say what one placed part *is*, which is why the reading
 * happens here in one place instead of inside the converter: a part arrives with
 * its type named, its pins already in coordinates and its parameters flattened,
 * and nothing downstream has to know that a catalogue and some SVG were involved.
 */

/** Unpack the container: `msjs-2.0`, a little-endian length, then the JSON. */
export function readMsjs(buffer: ArrayBuffer): any {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
  if (magic !== "msjs-2.0") throw new Error("Keine msjs-2.0-Datei");
  const length = new DataView(buffer).getUint32(8, true);
  return JSON.parse(new TextDecoder("utf-8").decode(bytes.subarray(12, 12 + length)));
}

/**
 * Pin positions from a symbol's SVG, by pin id.
 *
 * The artwork carries an outer scale/translate and one group per pin; the
 * connection point is the inner group marked `oecl:pin`. The `/10` brings it
 * into the same units the placement matrix works in.
 */
function symbolPins(svg: string): Record<string, Pt> {
  const outer = /<g transform="scale\(([-\d.]+)\)\s*translate\(([-\d.]+),\s*([-\d.]+)\)"/.exec(svg);
  const s = outer ? parseFloat(outer[1]) : 1;
  const tx = outer ? parseFloat(outer[2]) : 0;
  const ty = outer ? parseFloat(outer[3]) : 0;

  const pins: Record<string, Pt> = {};
  const groups = svg.split(/<g oecl:pinid="/).slice(1);
  for (const g of groups) {
    const id = g.slice(0, g.indexOf('"'));
    const m = /<g[^>]*transform="translate\(([-\d.]+),\s*([-\d.]+)\)"[^>]*oecl:pin=/.exec(g);
    if (!m) continue;
    pins[id] = [((parseFloat(m[1]) + tx) * s) / 10, ((parseFloat(m[2]) + ty) * s) / 10];
  }
  return pins;
}

/** Model and instance parameters, flattened to `name → value`. */
function flattenParams(...levels: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const level of levels) {
    for (const params of Object.values(level ?? {})) {
      for (const [k, v] of Object.entries((params ?? {}) as Record<string, any>)) {
        if (v?.stringvalue !== undefined) out[k] = v.stringvalue;
      }
    }
  }
  return out;
}

/** The neutral schematic a `.msjs` document describes. */
export function msjsToSchematic(doc: any): MsSchematic {
  const tpl = doc.sheettemplates?.[0];
  if (!tpl) throw new Error("no sheet template");
  const sheet = tpl.template;

  const blueprints = doc.blueprints?.components ?? {};
  const symbols = doc.blueprints?.symbols ?? {};

  // Instance data (refdes, parameters, chosen symbol) is keyed by the placed
  // part's guid; free text is keyed by its own.
  const instances: Record<string, any> = {};
  const textValue: Record<string, string> = {};
  for (const inst of tpl.instances ?? []) {
    for (const cs of inst.componentsections ?? []) instances[cs.guid] = cs;
    for (const t of inst.texts ?? []) textValue[t.guid] = t.variableName;
  }

  const parts: MsPart[] = [];
  for (const part of sheet.parts ?? []) {
    const bp = blueprints[part.component]?.component;
    if (!bp) continue;                                  // a type we have no entry for
    const inst = instances[part.guid];

    // Which artwork this instance uses, and how its connections map onto that
    // artwork's pins. Resolved here so a part carries its pins as coordinates.
    const symId = inst?.activesymbol;
    const svgPins = symbolPins(symbols[symId]?.svg ?? "");
    const pins: Record<string, Pt> = {};
    const connPin: Record<string, string> = {};
    for (const sc of bp.symbolConfigurations ?? []) {
      for (const sec of sc.sections ?? []) {
        if (sec.id !== symId) continue;
        for (const cp of sec.connPinMap ?? []) {
          connPin[cp.connName] = cp.symbolPinID;
          const p = svgPins[cp.symbolPinID];
          if (p) pins[cp.connName] = p;
        }
      }
    }

    parts.push({
      guid: part.guid,
      typeName: bp.name,
      refdes: { prefix: inst?.refdes?.prefix, number: inst?.refdes?.number },
      matrix: part.matrix ?? {},
      pins,
      pinsById: svgPins,
      connPin,
      connNames: (bp.connections ?? []).map((c: any) => c.connName),
      symbolDescription: symbols[symId]?.description ?? "",
      params: flattenParams(inst?.modeldefinitiondata, inst?.modelinstancedata),
    });
  }

  const texts = (sheet.texts ?? [])
    .filter((t: any) => t.standalone && t.visibility && textValue[t.guid])
    .map((t: any) => ({ text: textValue[t.guid], position: [t.matrix?.e ?? 0, t.matrix?.f ?? 0] as Pt }));

  return {
    parts,
    connectors: (sheet.connectors ?? []).map((c: any) => ({
      guid: c.guid, kind: c.component, matrix: c.matrix ?? {},
    })),
    wires: (sheet.wires ?? []).map((w: any) => ({ path: (w.path ?? []) as Pt[] })),
    junctions: (sheet.junctions ?? []).map((j: any): Pt => [j.position.x, j.position.y]),
    texts,
    nets: (doc.nets ?? []).map((n: any) => ({
      name: n.name,
      pins: (n.objects ?? []).map((o: any) => ({ component: o.component, pin: o.pin })),
    })),
  };
}
