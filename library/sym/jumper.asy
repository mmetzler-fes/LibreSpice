Version 4
SymbolType CELL
* Jumper — a link between two points, drawn as a bow over the gap it closes.
*
* In LTSpice a jumper is literally a piece of wire. This one is a resistor of
* 1 uOhm instead: our model has no part that *is* a connection, and a decade
* below any real contact resistance it behaves like one without giving the
* solver a zero-ohm branch to choke on.
*
* The two pins sit 64 units apart on one horizontal line, which is the spacing
* the jumpers in the shipped schematics were drawn to — measured from the wires
* that stop either side of them (05-2-1_Leistungsanpassung1.asc), and confirmed
* by both jumpers in that file agreeing.
ARC Normal -32 40 32 88 32 64 -32 64
SYMATTR Prefix R
SYMATTR Value 1u
SYMATTR Description Jumper: a 1 uOhm link, the stand-in for a piece of wire.
PIN -32 64 NONE 0
PINATTR PinName A
PINATTR SpiceOrder 1
PIN 32 64 NONE 0
PINATTR PinName B
PINATTR SpiceOrder 2
