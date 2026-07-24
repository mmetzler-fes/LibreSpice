Version 4
SymbolType CELL
* Idealer Komparator, drei Anschluesse: In+, In-, OUT.
*
* Dieselbe Zeichnung wie der dreipolige Operationsverstaerker, und das mit
* Absicht: nach IEC 60617-13 ist ein Komparator ein Verstaerker mit demselben
* Dreieck, und beide Werkzeuge zeichnen ihn auch so - Multisims `Ideal
* Comparator` ist optisch sein Operationsverstaerker. Unterschieden wird nicht
* am Bild, sondern am Modell: hier sind die Ausgangspegel Eigenschaft des
* Bauteils (Vhigh/Vlow) statt der Beschaltung.
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
SYMATTR SpiceModel comparator
SYMATTR Prefix X
SYMATTR Value comparator
SYMATTR SpiceLine Vhigh=5 Vlow=0 Trf=10n
SYMATTR ModelFile comparator.lib
SYMATTR Description Idealer Komparator: Ausgang springt zwischen Vlow und Vhigh, Flankendauer Trf
PIN -32 16 NONE 0
PINATTR PinName In+
PINATTR SpiceOrder 1
PIN -32 -16 NONE 0
PINATTR PinName In-
PINATTR SpiceOrder 2
PIN 32 0 NONE 0
PINATTR PinName OUT
PINATTR SpiceOrder 3
