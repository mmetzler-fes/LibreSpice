Version 4
SymbolType CELL
* Einfacher Schalter (SPST), IEC/EN: zwei feste Kontakte, dazwischen die Zunge.
*
* Die Anschluesse liegen genau dort, wo Multisim sie hat - 112 Einheiten
* auseinander auf einer Waagerechten. Das ist kein Zufall, sondern der Zweck:
* stimmt das Raster, landet die uebernommene Verdrahtung ohne Ueberbrueckung auf
* den Pins, und es entsteht weder ein Stichleitungsstummel noch ein Netz, das
* per Namen wieder zusammengesucht werden muss.
*
* Gezeichnet in der Ruhelage eines Schliessers: offen.
CIRCLE Normal 29 -3 35 3
CIRCLE Normal 77 -3 83 3
LINE Normal 0 0 28 0
LINE Normal 84 0 112 0
LINE Normal 32 0 76 -26
WINDOW 0 40 24 Left 2
WINDOW 3 40 46 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel spst
SYMATTR Value spst
SYMATTR SpiceLine pos=1
SYMATTR ModelFile spst.lib
SYMATTR Description Schalter (SPST): pos=1 geschlossen, pos=0 offen
PIN 0 0 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 112 0 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 2
