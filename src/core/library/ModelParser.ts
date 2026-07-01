import type {
  LibraryEntry,
  ModelDeviceClass,
  ParseResult,
  SpiceModelDef,
  SubcircuitDef,
} from "./types.js";

/**
 * Maps a raw `.model` type token to the device class we can represent visually.
 * LTSpice accepts a number of aliases (e.g. `VDMOS` for vertical MOSFETs).
 */
const TYPE_TO_CLASS: Record<string, ModelDeviceClass> = {
  D: "diode",
  NPN: "bjt_npn",
  PNP: "bjt_pnp",
  NMOS: "mosfet_n",
  PMOS: "mosfet_p",
  VDMOS: "mosfet_n",
  NJF: "jfet",
  PJF: "jfet",
  R: "resistor",
  C: "capacitor",
  L: "inductor",
  RES: "resistor",
  CAP: "capacitor",
  IND: "inductor",
  SW: "unknown",
  CSW: "unknown",
};

/**
 * Well-known parameter names per device class. Parameters outside these sets are
 * still preserved, but flagged as warnings so the import never aborts on an
 * unfamiliar key (per the "ignore unknown params with a warning" requirement).
 */
const KNOWN_PARAMS: Partial<Record<ModelDeviceClass, Set<string>>> = {
  diode: new Set(["IS", "RS", "N", "CJO", "CJ0", "M", "VJ", "BV", "IBV", "TT", "EG", "XTI", "FC", "KF", "AF"]),
  bjt_npn: new Set(["IS", "BF", "BR", "NF", "NR", "VAF", "VAR", "IKF", "IKR", "ISE", "ISC", "NE", "NC", "RB", "RC", "RE", "CJE", "CJC", "CJS", "VJE", "VJC", "TF", "TR", "EG", "XTI", "XTB"]),
  mosfet_n: new Set(["VTO", "KP", "GAMMA", "PHI", "LAMBDA", "RD", "RS", "RG", "CBD", "CBS", "CGSO", "CGDO", "CGBO", "TOX", "NSUB", "LEVEL", "W", "L", "RDS", "VDS", "RG_", "MFG"]),
  jfet: new Set(["VTO", "BETA", "LAMBDA", "RD", "RS", "CGS", "CGD", "PB", "IS", "KF", "AF"]),
  resistor: new Set(["R", "TC1", "TC2", "TCE"]),
  capacitor: new Set(["C", "TC1", "TC2", "VC1", "VC2"]),
  inductor: new Set(["L", "TC1", "TC2"]),
};

KNOWN_PARAMS.bjt_pnp = KNOWN_PARAMS.bjt_npn;
KNOWN_PARAMS.mosfet_p = KNOWN_PARAMS.mosfet_n;

/**
 * Parses raw LTSpice library text (one or more `.model` / `.subckt` directives)
 * into structured entries. Tolerant of mixed case, line continuations (`+`),
 * inline `;`/`*` comments and parameters with or without surrounding parens.
 */
export class ModelParser {
  static parse(content: string): ParseResult {
    const warnings: string[] = [];
    const entries: LibraryEntry[] = [];
    const logical = ModelParser.toLogicalLines(content);

    for (let i = 0; i < logical.length; i++) {
      const line = logical[i];
      const lower = line.toLowerCase();

      if (lower.startsWith(".model")) {
        const entry = ModelParser.parseModel(line);
        if (entry) entries.push(entry);
        else warnings.push(`Could not parse .model line: ${line}`);
      } else if (lower.startsWith(".subckt")) {
        // Gather the block until the matching .ends (already merged into one
        // logical line per physical line, so scan forward).
        const block: string[] = [line];
        let j = i + 1;
        let closed = false;
        for (; j < logical.length; j++) {
          block.push(logical[j]);
          if (/^\.ends\b/i.test(logical[j])) {
            closed = true;
            break;
          }
        }
        const entry = ModelParser.parseSubckt(block, !closed);
        if (entry) entries.push(entry);
        i = j;
      }
      // Any other directive (.lib, .include, comments, blank) is ignored here.
    }

    return { entries, warnings };
  }

