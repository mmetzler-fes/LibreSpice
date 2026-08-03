import { siFormat, ticksFor, usableRange, applyYOverrides } from "../OscilloscopePlot.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * The plot's axes: what the tick labels say, and what a hand-set field does.
 *
 * Four significant digits are plenty for an axis spanning a decade and hopeless
 * for one that does not. A buck converter's output sits at 4.920557…4.920572 V,
 * so every tick of that axis printed as "4.921" — three identical numbers up the
 * side, under a curve auto-scaled to fill the pane. It read as a 5 V sine wave
 * where the data was a 15 µV ripple, and nothing on screen said otherwise. The
 * time axis had it too: a 30 µs window labelled "99.98ms" five times over.
 *
 * The labels therefore take the tick spacing and show the digits it needs.
 *
 * The second half is the fields beside the plot. They take any number, and two
 * of the numbers they take used to blank the panel outright: a bound past its
 * opposite, and a tick spacing far below the window. Both now fall back to the
 * automatic value — the entered number stays in the field, so it can be seen
 * and corrected rather than guessed at.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** Labels for `n` evenly spaced ticks across [lo, hi], as an axis draws them. */
function labels(lo: number, hi: number, n: number): string[] {
  const step = (hi - lo) / n;
  return Array.from({ length: n + 1 }, (_, i) => siFormat(lo + i * step, step));
}

const CASES: Case[] = [
  {
    name: "a zoomed-in axis labels every tick differently",
    run: (fail) => {
      // The buck converter's output, exactly as measured.
      const got = labels(4.920557, 4.920572, 3);
      if (new Set(got).size !== got.length) fail(`repeats: ${got.join(" ")}`);
      if (!got[0].startsWith("4.920557")) fail(`lost the value: ${got[0]}`);
      // …and the time window from the same screenshot.
      const t = labels(0.09997, 0.1, 5);
      if (new Set(t).size !== t.length) fail(`time repeats: ${t.join(" ")}`);
    },
  },
  {
    name: "an ordinary axis is left exactly as it was",
    run: (fail) => {
      const volts = labels(0, 10, 5).join(" ");
      if (volts !== "0 2 4 6 8 10") fail(`0..10 V now reads: ${volts}`);
      const ms = labels(0, 0.2, 4).join(" ");
      if (ms !== "0 50m 100m 150m 200m") fail(`0..200 ms now reads: ${ms}`);
      // The second screenshot's axis, once the rectangle widened it.
      const mixed = labels(-0.59, 5.51, 4).join(" ");
      if (mixed !== "-590m 935m 2.46 3.985 5.51") fail(`-0.59..5.51 V now reads: ${mixed}`);
    },
  },
  {
    name: "without a spacing the old four digits still apply",
    run: (fail) => {
      // Cursor readouts and the operating-point table pass no step.
      if (siFormat(4.920572) !== "4.921") fail(`${siFormat(4.920572)} — a bare value changed`);
      if (siFormat(0.01) !== "10m") fail(siFormat(0.01));
      if (siFormat(12345) !== "12.35k") fail(siFormat(12345));
    },
  },
  {
    name: "the digit count stays inside what a double and a label can hold",
    run: (fail) => {
      // A spacing far below the value's own resolution must not ask for 30
      // digits — the label would be nonsense and would not fit under a tick.
      const s = siFormat(4.920572, 1e-18);
      if (s.replace(/[^\d]/g, "").length > 13) fail(`${s} is too long to be a tick label`);
      if (!isFinite(Number(s))) fail(`${s} is not a number`);
      // Degenerate spacings fall back rather than throw.
      for (const step of [0, -1, NaN, Infinity]) {
        if (siFormat(4.92, step) !== "4.92") fail(`step ${step} gave ${siFormat(4.92, step)}`);
      }
      if (siFormat(0, 1e-6) !== "0") fail("zero lost its label");
    },
  },

  // ── The fields beside the plot ────────────────────────────────────────────
  {
    // Typing 100n into the right-hand field of a window that runs 99.97ms to
    // 100ms: every sample maps outside the pane and the plot goes blank.
    name: "a bound past its opposite is ignored, not drawn",
    run: (fail) => {
      if (usableRange(0.09997, 1e-7)) fail("a right bound below the left one was accepted");
      if (usableRange(5, 5)) fail("an empty range was accepted");
      if (usableRange(0, NaN) || usableRange(-Infinity, 1)) fail("a non-finite bound was accepted");
      if (!usableRange(0.09997, 0.1)) fail("the sheet's own window was rejected");
      if (!usableRange(-5, 5)) fail("a range across zero was rejected");
    },
  },
  {
    name: "a y-axis whose top is under its bottom keeps the fitted range",
    run: (fail) => {
      const fitted = { unit: "V", traces: ["v(u2)"], yMin: 4.920557, yMax: 4.920572 };
      const upside = applyYOverrides([fitted], { id: "p1", yMin: 5, yMax: 0 } as never)[0];
      if (upside.yMin !== fitted.yMin || upside.yMax !== fitted.yMax) {
        fail(`the panel took an inverted range: ${upside.yMin}..${upside.yMax}`);
      }
      // A sound override is still applied — the guard must not swallow those.
      const ok = applyYOverrides([fitted], { id: "p1", yMin: 0, yMax: 10 } as never)[0];
      if (ok.yMin !== 0 || ok.yMax !== 10) fail(`a valid range was dropped: ${ok.yMin}..${ok.yMax}`);
    },
  },
  {
    // 100n across the sheet's 30 µs window is 300 labels, which draw as a smear
    // of overlapping text where an axis used to be.
    name: "a tick spacing far below the window falls back to automatic ticks",
    run: (fail) => {
      const tiny = ticksFor(0.09997, 0.1, 1e-7, 6);
      if (tiny.length > 12) fail(`${tiny.length} ticks — unreadable`);
      // …and it is the automatic set, so the axis is still labelled.
      if (tiny.length < 2) fail("the axis lost its ticks entirely");
      // A sensible explicit spacing is untouched.
      const fine = ticksFor(0, 10, 2, 6);
      if (fine.join(",") !== "0,2,4,6,8,10") fail(`an explicit step changed: ${fine.join(",")}`);
      const one = ticksFor(0.09997, 0.1, 1e-5, 6);
      if (one.length < 3 || one.length > 5) fail(`a 10 µs step gave ${one.length} ticks`);
    },
  },
];

export function runAxisLabelTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
