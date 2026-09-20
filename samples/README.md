# samples/

Die Dateien, die Schaltungen einlesen: `wavefile=Hanuman_Sample.wav` an einer
Spannungsquelle, `PWL file=messung.txt` an einer anderen. Der Server liefert
diesen Ordner unter `<app-base>/samples/` aus, und die App holt sich von dort
jede Datei, die eine geöffnete Schaltung nennt und noch nicht geladen hat —
damit ein geteilter Link seine Audiodatei selbst findet statt mit „Datei nicht
geladen" dazustehen (`src/store/bundledSourceFiles.ts`).

**Der Inhalt ist absichtlich nicht im Repository.** Die Aufnahmen stammen von
Dritten, genau wie die Beispielschaltungen unter `examples/`; `.gitignore` lässt
nur diese README durch. Ein frischer Klon hat hier also nichts stehen, und das
ist kein Fehlerfall: eine Schaltung meldet dann in den Eigenschaften ihrer
Quelle, dass die Datei fehlt, und man lädt sie wie bisher von Hand.

## Was hier liegen muss

Die Dateien, die von veröffentlichten Beispielen gebraucht werden — derzeit:

    samples/Hanuman_Sample.wav      (Karte „Audio-Filterung - Tiefpaß")

Der Name muss exakt dem entsprechen, was die `.asc` nennt (Groß-/Kleinschreibung
egal, Pfade werden abgeschnitten). Kopiervorlage ist die Datei neben der
Schaltung, also `examples/Hanuman_Sample.wav`:

    cp examples/Hanuman_Sample.wav samples/

## Betrieb

* **`npm run dev`** — der Vite-Dev-Server liefert den Ordner direkt aus
  (`serveSamples()` in `vite.config.ts`). Nichts weiter zu tun.
* **`npm run build` + `npm run server`** — der Express-Server liefert ihn aus,
  standardmäßig aus diesem Ordner; `LIBRESPICE_SAMPLE_DIR` zeigt ihn woandershin.
* **Docker** — `docker-compose.yml` hängt `./samples` als `/data/samples`
  schreibgeschützt ein und setzt `LIBRESPICE_SAMPLE_DIR`. Der Ordner muss auf
  dem Host also vorhanden und befüllt sein, bevor der Container startet. Für
  eine weitere Datei braucht es weder ein neues Image noch einen Neustart:
  `express.static` liest bei jeder Anfrage von der Platte.
