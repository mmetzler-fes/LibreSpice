Version 4
SymbolType CELL
* Sieben-Segment-Anzeige mit gemeinsamer Anode.
*
* Anzeigefeld ueber sieben Segmentanschluessen, die gemeinsame Anode oben. Die
* Anschluesse liegen auf Multisims Raster: A..G unten in einer Reihe, 16
* auseinander, COM 208 darueber ueber dem ersten - damit trifft die uebernommene
* Verdrahtung die Pins unmittelbar.
*
* Anders als seg7hex ist das hier die blanke Anzeige ohne Dekoder: welches
* Segment leuchtet, entscheidet die Schaltung davor. Die Segmentleitungen sind
* aktiv low, weil die Anoden zusammenliegen.
*
* Die sieben Segmente sind Rechtecke, keine Sechsecke - das .asy-Format kennt
* Linie, Rechteck, Kreis und Bogen, aber kein Polygon.
RECTANGLE Normal 0 -192 96 -32
RECTANGLE Normal 30 -180 66 -172
RECTANGLE Normal 24 -174 32 -140
RECTANGLE Normal 64 -174 72 -140
RECTANGLE Normal 30 -140 66 -132
RECTANGLE Normal 24 -132 32 -98
RECTANGLE Normal 64 -132 72 -98
RECTANGLE Normal 30 -100 66 -92
LINE Normal 0 0 0 -32
LINE Normal 16 0 16 -32
LINE Normal 32 0 32 -32
LINE Normal 48 0 48 -32
LINE Normal 64 0 64 -32
LINE Normal 80 0 80 -32
LINE Normal 96 0 96 -32
LINE Normal 0 -208 0 -192
TEXT 0 -24 Left 0 a
TEXT 16 -24 Left 0 b
TEXT 32 -24 Left 0 c
TEXT 48 -24 Left 0 d
TEXT 64 -24 Left 0 e
TEXT 80 -24 Left 0 f
TEXT 96 -24 Left 0 g
TEXT 8 -200 Left 0 +
WINDOW 0 104 -192 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel seg7a
SYMATTR Value seg7a
SYMATTR ModelFile seg7a.lib
SYMATTR Description 7-Segment-Anzeige, gemeinsame Anode: Segmente aktiv low, COM an Plus
PIN 0 0 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 16 0 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 2
PIN 32 0 NONE 0
PINATTR PinName C
PINATTR SpiceOrder 3
PIN 48 0 NONE 0
PINATTR PinName D
PINATTR SpiceOrder 4
PIN 64 0 NONE 0
PINATTR PinName E
PINATTR SpiceOrder 5
PIN 80 0 NONE 0
PINATTR PinName F
PINATTR SpiceOrder 6
PIN 96 0 NONE 0
PINATTR PinName G
PINATTR SpiceOrder 7
PIN 0 -208 NONE 0
PINATTR PinName COM
PINATTR SpiceOrder 8
