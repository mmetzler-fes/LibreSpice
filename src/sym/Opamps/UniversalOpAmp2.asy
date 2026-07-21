Version 4
SymbolType CELL
* Operational amplifier, IEC 60617-13 style: a rectangular outline carrying the
* amplifier qualifying symbol (a triangle pointing in signal direction) followed
* by the infinity sign for the ideal, unbounded open-loop gain. Both are
* markings *inside* the box, not the outline itself - that is what separates the
* IEC drawing from the ANSI one, which is the bare triangle and carries no
* infinity sign (see UniversalOpamp2_ANSI.asy).
*
* The infinity sign is drawn as two tangent circles rather than typed: these
* files are read as latin1, which has no code point for it, so a TEXT line would
* not survive the read.
*
* The inputs are told apart by the - and + beside them, the supplies by the
* marks next to Ub.
LINE Normal -31 -31 31 -31
LINE Normal 31 -31 31 31
LINE Normal 31 31 -31 31
LINE Normal -31 31 -31 -31
LINE Normal -16 -20 -16 -4
LINE Normal -16 -20 -2 -12
LINE Normal -16 -4 -2 -12
CIRCLE Normal 2 -16 10 -8
CIRCLE Normal 10 -16 18 -8
LINE Normal -32 16 -31 16
LINE Normal -32 -16 -31 -16
LINE Normal 0 -32 0 -31
LINE Normal 0 32 0 31
LINE Normal 31 0 32 0
LINE Normal -27 16 -19 16
LINE Normal -23 12 -23 20
LINE Normal -27 -16 -19 -16
LINE Normal 18 -36 26 -36
LINE Normal 22 -40 22 -32
LINE Normal 18 36 26 36
TEXT 8 37 Left 0 Ub
TEXT 7 -37 Left 0 Ub
TEXT 34 22 Left 2 OP
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
