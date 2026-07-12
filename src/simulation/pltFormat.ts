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
  /** One entry per y-axis (Y[0] left, Y[1..] right), by unit group. */
  y: PltAxis[];
  /** [x, y0, y1] logarithmic flags. */
  log: [boolean, boolean, boolean];
  /**
   * `Parametric: "I(RL)"` — the pane plots its traces against this trace instead
   * of the sweep/time axis (e.g. a source characteristic U_KL over I_RL). The
   * `X:` bounds then refer to that quantity, not to the sweep.
   */
  parametric?: string;

  // ── LibreSpice extensions ────────────────────────────────────────────────
  // Settings the `.plt` format has no field for. They are written as extra
  // `Key: value` lines inside the pane block, which LTSpice ignores (it skips
  // keys it doesn't know), so the file stays loadable there.

  /** Trace colour overrides, trace name → CSS colour. */
  colors?: Record<string, string>;
  /** y-axis scale. "log" also sets the standard `Log:` y flag; "db" is ours. */
  yScale?: "linear" | "log" | "db";
  /** Functions kept in the list but toggled off (not drawn). */
  hidden?: string[];
  /** Manual y-axis caption; empty = auto from the unit. */
  yLabel?: string;
  /** Fixed pane height in px (drag handle); unset = share the space. */
  height?: number;
}

export interface PltDoc {
  analysis: string;
  panes: PltPane[];
  /** "Sync. Horiz. Axes": all panes share one x-range. */
  syncX?: boolean;
  /** Diagram drawn on a white background (print/beamer look). */
  light?: boolean;
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
  if (doc.syncX) lines.push(`   SyncX: 1`);
  if (doc.light) lines.push(`   Light: 1`);
  doc.panes.forEach((pane, pi) => {
    lines.push("   {");
    const toks = pane.traces.map((name, i) => `{${524290 + i},0,"${name}"}`).join(" ");
    lines.push(`      traces: ${pane.traces.length} ${toks}`);
    if (pane.parametric) lines.push(`      Parametric: "${pane.parametric}"`);
    lines.push(`      X: ${fmtAxis(pane.x)}`);
    pane.y.forEach((y, yi) => lines.push(`      Y[${yi}]: ${fmtAxis(y)}`));
    // A logarithmic y-axis is expressible in LTSpice's own Log flags; dB is not,
    // so it rides along in YScale (below) and leaves the flag at 0.
    const logY = pane.yScale === "log";
    lines.push(`      Log: ${[pane.log[0], logY, logY].map((b) => (b ? 1 : 0)).join(" ")}`);
    lines.push(`      GridStyle: 1`);
    if (pane.yScale && pane.yScale !== "linear") lines.push(`      YScale: ${pane.yScale}`);
    if (pane.yLabel) lines.push(`      YLabel: "${pane.yLabel}"`);
    if (pane.height !== undefined) lines.push(`      Height: ${Math.round(pane.height)}`);
    for (const [trace, color] of Object.entries(pane.colors ?? {})) {
      lines.push(`      Color: "${trace}" "${color}"`);
    }
    if (pane.hidden?.length) {
      lines.push(`      Hidden: ${pane.hidden.map((h) => `"${h}"`).join(" ")}`);
    }
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
  // Standard `traces: N {code,flag,"name"} …` tokens.
  const tRe = /\{[^}]*?,[^}]*?,"([^"]*)"\}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(body)) !== null) traces.push(tm[1]);
  // Alternative `Signal: V(n001)` lines (seen in some LTSpice versions).
  const sRe = /^[ \t]*Signal:[ \t]*(.+?)[ \t]*$/gm;
  let sm: RegExpExecArray | null;
  while ((sm = sRe.exec(body)) !== null) {
    const name = sm[1].replace(/^"|"$/g, "");
    if (!traces.includes(name)) traces.push(name);
  }

  const x = parseAxis(body, /X:\s*\(([^)]*)\)/);
  if (!x) return null;
  const y: PltAxis[] = [];
  for (let i = 0; i < 8; i++) {
    const ax = parseAxis(body, new RegExp(`Y\\[${i}\\]:\\s*\\(([^)]*)\\)`));
    if (!ax) break;
    y.push(ax);
  }

  const logM = body.match(/Log:\s*([\d ]+)/);
  const logs = logM ? logM[1].trim().split(/\s+/).map((v) => v === "1") : [];
  // `Parametric:` names the trace used as the x-axis. Its own `{…,"name"}` token
  // form is not used, so it never lands in `traces`.
  const pm = body.match(/^[ \t]*Parametric:[ \t]*(.+?)[ \t]*$/m);
  const parametric = pm ? pm[1].replace(/^"|"$/g, "") : undefined;

  // LibreSpice extensions (see PltPane). A file written by LTSpice has none of
  // these, hence every one is optional; a log y-axis still comes through via the
  // standard Log flag.
  const colors: Record<string, string> = {};
  const cRe = /^[ \t]*Color:[ \t]*"([^"]*)"[ \t]*"([^"]*)"[ \t]*$/gm;
  let cm: RegExpExecArray | null;
  while ((cm = cRe.exec(body)) !== null) colors[cm[1]] = cm[2];

  const ysM = body.match(/^[ \t]*YScale:[ \t]*(linear|log|db)[ \t]*$/mi);
  const yScale = ysM
    ? (ysM[1].toLowerCase() as "linear" | "log" | "db")
    : (logs[1] ? "log" : undefined);

  const hm = body.match(/^[ \t]*Hidden:[ \t]*(.+?)[ \t]*$/m);
  const hidden = hm ? [...hm[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : undefined;

  const ylM = body.match(/^[ \t]*YLabel:[ \t]*"([^"]*)"[ \t]*$/m);
  const hM = body.match(/^[ \t]*Height:[ \t]*(\d+)[ \t]*$/m);

  return {
    traces, x, y, log: [!!logs[0], !!logs[1], !!logs[2]], parametric,
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(yScale ? { yScale } : {}),
    ...(hidden?.length ? { hidden } : {}),
    ...(ylM ? { yLabel: ylM[1] } : {}),
    ...(hM ? { height: Number(hM[1]) } : {}),
  };
}

export function parsePlt(text: string): PltDoc | null {
  const am = text.match(/\[([^\]]+)\]/);
  const analysis = am ? am[1].trim() : "Transient Analysis";
  const open = text.indexOf("{");
  if (open < 0) return null;
  const outer = matchingBraces(text, open);
  if (outer === null) return null;
  const blocks = splitTopBraces(outer);
  // Fallback: some variants have no per-pane braces — treat the outer as one pane.
  const bodies = blocks.length > 0 ? blocks : [outer];
  const panes = bodies.map(parsePane).filter((p): p is PltPane => p !== null);
  if (panes.length === 0) return null;
  return {
    analysis,
    panes,
    syncX: /^[ \t]*SyncX:[ \t]*1[ \t]*$/m.test(text),
    light: /^[ \t]*Light:[ \t]*1[ \t]*$/m.test(text),
  };
}

/** Grid spacing (our tick model) from an axis tuple, or undefined if invalid. */
export function tickStep(axis?: PltAxis): number | undefined {
  if (!axis || !isFinite(axis.tick) || axis.tick <= 0) return undefined;
  return axis.tick;
}
