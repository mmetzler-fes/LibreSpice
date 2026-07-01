/**
 * Read/write LTSpice `.plt` plot-settings files, e.g.:
 *
 *   [AC Analysis]
 *   {
 *      Npanes: 3
 *      {
 *         traces: 1 {65540,0,"V(uc)/I(C1)"}
 *         X: ('K',0,1,1000,10001)
 *         Y[0]: ('K',0,0,2000,20000)
 *         Y[1]: (' ',0,-95,1,-85)
 *         Log: 0 0 0
 *         GridStyle: 1
 *      },
 *      ...
 *   }
 *
 * An axis tuple is `(prefix, flag, low, tick, high)` where `prefix` is the SI
 * display prefix, `low`/`high` the (raw) bounds and `tick` the grid spacing.
 * The per-trace `{code,flag,"name"}` colour code is LTSpice-internal and not
 * fully reproducible; we preserve the trace name and emit a best-effort code.
 */

export interface PltAxis {
  prefix: string;
  low: number;
  tick: number;
  high: number;
}

export interface PltPane {
  traces: string[];
  x: PltAxis;
  y0?: PltAxis;
  y1?: PltAxis;
  /** [x, y0, y1] logarithmic flags. */
  log: [boolean, boolean, boolean];
}

export interface PltDoc {
  analysis: string;
  panes: PltPane[];
}

/** SI display prefix for the axis magnitude (cosmetic; bounds stay raw). */
export function siPrefix(v: number): string {
  const a = Math.abs(v);
  if (!isFinite(a) || a === 0) return " ";
  if (a >= 1e12) return "T";
  if (a >= 1e9) return "G";
  if (a >= 1e6) return "M";
  if (a >= 1e3) return "K";
  if (a >= 1) return " ";
  if (a >= 1e-3) return "m";
  if (a >= 1e-6) return "µ";
  if (a >= 1e-9) return "n";
  return "p";
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return "0";
  return String(Number(n.toPrecision(6)));
}

function fmtAxis(a: PltAxis): string {
  return `('${a.prefix}',0,${fmtNum(a.low)},${fmtNum(a.tick)},${fmtNum(a.high)})`;
}

// ── Serialise ──────────────────────────────────────────────────────────────

export function serializePlt(doc: PltDoc): string {
  const lines: string[] = [];
  lines.push(`[${doc.analysis}]`);
  lines.push("{");
  lines.push(`   Npanes: ${doc.panes.length}`);
  doc.panes.forEach((pane, pi) => {
    lines.push("   {");
    const toks = pane.traces.map((name, i) => `{${524290 + i},0,"${name}"}`).join(" ");
    lines.push(`      traces: ${pane.traces.length} ${toks}`);
    lines.push(`      X: ${fmtAxis(pane.x)}`);
    if (pane.y0) lines.push(`      Y[0]: ${fmtAxis(pane.y0)}`);
    if (pane.y1) lines.push(`      Y[1]: ${fmtAxis(pane.y1)}`);
    lines.push(`      Log: ${pane.log.map((b) => (b ? 1 : 0)).join(" ")}`);
    lines.push(`      GridStyle: 1`);
    lines.push(pi < doc.panes.length - 1 ? "   }," : "   }");
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

// ── Parse ──────────────────────────────────────────────────────────────────

/** Content between the brace at `open` and its matching close (exclusive). */
function matchingBraces(s: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return null;
}

/** Split a body into its top-level `{...}` blocks (ignores deeper nesting). */
function splitTopBraces(body: string): string[] {
  const blocks: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") { if (depth === 0) start = i + 1; depth++; }
    else if (body[i] === "}") { depth--; if (depth === 0 && start >= 0) blocks.push(body.slice(start, i)); }
  }
  return blocks;
}

function parseAxis(body: string, re: RegExp): PltAxis | undefined {
  const m = body.match(re);
  if (!m) return undefined;
  const parts = m[1].split(",").map((p) => p.trim());
  // (prefix, flag, low, tick, high)
  const prefix = parts[0].replace(/'/g, "");
  return {
    prefix: prefix.length ? prefix : " ",
    low: parseFloat(parts[2]),
    tick: parseFloat(parts[3]),
    high: parseFloat(parts[4]),
  };
}

function parsePane(body: string): PltPane | null {
  const traces: string[] = [];
  const tRe = /\{[^}]*?,[^}]*?,"([^"]*)"\}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(body)) !== null) traces.push(tm[1]);

  const x = parseAxis(body, /X:\s*\(([^)]*)\)/);
  if (!x) return null;
  const y0 = parseAxis(body, /Y\[0\]:\s*\(([^)]*)\)/);
  const y1 = parseAxis(body, /Y\[1\]:\s*\(([^)]*)\)/);

  const logM = body.match(/Log:\s*([\d ]+)/);
  const logs = logM ? logM[1].trim().split(/\s+/).map((v) => v === "1") : [];
  return { traces, x, y0, y1, log: [!!logs[0], !!logs[1], !!logs[2]] };
}

export function parsePlt(text: string): PltDoc | null {
  const am = text.match(/\[([^\]]+)\]/);
  const analysis = am ? am[1].trim() : "Transient Analysis";
  const open = text.indexOf("{");
  if (open < 0) return null;
  const outer = matchingBraces(text, open);
  if (outer === null) return null;
  const panes = splitTopBraces(outer).map(parsePane).filter((p): p is PltPane => p !== null);
  if (panes.length === 0) return null;
  return { analysis, panes };
}

/** Tick spacing → tick count for our axis model. */
export function tickCount(axis?: PltAxis): number | undefined {
  if (!axis || !isFinite(axis.tick) || axis.tick <= 0) return undefined;
  const n = Math.round((axis.high - axis.low) / axis.tick);
  return n >= 2 ? n : undefined;
}
