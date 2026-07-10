/**
 * Pointer-based dragging, so a stylus or finger drives the editor exactly like a
 * mouse (iPad + Apple Pencil).
 *
 * Touch never produced `mousemove`/`mouseup` during a gesture — the browser only
 * synthesises compatibility mouse events *after* the touch ends — so every drag
 * built on those events was mouse-only. Pointer events cover mouse, pen and touch
 * in one API.
 *
 * Listeners live on `window` rather than on the dragged element: for touch the
 * browser implicitly captures the pointer to its original target, so the events
 * still retarget there and bubble up, and for mouse/pen a drag that leaves the
 * element keeps working. Pointer id is matched so a second finger cannot steer a
 * drag started by the first.
 */

/** Elements that start a drag must opt out of the browser's own pan/zoom. */
export const DRAG_TOUCH_ACTION = { touchAction: "none" } as const;

/**
 * Kill iPadOS's native element drag on an HTML tag that we drag ourselves.
 *
 * A `<div>` with text + background (e.g. a net-label tag) is draggable content
 * to WebKit: a touch-drag lifts a translucent *clone* and fires `pointercancel`,
 * which both spoils the drag and aborts the long-press menu. Symbols made of
 * `<svg>` never trip this, so only text tags need it. Purely touch/WebKit
 * behaviour — mouse and desktop drag are unaffected.
 */
export const NO_NATIVE_DRAG = {
  ...DRAG_TOUCH_ACTION,
  WebkitUserDrag: "none",
  WebkitTouchCallout: "none",
  WebkitUserSelect: "none",
  userSelect: "none",
} as const;

/**
 * True when this pointer should start a drag: the primary pointer, and for a
 * mouse only the left button (right/middle stay with the context menu).
 */
export function isDragPointer(e: React.PointerEvent): boolean {
  if (!e.isPrimary) return false;
  return e.pointerType !== "mouse" || e.button === 0;
}

/**
 * Track one pointer until it is released or cancelled. `onMove` runs for every
 * move of that pointer; `onEnd` once, also when the gesture is cancelled (the
 * system taking over, e.g. a palm rejection on iPadOS) — so a drag can never be
 * left hanging.
 */
export function trackPointerDrag(
  e: React.PointerEvent,
  onMove: (ev: PointerEvent) => void,
  onEnd?: (ev: PointerEvent) => void,
): void {
  const id = e.pointerId;

  const move = (ev: PointerEvent) => {
    if (ev.pointerId === id) onMove(ev);
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    onEnd?.(ev);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
