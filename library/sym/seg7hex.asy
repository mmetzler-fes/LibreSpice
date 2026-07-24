Version 4
SymbolType CELL
* Hexadezimale 7-Segment-Anzeige: Anzeigefeld ueber vier Binaereingaengen.
*
* Die Anschluesse liegen auf Multisims Raster - vier in einer Reihe, 32
* auseinander -, damit die uebernommene Verdrahtung sie unmittelbar trifft. Ihre
* Wertigkeit steht daneben: links das hoechstwertige Bit.
*
* Die sieben Segmente sind Rechtecke, keine Sechsecke: das .asy-Format kennt
* Linie, Rechteck, Kreis und Bogen, aber kein Polygon. Fuer die Umrisszeichnung
* reicht das. Gezeichnet wird die abgelesene Ziffer ohnehin nicht von hier,
* sondern vom Bauteil selbst, sobald ein Simulationsergebnis vorliegt.
RECTANGLE Normal 0 -128 96 -16
RECTANGLE Normal 30 -116 66 -108
RECTANGLE Normal 24 -110 32 -76
RECTANGLE Normal 64 -110 72 -76
RECTANGLE Normal 30 -76 66 -68
RECTANGLE Normal 24 -68 32 -34
RECTANGLE Normal 64 -68 72 -34
RECTANGLE Normal 30 -36 66 -28
LINE Normal 0 0 0 -16
LINE Normal 32 0 32 -16
LINE Normal 64 0 64 -16
LINE Normal 96 0 96 -16
TEXT 0 -8 Left 0 8
TEXT 32 -8 Left 0 4
TEXT 64 -8 Left 0 2
TEXT 96 -8 Left 0 1
WINDOW 0 104 -128 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel seg7hex
SYMATTR Value seg7hex
SYMATTR ModelFile seg7hex.lib
SYMATTR Description Hexadezimale 7-Segment-Anzeige: vier Binaereingaenge, D8 ist das hoechstwertige Bit
PIN 0 0 NONE 0
PINATTR PinName D8
PINATTR SpiceOrder 1
PIN 32 0 NONE 0
PINATTR PinName D4
PINATTR SpiceOrder 2
PIN 64 0 NONE 0
PINATTR PinName D2
PINATTR SpiceOrder 3
PIN 96 0 NONE 0
PINATTR PinName D1
PINATTR SpiceOrder 4
