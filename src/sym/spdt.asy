Version 4
SymbolType CELL
* Wechselschalter (SPDT), IEC/EN: zwei feste Kontakte, die Zunge am gemeinsamen.
*
* Auf Multisims eigenem Raster gezeichnet - gemeinsamer Anschluss links, die
* beiden Kontakte 112 Einheiten rechts davon, der Ruhekontakt 48 darueber. So
* trifft die uebernommene Verdrahtung die Pins unmittelbar.
*
* Gezeichnet in der Ruhelage, also auf NC - dieselbe Stellung, die das Modell
* mit pos=0 rechnet.
CIRCLE Normal 29 -3 35 3
CIRCLE Normal 105 -51 111 -45
CIRCLE Normal 105 -3 111 3
LINE Normal 0 0 28 0
LINE Normal 108 -48 112 -48
LINE Normal 108 0 112 0
LINE Normal 32 0 104 -44
WINDOW 0 40 24 Left 2
WINDOW 3 40 46 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel spdt
SYMATTR Value spdt
SYMATTR SpiceLine pos=0
SYMATTR ModelFile spdt.lib
SYMATTR Description Wechselschalter (SPDT): pos=0 legt COM auf NC, pos=1 auf NO
PIN 0 0 NONE 0
PINATTR PinName COM
PINATTR SpiceOrder 1
PIN 112 -48 NONE 0
PINATTR PinName NC
PINATTR SpiceOrder 2
PIN 112 0 NONE 0
PINATTR PinName NO
PINATTR SpiceOrder 3
