Version 4
SymbolType BLOCK
* 74LS139, 1-aus-4-Dekoder (eine Haelfte des Doppelbausteins).
*
* Die Anschluesse liegen auf Multisims Raster: A und B links 16 auseinander,
* die Freigabe ~G 32 darunter, die vier Ausgaenge rechts 192 daneben. Damit
* trifft die uebernommene Verdrahtung die Pins ohne Ueberbrueckung.
*
* Die Reihenfolge ist die des .subckt (siehe 74LS139.lib) und nicht frei:
* A B G, dann Y0..Y3.
RECTANGLE Normal 48 -16 144 64
TEXT 96 -4 Center 0 74LS139
TEXT 56 0 Left 0 A
TEXT 56 16 Left 0 B
TEXT 56 48 Left 0 ~G
TEXT 136 0 Right 0 0
TEXT 136 16 Right 0 1
TEXT 136 32 Right 0 2
TEXT 136 48 Right 0 3
LINE Normal 0 0 48 0
LINE Normal 0 16 48 16
LINE Normal 0 48 48 48
LINE Normal 144 0 192 0
LINE Normal 144 16 192 16
LINE Normal 144 32 192 32
LINE Normal 144 48 192 48
WINDOW 0 96 -24 Center 2
SYMATTR Prefix X
SYMATTR SpiceModel 74LS139
SYMATTR Value 74LS139
SYMATTR ModelFile 74LS139.lib
SYMATTR Description 1-aus-4-Dekoder: gewaehlter Ausgang low, Freigabe ueber ~G low
PIN 0 0 LEFT 8
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 0 16 LEFT 8
PINATTR PinName B
PINATTR SpiceOrder 2
PIN 0 48 LEFT 8
PINATTR PinName G
PINATTR SpiceOrder 3
PIN 192 0 RIGHT 8
PINATTR PinName Y0
PINATTR SpiceOrder 4
PIN 192 16 RIGHT 8
PINATTR PinName Y1
PINATTR SpiceOrder 5
PIN 192 32 RIGHT 8
PINATTR PinName Y2
PINATTR SpiceOrder 6
PIN 192 48 RIGHT 8
PINATTR PinName Y3
PINATTR SpiceOrder 7
