Version 4
SymbolType CELL
* Spannungsgesteuerte Spannungsquelle (VCVS), IEC/EN.
*
* Die Raute ist das Zeichen fuer die gesteuerte Quelle; rechts haengt ihr
* Klemmenpaar, links das Steuerpaar. Dass die Steueranschluesse offen enden
* (die zwei Kreise) ist keine Ziererei, sondern die Aussage des Bauteils: es
* nimmt die Spannung ab, ohne Strom zu ziehen.
*
* Alle vier Anschluesse sitzen auf Multisims Raster: die Paare 112 auseinander,
* Steuer- und Klemmenseite 48 auseinander -- die Masse der Datei, umgerechnet,
* damit das Teil zwischen seinen Nachbarn Platz hat und nicht ueber sie faellt.
LINE Normal 48 0 24 0
LINE Normal 24 0 24 32
LINE Normal 48 112 24 112
LINE Normal 24 112 24 80
LINE Normal 24 32 40 56
LINE Normal 40 56 24 80
LINE Normal 24 80 8 56
LINE Normal 8 56 24 32
LINE Normal 0 0 12 0
LINE Normal 0 112 12 112
CIRCLE Normal 12 -3 18 3
CIRCLE Normal 12 109 18 115
TEXT 24 44 Center 1 +
TEXT 24 70 Center 1 -
WINDOW 0 56 40 Left 2
WINDOW 3 56 66 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel vcvs
SYMATTR Value vcvs
SYMATTR SpiceLine Gain=1
SYMATTR ModelFile vcvs.lib
SYMATTR Description Spannungsgesteuerte Spannungsquelle: U_aus = Gain * U_ein
PIN 48 0 NONE 0
PINATTR PinName OP
PINATTR SpiceOrder 1
PIN 48 112 NONE 0
PINATTR PinName ON
PINATTR SpiceOrder 2
PIN 0 0 NONE 0
PINATTR PinName CP
PINATTR SpiceOrder 3
PIN 0 112 NONE 0
PINATTR PinName CN
PINATTR SpiceOrder 4
