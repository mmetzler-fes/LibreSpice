Version 4
SymbolType CELL
* Transformator mit einer Primaer- und einer Sekundaerwicklung, IEC/EN.
*
* Zwei Wicklungen als Bogenreihen, dazwischen die beiden Kernstriche. Die
* Anschluesse liegen auf Multisims Raster: P2 64 unter P1, die Sekundaerseite
* 128 rechts daneben - damit trifft die uebernommene Verdrahtung die Pins ohne
* Ueberbrueckung.
*
* Die Punkte an P1 und S1 sind der Wickelsinn: gleichsinnige Anschluesse. Das
* Modell rechnet mit positivem Verhaeltnis, also genau so herum (siehe
* xfmr.lib) - wer die Sekundaerseite umdreht, dreht die Phase.
CIRCLE Normal 36 4 44 12
CIRCLE Normal 84 4 92 12
LINE Normal 0 0 32 0
LINE Normal 0 64 32 64
LINE Normal 96 0 128 0
LINE Normal 96 64 128 64
ARC Normal 24 8 40 24 32 8 32 24
ARC Normal 24 24 40 40 32 24 32 40
ARC Normal 24 40 40 56 32 40 32 56
ARC Normal 88 8 104 24 96 24 96 8
ARC Normal 88 24 104 40 96 40 96 24
ARC Normal 88 40 104 56 96 56 96 40
LINE Normal 56 4 56 60
LINE Normal 72 4 72 60
WINDOW 0 48 -24 Center 2
WINDOW 3 48 72 Center 2
SYMATTR Prefix X
SYMATTR SpiceModel xfmr
SYMATTR Value xfmr
SYMATTR SpiceLine ratio=1
SYMATTR ModelFile xfmr.lib
SYMATTR Description Uebertrager, ideal: ratio = Ns/Np, Lm ist die Hauptinduktivitaet
PIN 0 0 NONE 0
PINATTR PinName P1
PINATTR SpiceOrder 1
PIN 0 64 NONE 0
PINATTR PinName P2
PINATTR SpiceOrder 2
PIN 128 0 NONE 0
PINATTR PinName S1
PINATTR SpiceOrder 3
PIN 128 64 NONE 0
PINATTR PinName S2
PINATTR SpiceOrder 4
