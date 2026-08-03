Version 4
SymbolType CELL
* Spannungsgesteuerter Schalter (SPICE S-Element), IEC/EN gezeichnet.
*
* Die Pin-Koordinaten sind LTSpices eigene (sw.asy): die beiden Kontakte
* senkrecht bei x=0 auf y=16 und y=96, das Steuerpaar 48 Einheiten links davon,
* NC+ unten (SpiceOrder 3) und NC- oben (SpiceOrder 4). Das ist kein Geschmack,
* sondern Kompatibilitaet: ein in LTSpice gezeichnetes Blatt legt seine Leitungen
* auf genau diese Punkte, und schon eine Einheit daneben trifft die Verdrahtung
* den Schalter nicht mehr.
*
* Gezeichnet ist die geoeffnete Ruhelage: die Zunge haengt am unteren Kontakt und
* steht ab. Der Steuereingang ist der Kasten links, mit gestrichelter Wirklinie
* zur Zunge - die uebliche Darstellung fuer "dieser Eingang betaetigt jenen
* Kontakt".
*
* Eigene Zeichnung, keine Uebernahme aus einer fremden Bibliothek.
LINE Normal 0 16 0 28
LINE Normal 0 96 0 84
CIRCLE Normal -3 29 3 35
CIRCLE Normal -3 77 3 83
LINE Normal 0 80 -22 42
RECTANGLE Normal -40 44 -26 68
LINE Normal -48 32 -40 32
LINE Normal -40 32 -40 44
LINE Normal -48 80 -40 80
LINE Normal -40 80 -40 68
LINE Normal -26 56 -11 56 2
WINDOW 0 8 40 Left 2
WINDOW 3 8 62 Left 2
SYMATTR Prefix S
SYMATTR Value SW
SYMATTR Description Spannungsgesteuerter Schalter: schaltet zwischen A und B, gesteuert ueber NC+/NC- nach .model <name> SW(Ron Roff Vt Vh)
PIN 0 16 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 0 96 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 2
PIN -48 80 NONE 0
PINATTR PinName NC+
PINATTR SpiceOrder 3
PIN -48 32 NONE 0
PINATTR PinName NC-
PINATTR SpiceOrder 4