  /**
   * Collapses physical lines into logical SPICE lines: strips comments, drops
   * blanks, and folds continuation lines (those starting with `+`) onto the
   * previous line.
   */
  private static toLogicalLines(content: string): string[] {
    const out: string[] = [];
    for (let raw of content.split(/\r?\n/)) {
      // Strip inline comments. `;` always starts a comment; `*` only when it
      // begins the (trimmed) line so we don't clobber `2.2*K` style values.
      const semi = raw.indexOf(";");
      if (semi >= 0) raw = raw.slice(0, semi);
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed.startsWith("*")) continue;

      if (trimmed.startsWith("+")) {
        const cont = trimmed.slice(1).trim();
        if (out.length > 0) out[out.length - 1] += " " + cont;
        else out.push(cont);
      } else {
        out.push(trimmed);
      }
    }
    return out;
  }

  private static parseModel(line: string): SpiceModelDef | null {
    // .model NAME TYPE [(] params [)]
    const m = line.match(/^\.model\s+(\S+)\s+([A-Za-z]\w*)\s*(.*)$/i);
    if (!m) return null;
    const name = m[1];
    const type = m[2].toUpperCase();
    let rest = m[3].trim();

    // Strip an optional single pair of wrapping parentheses around the params.
    const paren = rest.match(/^\((.*)\)\s*$/s);
    if (paren) rest = paren[1].trim();

    const deviceClass = TYPE_TO_CLASS[type] ?? "unknown";
    const warnings: string[] = [];
    const params = ModelParser.parseParams(rest);

    const known = KNOWN_PARAMS[deviceClass];
    if (known) {
      for (const key of Object.keys(params)) {
        if (!known.has(key)) warnings.push(`Unknown ${type} parameter "${key}" – ignored.`);
      }
    }
    if (deviceClass === "unknown") {
      warnings.push(`Unrecognised model type "${type}" – registered without a typed symbol.`);
    }

    return {
      kind: "model",
      name,
      type,
      deviceClass,
      params,
      raw: line,
      warnings,
    };
  }

  /** Parses a `key=value key2 = value2` parameter list (whitespace tolerant). */
  private static parseParams(rest: string): Record<string, string> {
    const params: Record<string, string> = {};
    if (!rest) return params;
    // Normalise spaces around `=` then split on whitespace.
    const normalised = rest.replace(/\s*=\s*/g, "=");
    for (const tok of normalised.split(/\s+/)) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq > 0) {
        params[tok.slice(0, eq).toUpperCase()] = tok.slice(eq + 1);
      } else {
        // A bare flag/keyword (e.g. `OFF`) – keep with empty value.
        params[tok.toUpperCase()] = "";
      }
    }
    return params;
  }

  private static parseSubckt(block: string[], unterminated: boolean): SubcircuitDef | null {
    const header = block[0];
    const m = header.match(/^\.subckt\s+(\S+)\s*(.*)$/i);
    if (!m) return null;
    const name = m[1];
    // Pin names are the whitespace-separated tokens up to an optional `params:`
    // section that LTSpice/ngspice allow.
    let pinPart = m[2].trim();
    const paramsIdx = pinPart.toLowerCase().indexOf("params:");
    if (paramsIdx >= 0) pinPart = pinPart.slice(0, paramsIdx).trim();
    const pins = pinPart ? pinPart.split(/\s+/).filter(Boolean) : [];

    const warnings: string[] = [];
    if (pins.length === 0) warnings.push(`Subcircuit "${name}" declares no external pins.`);
    if (unterminated) warnings.push(`Subcircuit "${name}" has no matching .ends – using text to end of input.`);

    const bodyLines = block.slice(1).filter((l) => !/^\.ends\b/i.test(l));
    return {
      kind: "subckt",
      name,
      pins,
      body: bodyLines.join("\n"),
      raw: block.join("\n"),
      warnings,
    };
  }
}
