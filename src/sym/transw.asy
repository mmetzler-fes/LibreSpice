Version 4
SymbolType CELL
* Transistorschalter mit Inversdiode, IEC/EN.
*
* Senkrechter Kontakt zwischen P (oben) und N (unten), links der Steuereingang
* mit seiner Wirklinie zur Zunge, rechts die Inversdiode gegen die Durchlass-
* richtung des Kontakts - so wie sie in einem Leistungstransistor liegt.
*
* Die drei Anschluesse liegen auf Multisims Raster: N 96 unter P, der
* Steuereingang 48 links und 48 tief. Damit trifft die uebernommene
* Verdrahtung die Pins ohne Ueberbrueckung.
*
* Gezeichnet im gesperrten Zustand: der Kontakt ist offen.
CIRCLE Normal -3 21 3 27
CIRCLE Normal -3 69 3 75
LINE Normal 0 0 0 20
LINE Normal 0 76 0 96
LINE Normal 0 24 26 68
LINE Normal -48 48 -14 48
LINE Normal 32 24 32 72
LINE Normal 0 32 32 32
LINE Normal 0 64 32 64
LINE Normal 20 40 44 40
LINE Normal 44 40 32 60
LINE Normal 32 60 20 40
LINE Normal 20 60 44 60
WINDOW 0 48 8 Left 2
WINDOW 3 48 30 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel transw
SYMATTR Value transw
SYMATTR SpiceLine Von=5 Voff=0
SYMATTR ModelFile transw.lib
SYMATTR Description Transistorschalter mit Inversdiode; CTRL ist einpolig gegen Masse
PIN 0 0 NONE 0
PINATTR PinName P
PINATTR SpiceOrder 1
PIN 0 96 NONE 0
PINATTR PinName N
PINATTR SpiceOrder 2
PIN -48 48 NONE 0
PINATTR PinName CTRL
PINATTR SpiceOrder 3
