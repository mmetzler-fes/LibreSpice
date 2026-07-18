Das Aussehen der Leitungsbeschriftung und das Verhalten der Netconnections soll wie folgt verbessert werden:

- Eine beschriftete Leitung soll auch als Netconnector angezeigt werden können.
- Properties Menü von Leitungen ändern
    - Checkbox: visible
    Wenn geklickt wird der Label mit dem Netname angezeigt
    - Checkbox: Net connector
    Wenn angeklickt, wird nicht nur der Label, sondern das Connector symbol gezeigt. Dafür gibt es zusätzlich ein Auswahlfeld für die Positionierung der Pfeilspitze des Connectorsymbols (up, down, left, right)
- Die Labelbeschriftung soll unauffälliger erscheinen. Das Kreissymbol der Verbindungsstelle dockt unsichtbar an der Leitung an. Der Label selbst kann überall entlang der benannten Leitung entlanggleiten (ohne eine neue Leitung zu zeichnen) und kann auch bis ca. 1 cm von der Leitung entfernt abgelegt werden (Die Position kann der Benutzer per drag and drop jederzeit ändern aber der Label bleibt sticky an diesem netlabel Abschnitt)

Wird eine Netconnection über den Button im Menü hinzugefügt verhält dieser sich identisch mit einer Leitung bei der die checkbox visible ausgewählt ist. Über Strg-R rotiert der Connector, wenn die Checkbox Net connector ausgewählt ist.

Wird die Netconnection allerdings am Ende eines Bautteils abgelegt (mit Linksklick) wird intern ein winziges Stück Leitung erzeugt, welches am Bauteil andockt. Dieses wird dann als visible (mit Labelnamen) angezeigt. Der Ghost kann bleiben wie er ist. 

