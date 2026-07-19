Bei LTspice gibt es einen feinen, aber sehr wichtigen Unterschied zwischen einem einfachen Netz-Label (Label Net) und den Net Connectors (Ports/Globale Verbinder).Die kurze Antwort lautet: Nein, sie verhalten sich nicht in jeder Situation exakt gleich, auch wenn sie auf den ersten Blick denselben Zweck erfüllen – nämlich Leitungen ohne gezeichnete Drähte miteinander zu verbinden.Hier ist die genaue Aufschlüsselung, wie sie sich verhalten und ob sie fest an eine Leitung gebunden sind:

1. Das Label Net (Standard-Label)Wenn du in LTspice die Taste F4 drückst, erstellst du ein einfaches Label Net.Bindung an die Leitung: Ja, es ist fest an dieses spezifische Netz gebunden. Wenn du zwei getrennte Drähte mit demselben Label (z. B. A) versiehst, weiß LTspice beim Kompilieren der Schaltungsliste (Netzliste), dass diese beiden Drähte elektrisch exakt derselbe Knotenpunkt sind.Gültigkeitsbereich (Scope): Ein Standard-Label ist standardmäßig lokal. Wenn du hierarchische Schaltpläne (Untergliederungen mit Subcircuits/Blöcken) nutzt, bleibt das Label A nur innerhalb dieses einen Schaltplans gültig. Ein Label A in einem anderen Block wird als völlig separates Netz behandelt.

2. Der Net Connector (Input, Output, Bi-Directional) Im selben F4-Menü kannst du den Port Type von "None" auf Input, Output oder Bi-Directional umstellen. Das sind die Net Connectors.Bindung an die Leitung: Auch sie sind fest an die Leitung gebunden und benennen das Netz um.Gültigkeitsbereich (Scope): Hier liegt der Hauptunterschied. Ein Net Connector signalisiert LTspice, dass dieses Netz eine Schnittstelle nach außen besitzt.Wenn du diesen Schaltplan später als Block (Subcircuit) in einem übergeordneten Schaltplan verwendest, werden diese Connectors automatisch zu den Anschlusspins deines neuen Bauteils.Globale Verbinder: Verwendest du in LTspice bestimmte geschützte Namen (wie $GLOBAL: vor dem Namen oder vordefinierte globale Anschlüsse), verhalten sie sich wie globale Knoten, die über alle Hierarchieebenen hinweg verbunden sind.Das wichtigste Unterscheidungsmerkmal auf einen BlickEigenschaftLabel Net (Port Type: None)Net Connector (Input / Output / Bi-Dir)Hauptfunktion

Folgende Änderungen werden gewünscht:
- Net connector mit eigenem Property Einstellungen
    - Es soll 4 Darstellungsmöglichkeiten geben:
        - einfacher Kreis für die Verbindung + Label 
        - Pfeil nach aussen + Label (OUT)
        - Pfeil nach innen + Label (IN)
        - Doppelpfeil + Label (INOUT)
    - Die Richtung kann über das Drehen symbol gedreht werden und auch Mirror funktioniert.
- Der Net connector ist immer an eine Leitung gebunden und kann beim Anklicken der connector Stelle bewegt werden - die Leitung wird mitbewegt
- Wird der Net connector an einem Bauteil-Pin über Linksklick abgelegt, so wird ein Stück Leitung zwischen beiden erzeugt. Er bleibt verschiebbar - die Leitung bewegt sich mit.
- Der Label des Netconnector soll sich separat bewegen lassen, wenn auf den Label geklickt wird. Dieser soll sich dann im Abstand von ca. 1 cm zur Konnektor Docking Stelle verschieben lassen. Die Docking Stelle bewegt sich dabei nicht mit.

Bei dem Label Property Menü sollen die Net connector Einstellungen entfernt werden. Da LTSpice beide unterschiedlich abspeichert (.asc) können diese hier auch getrennt werden.
Der Label soll sich wie bisher verhalten, nur die Option "Netconnector" entfällt im Propertys Menü. Der Netconnector erhält sein eigenes Properties Menü. Das Aussehen des Labels soll aber wie der Label vom Netconnector aussehen (evtl. leicht veränderter Background um den Unterschied zu erkennen)

