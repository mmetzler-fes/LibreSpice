Version 4
SymbolType CELL
LINE Normal -31 -31 -31 31
LINE Normal -28 -16 -20 -16
LINE Normal -28 16 -20 16
LINE Normal -24 20 -24 12
LINE Normal 19 -37 25 -37
LINE Normal 22 -40 22 -34
LINE Normal 20 37 26 37
LINE Normal 31 -31 -31 -31
LINE Normal 31 31 31 -31
LINE Normal -31 31 31 31
LINE Normal -14 -15 -14 -28
LINE Normal -2 -22 -14 -15
LINE Normal -14 -28 -2 -22
LINE Normal 0 -31 0 -32
LINE Normal 0 31 0 32
LINE Normal 31 0 32 0
LINE Normal -32 -16 -31 -16
LINE Normal -31 16 -32 16
CIRCLE Normal 12 -18 4 -24
CIRCLE Normal 20 -18 12 -24
TEXT 8 37 Left 0 Ub
TEXT 7 -37 Left 0 Ub
TEXT 34 22 Left 2 OP
WINDOW 0 34 -24 Left 2
SYMATTR SpiceModel level2
SYMATTR Prefix X
SYMATTR Description A single pole op amp with one internal node, slew rate limit, and output voltage and current limit. See Educational/UniversalOpAmp.asc for more details.
SYMATTR Value2 Avol=1Meg GBW=10Meg Slew=10Meg
SYMATTR SpiceLine Ilimit=25m Rail=0 Vos=0
SYMATTR SpiceLine2 En=0 Enk=0 In=0 Ink=0 Rin=500Meg
SYMATTR ModelFile UniversalOpAmp2.lib
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
