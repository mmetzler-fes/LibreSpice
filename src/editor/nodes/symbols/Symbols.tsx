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

export const VoltageSourceSymbol = () => (
  <g>
    <circle cx="0" cy="0" r="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="-30" x2="0" y2="-20" stroke="currentColor" strokeWidth="1.5" />
    <line x1="0" y1="20" x2="0" y2="30" stroke="currentColor" strokeWidth="1.5" />
    <text x="0" y="-6" textAnchor="middle" fontSize="12" fill="currentColor">+</text>
    <text x="0" y="10" textAnchor="middle" fontSize="12" fill="currentColor">−</text>
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

export const GroundSymbol = () => (
  <g>
    <line x1="0" y1="-10" x2="0" y2="0" stroke="currentColor" strokeWidth="1.5" />
    <line x1="-16" y1="0" x2="16" y2="0" stroke="currentColor" strokeWidth="2" />
    <line x1="-10" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="2" />
    <line x1="-4" y1="12" x2="4" y2="12" stroke="currentColor" strokeWidth="2" />
  </g>
);
