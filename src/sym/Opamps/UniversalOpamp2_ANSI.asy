Version 4
SymbolType CELL
LINE Normal -32 -32 32 0
LINE Normal -32 32 32 0
LINE Normal -32 -32 -32 32
LINE Normal 0 -32 0 -17
LINE Normal 0 32 0 17
LINE Normal -27 16 -19 16
LINE Normal -23 12 -23 20
LINE Normal -27 -16 -19 -16
LINE Normal 4 -21 12 -21
LINE Normal 8 -25 8 -17
LINE Normal 4 21 12 21
WINDOW 0 16 -32 Left 2
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
