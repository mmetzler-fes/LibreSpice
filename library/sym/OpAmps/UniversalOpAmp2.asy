Version 4
SymbolType CELL
* Operational amplifier, IEC 60617-13 style: a rectangular outline with the
* amplifier qualifying symbol (a triangle pointing in signal direction) and the
* infinity sign for the ideal, unbounded open-loop gain. Both are markings
* *inside* the box, not the outline itself — that is what separates the IEC
* drawing from the ANSI one, which is the bare triangle and carries no infinity
* sign (see UniversalOpamp2_ANSI.asy).
*
* The infinity sign is two tangent circles rather than a typed glyph: these files
* are read as latin1, which has no code point for it.
*
* Geometry traced back from opv.svg, the drawing revised by hand in Inkscape. The
* SVG is in millimetres and the symbol in LTSpice units, so every coordinate is
* scaled by 96/25.4 about the box centre — which lands the pins exactly on the
* interface they had before. Fractions were rounded to whole units, as the format
* wants; the two places where that would have broken a relationship are held by
* hand: the infinity circles stay tangent, and the Ub+ cross stays symmetric.
LINE Normal -31 -31 31 -31
LINE Normal 31 -31 31 31
LINE Normal 31 31 -31 31
LINE Normal -31 31 -31 -31
LINE Normal -8 -27 -8 -11
LINE Normal -8 -27 6 -19
LINE Normal -8 -11 6 -19
LINE Normal -32 16 -31 16
LINE Normal -32 -16 -31 -16
LINE Normal 0 -32 0 -31
LINE Normal 0 32 0 31
LINE Normal 31 0 32 0
LINE Normal -27 16 -19 16
LINE Normal -23 12 -23 20
LINE Normal -27 -16 -19 -16
LINE Normal 18 -38 22 -38
LINE Normal 20 -40 20 -36
LINE Normal 19 36 23 36
CIRCLE Normal 12 -22 18 -16
CIRCLE Normal 18 -22 24 -16
TEXT 8 37 Left 0 Ub
TEXT 7 -37 Left 0 Ub
WINDOW 0 34 -24 Left 2
SYMATTR SpiceModel level2
SYMATTR Prefix X
SYMATTR Value2 Avol=1Meg GBW=10Meg Slew=10Meg
SYMATTR SpiceLine Ilimit=25m Rail=0 Vos=0
SYMATTR SpiceLine2 En=0 Enk=0 In=0 Ink=0 Rin=500Meg
SYMATTR ModelFile UniversalOpAmp2.lib
SYMATTR Description Operational amplifier: single pole, one internal node, slew-rate limit, output voltage and current limits.
PIN -32 16 NONE 0
PINATTR PinName In+
PINATTR SpiceOrder 1
PIN -32 -16 NONE 0
PINATTR PinName In-
PINATTR SpiceOrder 2
PIN 0 -32 NONE 0
PINATTR PinName V+
PINATTR SpiceOrder 3
PIN 0 32 NONE 0
PINATTR PinName V-
PINATTR SpiceOrder 4
PIN 32 0 NONE 0
PINATTR PinName OUT
PINATTR SpiceOrder 5
