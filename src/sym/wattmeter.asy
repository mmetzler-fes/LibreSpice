Version 4
SymbolType CELL
* Wattmeter: Spannungspfad und Strompfad in einem Gehaeuse.
*
* Die vier Anschluesse liegen auf Multisims Raster - in einer Reihe, 32
* auseinander -, damit die uebernommene Verdrahtung sie unmittelbar trifft. Ihre
* Rolle steht darueber: links das Spannungspaar, rechts das Strompaar. Die
* Reihenfolge ist nicht frei; sie ist die des .subckt (siehe wattmeter.lib).
*
* Im Kasten das Formelzeichen, nicht der Messwert: was das Geraet anzeigt, ist
* P = V(VP,VN) * I(Vi) und damit ein Ausdruck ueber zwei Messstellen, kein
* Knoten, den das Symbol kennen koennte.
RECTANGLE Normal 0 -96 96 -16
CIRCLE Normal 24 -76 72 -36
LINE Normal 0 0 0 -16
LINE Normal 32 0 32 -16
LINE Normal 64 0 64 -16
LINE Normal 96 0 96 -16
TEXT 48 -56 Center 2 W
TEXT 16 -104 Center 0 U
TEXT 80 -104 Center 0 I
WINDOW 0 104 -96 Left 2
SYMATTR Prefix X
SYMATTR SpiceModel wattmeter
SYMATTR Value wattmeter
SYMATTR ModelFile wattmeter.lib
SYMATTR Description Wattmeter: VP/VN parallel zur Last, IP/IN in Reihe; P = V(VP,VN)*I(Vi)
PIN 0 0 NONE 0
PINATTR PinName VP
PINATTR SpiceOrder 1
PIN 32 0 NONE 0
PINATTR PinName VN
PINATTR SpiceOrder 2
PIN 64 0 NONE 0
PINATTR PinName IP
PINATTR SpiceOrder 3
PIN 96 0 NONE 0
PINATTR PinName IN
PINATTR SpiceOrder 4
