export const ResistorSymbol = () => (
  <g>
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <rect x="-8" y="-20" width="16" height="40" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const CapacitorSymbol = () => (
  <g>
    <line x1="0" y1="-30" x2="0" y2="-5" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-14" y1="-5" x2="14" y2="-5" stroke="currentColor" strokeWidth="2" />
    <line x1="-14" y1="5" x2="14" y2="5" stroke="currentColor" strokeWidth="2" />
    <line x1="0" y1="5" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const InductorSymbol = () => (
  <g>
    <line x1="0" y1="-30" x2="0" y2="-22" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M0,-22 Q6,-22 6,-16 Q6,-10 0,-10 Q-6,-10 -6,-4 Q-6,2 0,2 Q6,2 6,8 Q6,14 0,14 Q-6,14 -6,20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const DiodeSymbol = () => (
  <g>
    <line x1="0" y1="-30" x2="0" y2="-12" stroke="currentColor" strokeWidth="1.5" />
    <polygon points="0,-12 10,10 -10,10" fill="currentColor" />
    <line x1="-12" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="2" />
    <line x1="0" y1="10" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const LEDSymbol = () => (
  <g>
    <DiodeSymbol />
    <line x1="6" y1="-2" x2="18" y2="-14" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#arrow)" />
    <line x1="10" y1="4" x2="22" y2="-8" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#arrow)" />
  </g>
);

export const BJTNPNSymbol = () => (
  <g>
    <line x1="0" y1="-40" x2="0" y2="40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-40" y1="0" x2="0" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-15" x2="30" y2="-40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="15" x2="30" y2="40" stroke="currentColor" strokeWidth="1.5" />
    <polygon points="20,30 30,40 18,38" fill="currentColor" />
  </g>
);

export const BJTPNPSymbol = () => (
  <g>
    <line x1="0" y1="-40" x2="0" y2="40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-40" y1="0" x2="0" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-15" x2="30" y2="-40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="15" x2="30" y2="40" stroke="currentColor" strokeWidth="1.5" />
    <polygon points="10,-26 0,-15 12,-12" fill="currentColor" />
  </g>
);

export const MOSFETNSymbol = () => (
  <g>
    <line x1="0" y1="-40" x2="0" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 2" />
    <line x1="8" y1="-20" x2="8" y2="20" stroke="currentColor" strokeWidth="2" />
    <line x1="-40" y1="0" x2="8" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="8" y1="-16" x2="30" y2="-16" stroke="currentColor" strokeWidth="1.5" />
    <line x1="8" y1="16" x2="30" y2="16" stroke="currentColor" strokeWidth="1.5" />
    <line x1="30" y1="-16" x2="30" y2="-40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="30" y1="16" x2="30" y2="40" stroke="currentColor" strokeWidth="1.5" />
    <polygon points="20,4 30,0 20,-4" fill="currentColor" />
  </g>
);

/**
 * Junction FET, N-channel: the channel as a bar with the gate arrow *into* it.
 *
 * The arrow direction is the whole difference between the two channel types, and
 * it is the gate-junction diode's direction — into the channel for N, out of it
 * for P. Drawn with a solid channel, unlike the MOSFET's dashed one, because that
 * is the physical difference: the JFET's channel is there without a gate voltage.
 *
 * Drain and source leave to the *right* and their terminals sit at the end of
 * those leads, not on the channel bar — the same places njf.asy puts them, so the
 * part docks where it is drawn whether the symbol file is loaded or not. Drawn
 * with the terminals on the bar, the two leads hung in the air beside three
 * connection points that were not where the wire had to go.
 */
const JFETBody = () => (
  <>
    <line x1="-14" y1="-28" x2="-14" y2="28" stroke="currentColor" strokeWidth="2" />
    <line x1="-40" y1="0" x2="-14" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-14" y1="-20" x2="32" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="32" y1="-20" x2="32" y2="-40" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-14" y1="20" x2="32" y2="20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="32" y1="20" x2="32" y2="40" stroke="currentColor" strokeWidth="1.5" />
  </>
);

export const JFETNSymbol = () => (
  <g>
    <JFETBody />
    <polygon points="-26,-5 -26,5 -16,0" fill="currentColor" />
  </g>
);

export const JFETPSymbol = () => (
  <g>
    <JFETBody />
    <polygon points="-28,0 -18,-5 -18,5" fill="currentColor" />
  </g>
);

export const VoltageSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <text x="0" y="-5" textAnchor="middle" fontSize="16" fontWeight="700" fill="currentColor">+</text>
    <text x="0" y="11" textAnchor="middle" fontSize="16" fontWeight="700" fill="currentColor">−</text>
  </g>
);

export const CurrentSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-12" x2="0" y2="12" stroke="currentColor" strokeWidth="1.5" />
    <polygon points="-5,-4 5,-4 0,-14" fill="currentColor" />
  </g>
);

export const SineSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <path d="M-12,0 Q-6,-10 0,0 Q6,10 12,0" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const PulseSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <polyline points="-12,8 -12,-8 -2,-8 -2,8 8,8 8,-8" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

/**
 * Logic gate, drawn in the IEC rectangular style (`&`, `≥1`, `=1`) rather than
 * the ANSI distinctive shapes.
 *
 * The rectangle is one shape for every gate, so a variable input count needs no
 * separate artwork per pin count — and the schematics this serves are German
 * teaching sheets, where IEC is the notation in use.
 */
export const LogicGateSymbol = ({ gate = "and", inputs = 2 }: { gate?: string; inputs?: number }) => {
  const marks: Record<string, string> = {
    and: "&", nand: "&", or: "≥1", nor: "≥1",
    xor: "=1", xnor: "=1", not: "1", buffer: "1",
  };
  const negated = ["nand", "nor", "xnor", "not"].includes(gate);
  const n = ["not", "buffer"].includes(gate) ? 1 : inputs;
  const span = 48;
  return (
    <g>
      <rect x="-20" y="-28" width="40" height="56" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="0" y="0" textAnchor="middle" dominantBaseline="central"
        fontSize="13" fontFamily="sans-serif" fill="currentColor" stroke="none">
        {marks[gate] ?? "&"}
      </text>
      {/* Input leads, spread to match the component's port positions. */}
      {Array.from({ length: n }, (_, i) => {
        const y = n === 1 ? 0 : Math.round(-span / 2 + (span * i) / (n - 1));
        return <line key={i} x1="-32" y1={y} x2="-20" y2={y} stroke="currentColor" strokeWidth="1.5" />;
      })}
      {/* Inversion bubble sits on the output edge, shortening the output lead. */}
      {negated && <circle cx="24" cy="0" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      <line x1={negated ? 28 : 20} y1="0" x2="32" y2="0" stroke="currentColor" strokeWidth="1.5" />
    </g>
  );
};

/**
 * D flip-flop, drawn in the IEC style: a plain box with the pins named inside
 * and a wedge marking the clock. The wedge points into the box on a rising-edge
 * part and carries an inversion bubble on a falling-edge one, which is the only
 * visual difference between the two.
 */
/**
 * D flip-flop / T flip-flop / D latch, drawn to Multisim's pin raster.
 *
 * The pin positions are a compatibility surface — they decide where a saved
 * `.asc` puts its terminals — so the drawing follows them rather than the other
 * way round. See the note in MultisimConverter's PIN_OFFSETS for the attempt to
 * move both onto Multisim's raster, and why it was reverted.
 */
export const DFlipFlopSymbol = ({ edge = "rising", asyncPolarity = "high", kind = "dff" }: { edge?: string; asyncPolarity?: string; kind?: string }) => {
  const latch = kind === "dlatch";
  const falling = edge === "falling";
  const asyncLow = asyncPolarity === "low";
  const pin = { fontSize: 8, fontFamily: "sans-serif", fill: "currentColor", stroke: "none" } as const;
  return (
    <g>
      <rect x="-20" y="-40" width="40" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" />

      {/* Left: D above, clock below. */}
      <line x1="-32" y1="-24" x2="-20" y2="-24" stroke="currentColor" strokeWidth="1.5" />
      <text x="-17" y="-24" textAnchor="start" dominantBaseline="central" {...pin}>{kind === "tff" ? "T" : "D"}</text>
      <line x1="-32" y1="24" x2="-20" y2="24" stroke="currentColor" strokeWidth="1.5" />
      {/* A latch is level-sensitive, so it gets a named EN pin; the flip-flops
          get the clock wedge, bubbled when they trigger on the falling edge. */}
      {latch ? (
        <text x="-17" y="24" textAnchor="start" dominantBaseline="central" {...pin}>EN</text>
      ) : (
        <>
          {falling && <circle cx="-24" cy="24" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
          <polyline points="-20,19 -13,24 -20,29" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}

      {/* Right: Q and its complement, the bar drawn rather than typed so it
          lines up with the glyph at any font size. */}
      <line x1="20" y1="-24" x2="32" y2="-24" stroke="currentColor" strokeWidth="1.5" />
      <text x="17" y="-24" textAnchor="end" dominantBaseline="central" {...pin}>Q</text>
      <line x1="20" y1="24" x2="32" y2="24" stroke="currentColor" strokeWidth="1.5" />
      <text x="17" y="24" textAnchor="end" dominantBaseline="central" {...pin}>Q</text>
      <line x1="10" y1="17" x2="17" y2="17" stroke="currentColor" strokeWidth="1" />

      {/* Top and bottom: the asynchronous pins, bubbled when they are active low. */}
      <line x1="0" y1="-48" x2="0" y2="-40" stroke="currentColor" strokeWidth="1.5" />
      {asyncLow && <circle cx="0" cy="-43.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      <text x="0" y="-33" textAnchor="middle" dominantBaseline="central" {...pin}>S</text>
      <line x1="0" y1="40" x2="0" y2="48" stroke="currentColor" strokeWidth="1.5" />
      {asyncLow && <circle cx="0" cy="43.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      <text x="0" y="33" textAnchor="middle" dominantBaseline="central" {...pin}>R</text>
    </g>
  );
};

/**
 * Piecewise-linear source. Drawn as a ramp-hold-ramp trace so it reads as
 * sloped segments at a glance, rather than the square edges of the pulse
 * source it sits next to in the type selector.
 */
export const PWLSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <polyline points="-13,8 -5,-8 4,-8 12,8" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

export const GroundSymbol = () => (
  <g>
    {/* Connection point is the top of the vertical line, at y = -24 — a multiple
        of the 8 px grid, so the terminal lands on grid lines (and thus on wires)
        exactly like every other pin. */}
    <line x1="0" y1="-24" x2="0" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-16" y1="0" x2="16" y2="0" stroke="currentColor" strokeWidth="2" />
    <line x1="-10" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="2" />
    <line x1="-4" y1="12" x2="4" y2="12" stroke="currentColor" strokeWidth="2" />
  </g>
);

/**
 * Hexadecimal seven-segment display, lit from a simulation result.
 *
 * The first part on the sheet that reads a result rather than only a property.
 * That is a line the project had not crossed — a component was a netlist line
 * and static artwork, and everything showing a *measurement* lived in an overlay
 * (the data flags). It is crossed here on purpose and only here: an indicator is
 * a part whose whole job is to be read, and drawing it dark would be drawing it
 * wrong.
 *
 * `value` is the decoded nibble, or null when there is nothing to show — no run
 * yet, or an input on no net. Dark segments stay drawn in outline so the part
 * keeps its shape either way.
 */
const SEG7_PATTERNS: Record<number, string> = {
  //        abcdefg
  0x0: "1111110", 0x1: "0110000", 0x2: "1101101", 0x3: "1111001",
  0x4: "0110011", 0x5: "1011011", 0x6: "1011111", 0x7: "1110000",
  0x8: "1111111", 0x9: "1111011", 0xa: "1110111", 0xb: "0011111",
  0xc: "1001110", 0xd: "0111101", 0xe: "1001111", 0xf: "1000111",
};

/** Segment rectangles in the symbol's own frame: a, b, c, d, e, f, g. */
const SEG7_BARS: [number, number, number, number][] = [
  [32, -116, 32, 8],  // a  top
  [66, -108, 8, 30],  // b  upper right
  [66, -66, 8, 30],   // c  lower right
  [32, -36, 32, 8],   // d  bottom
  [22, -66, 8, 30],   // e  lower left
  [22, -108, 8, 30],  // f  upper left
  [32, -76, 32, 8],   // g  middle
];

export const SevenSegmentSymbol = ({ value, lit = "#e11d48" }: { value: number | null; lit?: string }) => {
  const pattern = value === null ? null : SEG7_PATTERNS[value & 0xf];
  return (
    <g>
      <rect x={0} y={-128} width={96} height={112} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {/* Filled, never outlined. Seven stroked rectangles overlap at every corner
          and read as a heap of boxes rather than a digit; filled, the dark ones
          simply recede and the lit ones make the numeral. */}
      {SEG7_BARS.map(([x, y, w, h], i) => (
        <rect
          key={i} x={x} y={y} width={w} height={h} rx={2}
          fill={pattern && pattern[i] === "1" ? lit : "currentColor"}
          opacity={pattern && pattern[i] === "1" ? 1 : 0.12}
        />
      ))}
      {[0, 32, 64, 96].map((x) => (
        <line key={x} x1={x} y1={0} x2={x} y2={-16} stroke="currentColor" strokeWidth="1.5" />
      ))}
    </g>
  );
};
