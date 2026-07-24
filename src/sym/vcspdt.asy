Version 4
SymbolType CELL
* Spannungsgesteuerter Wechselschalter (SPDT), IEC/EN.
*
* Der Kontakt wie beim handbetaetigten, darunter der Steller als Kasten mit
* seinem Anschlusspaar und der Wirklinie zur Zunge.
*
* Alle fuenf Anschluesse sitzen auf Multisims Raster: die beiden Kontakte 128
* rechts vom gemeinsamen und 16 ueber bzw. unter ihm, das Steuerpaar 32
* auseinander und 80 darunter. Vorher lagen die Steueranschluesse 16 auseinander
* und senkrecht - die uebernommene Steuerleitung traf sie dadurch nicht, und der
* Steuereingang landete auf Masse.
*
* Gezeichnet in der Ruhelage, also auf NC.
CIRCLE Normal 29 -3 35 3
CIRCLE Normal 93 -19 99 -13
CIRCLE Normal 93 13 99 19
LINE Normal 0 0 28 0
LINE Normal 100 -16 128 -16
LINE Normal 100 16 128 16
LINE Normal 32 0 92 -14
RECTANGLE Normal 48 56 80 72
LINE Normal 48 72 48 80
LINE Normal 80 72 80 80
LINE Normal 64 56 64 10
WINDOW 0 40 32 Left 2
WINDOW 3 40 54 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel vcspdt
SYMATTR Value vcspdt
SYMATTR SpiceLine Von=1 Voff=0
SYMATTR ModelFile vcspdt.lib
SYMATTR Description Spannungsgesteuerter Wechselschalter: unter Voff auf NC, ueber Von auf NO
PIN 0 0 NONE 0
PINATTR PinName COM
PINATTR SpiceOrder 1
PIN 128 -16 NONE 0
PINATTR PinName NC
PINATTR SpiceOrder 2
PIN 128 16 NONE 0
PINATTR PinName NO
PINATTR SpiceOrder 3
PIN 48 80 NONE 0
PINATTR PinName CP
PINATTR SpiceOrder 4
PIN 80 80 NONE 0
PINATTR PinName CN
PINATTR SpiceOrder 5
