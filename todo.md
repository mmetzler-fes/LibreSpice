# ToDo

Vier Punkte, je ein Commit. Baseline vor Beginn: 131 Tests grün (`npm run test:editor`).

## 1. Erste Simulation ohne vorausgewählte Traces
**Ursache:** `simulationStore.setResult` (src/store/simulationStore.ts) wählt über
`firstReal` automatisch die erste nicht-konstante Variable aus, wenn weder
übernommene noch angeforderte Probes vorliegen.

- [x] `firstReal`-Fallback entfernen; `selectedVariables` bleibt leer, wenn der
      Benutzer nichts über "add to Oszi" angefordert hat (`pendingProbes`).
- [x] Bestehende Probes (`kept`) und `pendingProbes` weiterhin übernehmen.
- [x] Test: erste Simulation ohne Probes → leere Auswahl; mit `addProbe` vorher
      → genau diese Auswahl; Re-Run behält die Auswahl.

## 2. Kontextmenü für Net Connection: Knotenspannung aufs Oszi
**Ursache:** `openNodeMenu` (src/editor/SchematicCanvas.tsx) steigt bei
`componentType === "netlabel"` früh aus (`return`) und zeigt nur den
Label↔Connector-Toggle — keine Probe-Einträge. Wires haben das bereits
(`wireMenu` mit `vExpr`/`iExpr`).

- [x] Netz-Id des Net-Labels auflösen (`comp.ports[0].netId`) und `vExpr` via
      `netVoltageExpr` ins Menü legen.
- [x] Menüeinträge "V(net) im Oszi anzeigen" + "Datenpunkt: Potential V(net)".
- [x] Test: Menü-Expression für ein Net-Label ist das `V(<netname>)` seines Netzes.

## 3. Konsistenz der Netznamen im Diagramm
**Ursache:** `renameNetInProbe` (src/core/circuit/probeUtils.ts) ersetzt nur die
einstellige Form `V(name)`. Die zweistellige Form `V(a,b)` — die
`compVoltageExpr` für Datenpunkte erzeugt — wird beim Umbenennen **nicht**
mitgezogen. Damit zeigen Datenpunkte/Funktionen nach einem Rename den alten Namen.

- [x] `renameNetInProbe` um die Form `V(a,b)` erweitern (beide Argumente).
- [x] Prüfen, dass `renameNet` → `renameNetVariable` + `renameTraceNet` alle
      Senken erreicht: Traces, Expressions, Farben, Panel-Zuordnung, dataFlags.
- [x] Test: Rename zieht `V(a)`, `V(a,b)` und `-V(a)` mit; `I(...)` bleibt
      unangetastet.

## 4. Netconnector an ein Bauteil andocken
**Ursache:** `autoConnectNodePins` (src/editor/SchematicCanvas.tsx:122) sucht
ausschließlich in `edges` nach einem Andockpunkt. Pins anderer **Nodes** werden
nie betrachtet — deshalb dockt ein Netconnector nur an eine Leitung an.

- [x] Pin-zu-Pin-Andocken ergänzen: deckungsgleiche Pins anderer Bauteile finden
      und direkt verdrahten (Leitungs-Tap bleibt Vorrang/unverändert).
- [x] Kein Self-Connect, keine Doppelkante, wenn die Verbindung schon existiert.
- [x] Test: Net-Label auf einen Bauteil-Pin gesetzt → gemeinsames Netz im
      Netlist-Rebuild; Netzname des Labels landet am Bauteil-Pin.

## Abschluss
- [x] `npm run check` + `npm run test:editor` grün.
- [x] Vier getrennte Commits.
