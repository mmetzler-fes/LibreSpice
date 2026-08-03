import { TYPE_TO_SYMBOL } from "./ltspiceGeometry.js";
import { usedDefinitions } from "@core/circuit/NetlistGenerator.js";
import { buildZip, type ZipEntry } from "@core/zip.js";

/**
 * A schematic packed up so it opens in LTSpice: the `.asc` plus the parts of
 * ours it names.
 *
 * A file we write is already an LTSpice file — same format, same symbol names,
 * same conventions. What LTSpice has not got is the two halves of *our own*
 * parts: the symbol graphics (`.asy`) and the model bodies (`.subckt`). Without
 * them it opens the sheet with "Missing symbol" boxes and refuses to run with
 * "unknown subcircuit".
 *
 * The bundle is a folder, not an installer. LTSpice looks for a symbol in the
 * schematic's own directory before its library, and resolves `.include`
 * relative to the schematic too — so unpacking next to the `.asc` is the whole
 * installation. Nothing is written into LTSpice's own library, nothing is
 * shadowed anywhere but in that one folder, and a sheet mailed to a student
 * works on arrival.
 */

/**
 * Symbols LTSpice already ships, which must never be in a bundle.
 *
 * Our `src/sym` holds our own drawings of LTSpice's stock parts as well — a
 * resistor, a diode, the voltage source, the switch. They exist so we can draw
 * a schematic at all, and they are *not* the same files as LTSpice's. Exporting
 * one would put our drawing in front of LTSpice's original for that folder,
 * which is the one thing this export must not do: `sw` is our own picture of
 * LTSpice's own part, and a user would rightly expect their `sw` to stay theirs.
 *
 * Derived from {@link TYPE_TO_SYMBOL} rather than listed by hand, so a symbol
 * added there for a built-in component type is excluded automatically. The norm
 * variants (`res_EN`, `cap_ANSI`, …) go with their base name, and anything
 * path-qualified (`Misc\EuropeanResistor`, `Digital\and`) is LTSpice's library
 * layout by construction.
 */
function isStockSymbol(name: string): boolean {
  if (/[\\/]/.test(name)) return true;
  const base = name.toLowerCase().replace(/_{1,2}(ansi|en|de)$/i, "");
  const stock = new Set(
    Object.values(TYPE_TO_SYMBOL).map((s) => (s.split(/[\\/]/).pop() ?? s).toLowerCase()),
  );
  return stock.has(base);
}

/** What a sheet needs from us, resolved but not yet packed. */
export interface BundleContents {
  /** `.asy` sources of our own symbols the sheet draws with, keyed by name. */
  symbols: { name: string; raw: string }[];
  /** `.model` / `.subckt` blocks the sheet references, in dependency order. */
  models: { name: string; raw: string }[];
  /**
   * Parts the sheet names that we could not resolve — a symbol with no `.asy`
   * or a model with no definition. Reported rather than skipped: a bundle that
   * is quietly incomplete fails at the other end, where nobody can see why.
   */
  missing: string[];
}

export interface BundleInput {
  /** The exported schematic text, exactly as it will be written. */
  asc: string;
  /** The circuit's device lines, for resolving which models are referenced. */
  instanceLines: string;
  /** The sheet's own SPICE directives. */
  directives: string;
  /** Every library definition available, as named blocks. */
  library: { name: string; raw: string }[];
  /** Looks up an `.asy` source by symbol name; undefined when we have none. */
  symbolSource: (name: string) => string | undefined;
  /**
   * The plot configuration as `.plt` text, when a simulation has been run.
   *
   * LTSpice opens a schematic's `.plt` by itself, keyed on the file name, so a
   * bundle that carries one comes up with the same panes, traces and colours
   * instead of an empty waveform window. Null before the first run — there are
   * no axes to write down yet.
   */
  plt?: string | null;
}

/** The single file the sheet's `.include` points at. */
export const BUNDLE_LIB = "librespice.lib";

/**
 * Work out what has to travel with this schematic.
 *
 * Symbols come from the `SYMBOL` lines of the exported text rather than from the
 * node list: that text is what LTSpice will read, and a symbol name it carries
 * (an imported `Ureg`, say) is not always derivable from the component type.
 */
