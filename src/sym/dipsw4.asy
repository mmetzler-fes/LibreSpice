Version 4
SymbolType CELL
* DIP-Schalterblock mit vier Schaltern, IEC/EN.
*
* Vier senkrechte Schliesser nebeneinander im gemeinsamen Gehaeuse. Die
* Anschluesse liegen auf Multisims Raster: unten P1..P4, oben P8..P5, jeweils 16
* auseinander und 80 hoch. Gegenueberliegende Pins gehoeren zum selben Schalter
* (1-8, 2-7, 3-6, 4-5) - dieselbe Zuordnung wie am echten Gehaeuse und wie im
* .subckt (siehe dipsw4.lib).
*
* Gezeichnet in der Ruhelage: alle vier offen.
RECTANGLE Normal -8 -72 56 -8
LINE Normal 0 0 0 -8
LINE Normal 16 0 16 -8
LINE Normal 32 0 32 -8
LINE Normal 48 0 48 -8
LINE Normal 0 -72 0 -80
LINE Normal 16 -72 16 -80
LINE Normal 32 -72 32 -80
LINE Normal 48 -72 48 -80
LINE Normal 0 -16 6 -64
LINE Normal 16 -16 22 -64
LINE Normal 32 -16 38 -64
LINE Normal 48 -16 54 -64
CIRCLE Normal -2 -18 2 -14
CIRCLE Normal 14 -18 18 -14
CIRCLE Normal 30 -18 34 -14
CIRCLE Normal 46 -18 50 -14
CIRCLE Normal -2 -66 2 -62
CIRCLE Normal 14 -66 18 -62
CIRCLE Normal 30 -66 34 -62
CIRCLE Normal 46 -66 50 -62
WINDOW 0 64 -72 Left 2
WINDOW 3 64 -50 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel dipsw4
SYMATTR Value dipsw4
SYMATTR SpiceLine pos1=0 pos2=0 pos3=0 pos4=0
SYMATTR ModelFile dipsw4.lib
SYMATTR Description DIP-Schalterblock, vier Schliesser: pos<n>=1 geschlossen, 0 offen
PIN 0 0 NONE 0
PINATTR PinName P1
PINATTR SpiceOrder 1
PIN 16 0 NONE 0
PINATTR PinName P2
PINATTR SpiceOrder 2
PIN 32 0 NONE 0
PINATTR PinName P3
PINATTR SpiceOrder 3
PIN 48 0 NONE 0
PINATTR PinName P4
PINATTR SpiceOrder 4
PIN 48 -80 NONE 0
PINATTR PinName P5
PINATTR SpiceOrder 5
PIN 32 -80 NONE 0
PINATTR PinName P6
PINATTR SpiceOrder 6
PIN 16 -80 NONE 0
PINATTR PinName P7
PINATTR SpiceOrder 7
PIN 0 -80 NONE 0
PINATTR PinName P8
PINATTR SpiceOrder 8
