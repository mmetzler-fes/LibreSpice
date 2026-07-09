import { symbolForType } from "@sym/asyParser.js";
import { AsySymbolView } from "@sym/AsySymbol.js";
import { useUIStore } from "@store/uiStore.js";
import type { ComponentType } from "./nodes/ComponentNode.js";
import {
  BJTNPNSymbol, BJTPNPSymbol, MOSFETNSymbol, GroundSymbol,
  VoltageSourceSymbol, SineSourceSymbol, PulseSourceSymbol,
} from "./nodes/symbols/Symbols.js";

const FALLBACK_SYMBOLS: Partial<Record<ComponentType, React.FC>> = {
  bjt_npn: BJTNPNSymbol,
  bjt_pnp: BJTPNPSymbol,
  mosfet_n: MOSFETNSymbol,
  mosfet_p: MOSFETNSymbol,
  ground: GroundSymbol,
  vsource: VoltageSourceSymbol,
  sinesource: SineSourceSymbol,
  pulsesource: PulseSourceSymbol,
};

interface SymbolPreviewProps {
  type: ComponentType;
  size: number;
  margin?: number;
  strokeWidth?: number;
  color?: string;
  /** Render `.asy` symbols at native 1:1 scale (matching the canvas node), used
   *  by the placement ghost so it is exactly the size of the placed component. */
  nativeScale?: boolean;
}

/**
 * Renders a component type's symbol (current norm variant) at a fixed pixel box,
 * falling back to the hand-drawn React symbols for types without an `.asy`.
 */
export function SymbolPreview({ type, size, margin = 4, strokeWidth = 1.2, color = "#334155", nativeScale = false }: SymbolPreviewProps) {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  // Net labels have no `.asy` symbol — draw a terminal + name-tag glyph so the
  // toolbar button and placement ghost show something recognisable.
  if (type === "netlabel") {
    return (
      <svg width={size} height={size} viewBox="0 0 80 80" style={{ flexShrink: 0, color, overflow: "visible" }}>
        <circle cx="40" cy="40" r="3" fill="currentColor" />
        <path d="M40 40 h12" stroke="currentColor" strokeWidth="2" fill="none" />
        <rect x="52" y="29" width="38" height="22" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M59 40 h24" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  const sym = symbolForType(type, symbolNorm);
  if (sym) {
    return (
      <span style={{ width: size, height: size, flexShrink: 0, color, display: "inline-block" }}>
        <AsySymbolView sym={sym} size={size} margin={margin} strokeWidth={strokeWidth} color={color} nativeScale={nativeScale} />
      </span>
    );
  }
  const Fallback = FALLBACK_SYMBOLS[type];
  if (Fallback) {
    // Match ComponentNode's fallback rendering exactly (viewBox -40..40 in an 80px box).
    // `non-scaling-stroke` (see index.css) keeps the hand-drawn symbols' strokes
    // at their authored pixel width instead of shrinking with the 80→size scale,
    // so they read as boldly as the fit-to-box `.asy` symbols (e.g. the voltage
    // source, which otherwise came out noticeably thinner in the palette/toolbar).
    return (
      <svg width={size} height={size} viewBox="-40 -40 80 80" className="sym-preview-fallback" style={{ flexShrink: 0, color }}>
        <Fallback />
      </svg>
    );
  }
  return <span style={{ width: size, flexShrink: 0 }} />;
}
