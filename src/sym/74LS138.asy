Version 4
SymbolType BLOCK
* 74LS138, 1-aus-8-Dekoder.
*
* Die Anschluesse liegen auf Multisims Raster: die sechs Eingaenge links, 16
* auseinander, mit der Luecke zwischen Adress- und Freigabegruppe, die acht
* Ausgaenge rechts 192 daneben. Damit trifft die uebernommene Verdrahtung die
* Pins ohne Ueberbrueckung.
*
* Die Reihenfolge ist die des .subckt (siehe 74LS138.lib) und nicht frei:
* A B C G1 G2A G2B, dann Y0..Y7.
RECTANGLE Normal 48 -16 144 128
TEXT 96 -4 Center 0 74LS138
TEXT 56 0 Left 0 A
TEXT 56 16 Left 0 B
TEXT 56 32 Left 0 C
TEXT 56 64 Left 0 G1
TEXT 56 80 Left 0 ~G2A
TEXT 56 96 Left 0 ~G2B
TEXT 136 0 Right 0 0
TEXT 136 16 Right 0 1
TEXT 136 32 Right 0 2
TEXT 136 48 Right 0 3
TEXT 136 64 Right 0 4
TEXT 136 80 Right 0 5
TEXT 136 96 Right 0 6
TEXT 136 112 Right 0 7
LINE Normal 0 0 48 0
LINE Normal 0 16 48 16
LINE Normal 0 32 48 32
LINE Normal 0 64 48 64
LINE Normal 0 80 48 80
LINE Normal 0 96 48 96
LINE Normal 144 0 192 0
LINE Normal 144 16 192 16
LINE Normal 144 32 192 32
LINE Normal 144 48 192 48
LINE Normal 144 64 192 64
LINE Normal 144 80 192 80
LINE Normal 144 96 192 96
LINE Normal 144 112 192 112
WINDOW 0 96 -24 Center 2
SYMATTR Prefix X
SYMATTR SpiceModel 74LS138
SYMATTR Value 74LS138
SYMATTR ModelFile 74LS138.lib
SYMATTR Description 1-aus-8-Dekoder: gewaehlter Ausgang low, Freigabe ueber G1 high und G2A/G2B low
PIN 0 0 LEFT 8
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 0 16 LEFT 8
PINATTR PinName B
PINATTR SpiceOrder 2
PIN 0 32 LEFT 8
PINATTR PinName C
PINATTR SpiceOrder 3
PIN 0 64 LEFT 8
PINATTR PinName G1
PINATTR SpiceOrder 4
PIN 0 80 LEFT 8
PINATTR PinName G2A
PINATTR SpiceOrder 5
PIN 0 96 LEFT 8
PINATTR PinName G2B
PINATTR SpiceOrder 6
PIN 192 0 RIGHT 8
PINATTR PinName Y0
PINATTR SpiceOrder 7
PIN 192 16 RIGHT 8
PINATTR PinName Y1
PINATTR SpiceOrder 8
PIN 192 32 RIGHT 8
PINATTR PinName Y2
PINATTR SpiceOrder 9
PIN 192 48 RIGHT 8
PINATTR PinName Y3
PINATTR SpiceOrder 10
PIN 192 64 RIGHT 8
PINATTR PinName Y4
PINATTR SpiceOrder 11
PIN 192 80 RIGHT 8
PINATTR PinName Y5
PINATTR SpiceOrder 12
PIN 192 96 RIGHT 8
PINATTR PinName Y6
PINATTR SpiceOrder 13
PIN 192 112 RIGHT 8
PINATTR PinName Y7
PINATTR SpiceOrder 14