export function collectBundle(input: BundleInput): BundleContents {
  const symbols: { name: string; raw: string }[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const m of input.asc.matchAll(/^SYMBOL\s+(\S+)/gim)) {
    const name = m[1];
    if (isStockSymbol(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const raw = input.symbolSource(name);
    if (raw) symbols.push({ name, raw });
    else missing.push(`Symbol ${name}`);
  }

  // The same question the netlist asks, answered by the same code — a bundle
  // that resolved it its own way could hand out a sheet with a part missing.
  const { always, used } = usedDefinitions(input.library, input.instanceLines, input.directives);
  const models = [...used].map(([name, raw]) => ({ name, raw }));
  if (always.trim()) models.unshift({ name: "", raw: always.trim() });

  return { symbols, models, missing };
}

/**
 * The `.asc` with an `.include` for the bundled models.
 *
 * Written as a SPICE directive at the bottom of the sheet, which is where
 * LTSpice puts one and where the user can see and delete it. Only added when
 * there is something to include, and never twice.
 */
export function withIncludeDirective(asc: string, hasModels: boolean): string {
  if (!hasModels || new RegExp(`\\.include\\s+${BUNDLE_LIB}`, "i").test(asc)) return asc;
  // Below the drawing: the sheet's own coordinates are unknown here, and a
  // directive sitting under everything else is what LTSpice does by default.
  const lowest = [...asc.matchAll(/^(?:WIRE|SYMBOL|FLAG|TEXT)\s+(?:\S+\s+)?(-?\d+)\s+(-?\d+)/gim)]
    .reduce((n, m) => Math.max(n, Number(m[2])), 0);
  return `${asc.replace(/\s*$/, "")}\nTEXT 0 ${lowest + 64} Left 2 !.include ${BUNDLE_LIB}\n`;
}

/** The note that goes in the archive, so the folder explains itself. */
export function bundleReadme(sheetName: string, c: BundleContents, hasPlt = false): string {
  const lines = [
    `${sheetName} - fuer LTSpice`,
    "",
    "Diesen Ordner irgendwohin entpacken und die .asc-Datei in LTSpice öffnen.",
    "Mehr ist nicht nötig: LTSpice sucht Symbole zuerst im Ordner des",
    "Schaltplans, und die .include-Zeile im Blatt zeigt auf die Modelldatei",
    "daneben. In der LTSpice-Bibliothek wird nichts verändert.",
    "",
    "Symbole liegen nur für Teile bei, die LTSpice nicht selbst hat. Widerstände,",
    "Quellen, Dioden, der Schalter und die Digitalsymbole sind LTSpices eigene",
    "und bleiben es.",
    "",
    "Bei den Modellen ist es umgekehrt: beigelegt wird, was das Blatt aus unserer",
    "Bibliothek benutzt, auch wenn LTSpice einen Baustein dieses Namens kennt",
    "(etwa 2N2222). Nur so rechnet das Blatt drüben mit denselben Werten wie hier.",
    "Das gilt in diesem Ordner und sonst nirgends.",
    "",
  ];
  if (c.symbols.length) {
    lines.push(`Symbole (${c.symbols.length}): ${c.symbols.map((s) => s.name).join(", ")}`, "");
  }
  if (c.models.length) {
    lines.push(`Modelle in ${BUNDLE_LIB}: ${c.models.map((m) => m.name).filter(Boolean).join(", ")}`, "");
  }
  if (c.missing.length) {
    lines.push(
      "ACHTUNG: diese Teile nennt das Blatt, wir konnten sie aber nicht",
      "beilegen. In LTSpice fehlen sie:",
      ...c.missing.map((m) => `  - ${m}`),
      "",
    );
  }
  if (hasPlt) {
    lines.push(
      `Die ${sheetName}.plt daneben ist die Diagrammeinstellung: LTSpice liest sie`,
      "beim Öffnen des Blattes von selbst, das Diagrammfenster kommt also mit",
      "denselben Kurven und Farben hoch.",
      "",
    );
  }
  lines.push(
    "Grenzen: Gatter und Flipflops zeichnen mit LTSpices Digitalsymbolen, ihr",
    "Verhalten stammt bei uns aber aus eigenen Modellen. In LTSpice rechnen sie",
    "mit dessen eigenen Digitalmodellen und verhalten sich ähnlich, nicht gleich.",
    "",
    "Erzeugt mit LibreSpice.",
    "",
  );
  return lines.join("\n");
}

/**
 * The finished archive.
 *
 * Flat, with no folder inside: an unpacker that drops the contents into the
 * current directory and one that makes a folder both end with the `.asc` and
 * its parts side by side, which is the only arrangement that works.
 */
export function buildLTSpiceBundle(sheetName: string, input: BundleInput): Uint8Array {
  const contents = collectBundle(input);
  const asc = withIncludeDirective(input.asc, contents.models.length > 0);
  const entries: ZipEntry[] = [
    { path: `${sheetName}.asc`, data: asc, latin1: true },
    ...contents.symbols.map((s) => ({ path: `${s.name}.asy`, data: s.raw, latin1: true })),
  ];
  if (contents.models.length) {
    entries.push({
      path: BUNDLE_LIB,
      data: [
        "* Modelle zu diesem Schaltplan, aus der LibreSpice-Bibliothek.",
        "* Wird von der .include-Zeile im Blatt geladen.",
        "",
        ...contents.models.map((m) => m.raw.trim()),
        "",
      ].join("\n"),
      latin1: true,
    });
  }
  // Named after the sheet, because that is how LTSpice finds it.
  if (input.plt?.trim()) entries.push({ path: `${sheetName}.plt`, data: input.plt, latin1: true });
  // UTF-8, anders als alles andere im Archiv: die Notiz ist unsere eigene
  // Datei und wird von einem Texteditor gelesen, nicht von LTSpice. Als latin1
  // geschrieben verlor sie jedes Zeichen jenseits von 0xFF - der Gedankenstrich
  // in der Ueberschrift kam als "?" heraus.
  entries.push({ path: "LIESMICH.txt", data: bundleReadme(sheetName, contents, !!input.plt?.trim()) });
  return buildZip(entries);
}
