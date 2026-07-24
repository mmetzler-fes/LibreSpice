Version 4
SymbolType CELL
* Potentiometer, IEC/EN: Widerstandskoerper mit Schleiferpfeil auf die Flanke.
*
* Koerper und Anschluesse sind Zeichen fuer Zeichen die von res.asy — die
* Anschluesse A und B liegen damit auf demselben Raster wie bei einem Widerstand,
* und der Multisim-Import kann das Poti mit derselben Ausrichtungssuche setzen.
* Neu ist allein der Schleifer: waagerecht auf halber Hoehe herangefuehrt, mit
* der Pfeilspitze am Koerper statt am Anschluss, weil der Pfeil den Abgriff
* meint und nicht eine Stromrichtung.
LINE Normal 16 16 16 30
LINE Normal 16 82 16 96
RECTANGLE Normal 7 30 25 82
LINE Normal 64 48 27 48
LINE Normal 25 48 34 43
LINE Normal 25 48 34 53
WINDOW 0 -4 40 Right 2
WINDOW 3 -4 66 Right 2
SYMATTR Prefix X
SYMATTR SpiceModel pot
SYMATTR Value pot
SYMATTR SpiceLine Rtot=10k wiper=0.5
SYMATTR ModelFile pot.lib
SYMATTR Description Potentiometer: Gesamtwiderstand Rtot, Schleiferstellung wiper (0..1, von A nach B)
PIN 16 16 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 64 48 NONE 0
PINATTR PinName W
PINATTR SpiceOrder 2
PIN 16 96 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 3
