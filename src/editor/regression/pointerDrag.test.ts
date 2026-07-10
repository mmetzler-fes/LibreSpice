import { isDragPointer, trackPointerDrag } from "../pointerDrag.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Drags must work with a mouse, a stylus and a finger alike — the editor's
 * gestures used to be wired to `mousemove`/`mouseup`, which a touch never fires
 * during the gesture. These tests pin the pointer contract:
 *
 *  - only the primary pointer drags, so a second finger cannot hijack one;
 *  - a mouse drags only with its left button, leaving right/middle to the menu;
 *  - the drag ends on `pointerup` *and* on `pointercancel` (iPadOS palm
 *    rejection), and stops listening afterwards.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** Minimal stand-in for the DOM event objects the helpers read. */
function pointer(over: Partial<{ pointerId: number; pointerType: string; isPrimary: boolean; button: number }> = {}) {
  return {
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
    ...over,
  } as unknown as React.PointerEvent;
}

/** Run `fn` with `window` replaced by an EventTarget we can dispatch on. */
function withFakeWindow(fn: (win: EventTarget) => void): void {
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  const target = new EventTarget();
  g.window = target;
  try {
    fn(target);
  } finally {
    g.window = prev;
  }
}

/** Dispatch a pointer event carrying `pointerId` (and optional coordinates). */
function emit(win: EventTarget, type: string, pointerId: number, clientX = 0, clientY = 0): void {
  const ev = new Event(type) as Event & { pointerId: number; clientX: number; clientY: number };
  ev.pointerId = pointerId;
  ev.clientX = clientX;
  ev.clientY = clientY;
  win.dispatchEvent(ev);
}

const CASES: Case[] = [
  {
    name: "isDragPointer accepts a left mouse button, a pen and a finger",
    run: (fail) => {
      if (!isDragPointer(pointer({ pointerType: "mouse", button: 0 }))) fail("left mouse button rejected");
      if (!isDragPointer(pointer({ pointerType: "pen", button: 0 }))) fail("pen rejected");
      if (!isDragPointer(pointer({ pointerType: "touch", button: 0 }))) fail("touch rejected");
      // A pen reports button 0 on contact; a barrel-button press must still drag.
      if (!isDragPointer(pointer({ pointerType: "pen", button: -1 }))) fail("pen hover/barrel rejected");
    },
  },
  {
    name: "isDragPointer rejects secondary mouse buttons and non-primary pointers",
    run: (fail) => {
      if (isDragPointer(pointer({ pointerType: "mouse", button: 2 }))) fail("right mouse button started a drag");
      if (isDragPointer(pointer({ pointerType: "mouse", button: 1 }))) fail("middle mouse button started a drag");
      if (isDragPointer(pointer({ pointerType: "touch", isPrimary: false }))) fail("a second finger started a drag");
    },
  },
  {
    name: "trackPointerDrag reports moves of its own pointer only",
    run: (fail) => {
      withFakeWindow((win) => {
        const seen: number[] = [];
        trackPointerDrag(pointer({ pointerId: 7 }), (ev) => seen.push(ev.clientX));
        emit(win, "pointermove", 7, 10);
        emit(win, "pointermove", 9, 99); // a second finger
        emit(win, "pointermove", 7, 20);
        if (seen.join(",") !== "10,20") fail(`moves ${JSON.stringify(seen)}, want [10,20]`);
      });
    },
  },
  {
    name: "trackPointerDrag ends on pointerup and detaches its listeners",
    run: (fail) => {
      withFakeWindow((win) => {
        let moves = 0, ends = 0;
        trackPointerDrag(pointer({ pointerId: 3 }), () => moves++, () => ends++);
        emit(win, "pointermove", 3);
        emit(win, "pointerup", 3);
        if (ends !== 1) fail(`onEnd fired ${ends}×, want once`);
        emit(win, "pointermove", 3); // after release: must be ignored
        emit(win, "pointerup", 3);
        if (moves !== 1) fail(`kept moving after release (${moves} moves)`);
        if (ends !== 1) fail(`onEnd fired again (${ends}×)`);
      });
    },
  },
  {
    name: "trackPointerDrag ends on pointercancel, so a drag is never left hanging",
    run: (fail) => {
      withFakeWindow((win) => {
        let moves = 0, ends = 0;
        trackPointerDrag(pointer({ pointerId: 4 }), () => moves++, () => ends++);
        emit(win, "pointercancel", 4);
        if (ends !== 1) return fail(`onEnd fired ${ends}× on cancel, want once`);
        emit(win, "pointermove", 4);
        if (moves !== 0) fail("still tracking after cancel");
      });
    },
  },
  {
    name: "a foreign pointer neither ends nor cancels the drag",
    run: (fail) => {
      withFakeWindow((win) => {
        let moves = 0, ends = 0;
        trackPointerDrag(pointer({ pointerId: 1 }), () => moves++, () => ends++);
        emit(win, "pointerup", 2);
        emit(win, "pointercancel", 2);
        if (ends !== 0) fail(`a foreign pointer ended the drag (${ends}×)`);
        emit(win, "pointermove", 1);
        if (moves !== 1) fail("drag stopped tracking its own pointer");
      });
    },
  },
];

export function runPointerDragTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}
