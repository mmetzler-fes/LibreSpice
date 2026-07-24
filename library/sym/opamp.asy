Version 4
SymbolType CELL
* Ideal operational amplifier, three terminals: In+, In-, OUT.
*
* The same drawing as the five-terminal UniversalOpAmp2, with the supply pins
* and everything that marks them taken out — the box outline, the amplifier
* triangle, the +/- input marks and the infinity sign for the unbounded
* open-loop gain are all unchanged, so the two read as the same kind of part.
* Gone with the pins: the two stubs at 0,-32 and 0,32 and the `Ub` texts with
* their + and - marks.
*
* Both formats have this part and mean the same thing by it: LTSpice calls its
* three-terminal ideal one `opamp` and its five-terminal one `opamp2`, and
* Multisim Live has a `3 Terminal Opamp` beside its five-terminal one. Keeping
* LTSpice's name for the file is what lets a schematic cross between the two
* without the part changing shape.
LINE Normal -31 -31 31 -31
LINE Normal 31 -31 31 31
LINE Normal 31 31 -31 31
LINE Normal -31 31 -31 -31
LINE Normal -8 -27 -8 -11
LINE Normal -8 -27 6 -19
LINE Normal -8 -11 6 -19
LINE Normal -32 16 -31 16
LINE Normal -32 -16 -31 -16
LINE Normal 31 0 32 0
LINE Normal -27 16 -19 16
LINE Normal -23 12 -23 20
LINE Normal -27 -16 -19 -16
CIRCLE Normal 12 -22 18 -16
CIRCLE Normal 18 -22 24 -16
WINDOW 0 34 -24 Left 2
SYMATTR SpiceModel opamp
SYMATTR Prefix X
SYMATTR Value opamp
SYMATTR ModelFile opamp.lib
SYMATTR Description Idealer Operationsverstaerker, 3 Anschluesse: keine Versorgung, keine Begrenzung
PIN -32 16 NONE 0
PINATTR PinName In+
PINATTR SpiceOrder 1
PIN -32 -16 NONE 0
PINATTR PinName In-
PINATTR SpiceOrder 2
PIN 32 0 NONE 0
PINATTR PinName OUT
PINATTR SpiceOrder 3
