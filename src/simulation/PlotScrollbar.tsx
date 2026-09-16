import { useEffect, useRef, useState } from "react";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "@editor/pointerDrag.js";
import type { plotThemeFor } from "./plotTheme.js";

/** Width of the scrollbar strip, in px — wide enough to hit with a finger or pen. */
export const PLOT_SCROLLBAR_W = 16;
/** Smallest thumb, so a long panel list still leaves something to grab. */
const MIN_THUMB = 32;

interface Props {
  /** The element that scrolls (its native scrollbar should be hidden). */
  target: React.RefObject<HTMLDivElement | null>;
  theme: ReturnType<typeof plotThemeFor>;
}

/**
 * Always-visible vertical scrollbar for the stacked plot panes.
 *
 * iPadOS only shows an overlay scrollbar while scrolling and it cannot be
 * dragged; and touching a plot deliberately never scrolls (it must stay put).
 * So the pane list gets its own track: drag the thumb, or tap the track to
 * jump a page.
 */
export function PlotScrollbar({ target, theme }: Props) {
  const [geo, setGeo] = useState({ top: 0, height: 0, client: 0 });
  const [active, setActive] = useState(false);

  // Pane heights change without resizing the scroll box itself, so every pane
  // is observed too; re-attached after each render to pick up added panes.
  // (An observer reports once right after `observe`, which does the first measure.)
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const measure = () => {
      const next = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
      setGeo((g) => (g.top === next.top && g.height === next.height && g.client === next.client ? g : next));
    };
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  });

  const trackRef = useRef<HTMLDivElement>(null);
  const overflow = geo.height - geo.client;
  const trackH = geo.client;
  const thumbH = overflow > 0 ? Math.max(MIN_THUMB, (trackH * geo.client) / geo.height) : trackH;
  const thumbTop = overflow > 0 ? ((trackH - thumbH) * geo.top) / overflow : 0;

  const startThumb = (e: React.PointerEvent) => {
    if (!isDragPointer(e) || overflow <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = target.current;
    if (!el) return;
    const y0 = e.clientY, top0 = el.scrollTop;
    const perPx = overflow / Math.max(1, trackH - thumbH);
    setActive(true);
    trackPointerDrag(e, (ev) => { el.scrollTop = top0 + (ev.clientY - y0) * perPx; }, () => setActive(false));
  };

  const pageJump = (e: React.PointerEvent) => {
    if (!isDragPointer(e) || overflow <= 0) return;
    e.preventDefault();
    const el = target.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const y = e.clientY - track.getBoundingClientRect().top;
    const page = el.clientHeight * 0.9;
    el.scrollBy({ top: y < thumbTop ? -page : page, behavior: "smooth" });
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={pageJump}
      title="Scroll plots"
      style={{
        ...DRAG_TOUCH_ACTION, width: PLOT_SCROLLBAR_W, flexShrink: 0, position: "relative",
        background: theme.sidebarBg, borderLeft: `1px solid ${theme.border}`,
        cursor: overflow > 0 ? "pointer" : "default",
      }}
    >
      {overflow > 0 && (
        <div
          onPointerDown={startThumb}
          onPointerEnter={() => setActive(true)}
          onPointerLeave={(e) => { if (e.buttons === 0) setActive(false); }}
          style={{
            ...DRAG_TOUCH_ACTION, position: "absolute", left: 2, right: 2,
            top: thumbTop, height: thumbH, borderRadius: 6, cursor: "grab",
            background: active ? theme.accent : theme.borderStrong,
          }}
        />
      )}
    </div>
  );
}
