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
}

/**
 * Renders a component type's symbol (current norm variant) at a fixed pixel box,
 * falling back to the hand-drawn React symbols for types without an `.asy`.
 */
export function SymbolPreview({ type, size, margin = 4, strokeWidth = 1.2, color = "#334155" }: SymbolPreviewProps) {
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const sym = symbolForType(type, symbolNorm);
  if (sym) {
    return (
      <span style={{ width: size, height: size, flexShrink: 0, color, display: "inline-block" }}>
        <AsySymbolView sym={sym} size={size} margin={margin} strokeWidth={strokeWidth} color={color} />
      </span>
    );
  }
  const Fallback = FALLBACK_SYMBOLS[type];
  if (Fallback) {
    // Match ComponentNode's fallback rendering exactly (viewBox -40..40 in an 80px box).
    return (
      <svg width={size} height={size} viewBox="-40 -40 80 80" style={{ flexShrink: 0, color }}>
        <Fallback />
      </svg>
    );
  }
  return <span style={{ width: size, flexShrink: 0 }} />;
}
