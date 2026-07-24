Version 4
SymbolType CELL
* Spannungsgesteuerter Schalter (SPST), IEC/EN.
*
* Der Kontakt wie beim handbetaetigten, darunter der Steller als Kasten mit
* seinem Anschlusspaar und der Wirklinie zur Zunge - so sagt das Bild, dass der
* Kontakt einer Spannung folgt und nicht einer Hand.
*
* Alle vier Anschluesse sitzen auf Multisims Raster: Kontakt 128 auseinander,
* das Steuerpaar 32 auseinander und 64 darunter.
CIRCLE Normal 29 -3 35 3
CIRCLE Normal 93 -3 99 3
LINE Normal 0 0 28 0
LINE Normal 100 0 128 0
LINE Normal 32 0 92 -26
RECTANGLE Normal 48 40 80 56
LINE Normal 48 56 48 64
LINE Normal 80 56 80 64
LINE Normal 64 40 64 -8
WINDOW 0 40 24 Left 2
WINDOW 3 40 46 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel vcspst
SYMATTR Value vcspst
SYMATTR SpiceLine Von=1 Voff=0
SYMATTR ModelFile vcspst.lib
SYMATTR Description Spannungsgesteuerter Schalter: schliesst ueber Von, oeffnet unter Voff
PIN 0 0 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 128 0 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 2
PIN 48 64 NONE 0
PINATTR PinName CP
PINATTR SpiceOrder 3
PIN 80 64 NONE 0
PINATTR PinName CN
PINATTR SpiceOrder 4
