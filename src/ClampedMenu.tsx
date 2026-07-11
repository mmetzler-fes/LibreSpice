import { useLayoutEffect, useRef, useState } from "react";

/**
 * A floating menu opened at a click point (x, y): a full-screen backdrop (click
 * or right-click to dismiss) plus a panel that is clamped to stay within the
 * viewport. Without the clamp, opening a menu near the right/bottom edge — e.g.
 * right-clicking a component close to the border — pushed it partly off-screen.
 *
 * The clamp measures the panel and repositions it in a layout effect (before the
 * browser paints), so the corrected position shows with no visible jump. Pass
 * the panel's own chrome via `style`; positioning/z-index are managed here.
 */
export function ClampedMenu({
  x, y, onClose, style, zIndex = 3001, backdropZIndex = 3000, children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  style?: React.CSSProperties;
  zIndex?: number;
  backdropZIndex?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [x, y]);

  return (
    <>
      <div
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: "fixed", inset: 0, zIndex: backdropZIndex }}
      />
      <div ref={ref} style={{ ...style, position: "fixed", left: pos.left, top: pos.top, zIndex }}>
        {children}
      </div>
    </>
  );
}
