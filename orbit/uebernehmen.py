#!/usr/bin/env python3
"""Holt MeinOrbit vom Mac auf die Webseite.

Die Oberflaeche und das Rechenprogramm werden unveraendert aus
~/ARTLENN MEDIA Verwaltung uebernommen. Im Browser laeuft das Python-Programm
mit Pyodide, gespeichert wird in Supabase (siehe orbit/bruecke.js).

Nur wenige Stellen der Oberflaeche werden fuer den Browser angepasst - jede
davon steht unten in ANPASSUNGEN und muss genau einmal vorkommen. Faellt eine
weg, weil sich die Mac-Fassung geaendert hat, bricht das Skript ab, statt
still etwas Falsches zu bauen.

Nach jeder Aenderung an der Mac-Fassung:  python3 orbit/uebernehmen.py
"""

import hashlib
import os
import shutil
import sys

QUELLE = os.path.expanduser("~/ARTLENN MEDIA Verwaltung")
HIER = os.path.dirname(os.path.abspath(__file__))
SEITE = os.path.dirname(HIER)
PROGRAMM = os.path.join(HIER, "programm")
DATEIEN = ["meinorbit.py", "datenbank.py", "vorgaenge.py", "rechnung.py", "finanzen.py",
           "kalender.py", "content.py", "sperre.py", "qr.py"]

KOPF = """<meta name="robots" content="noindex, nofollow">
<script>window.ORBIT_STAND = "%s";</script>
<script src="assets/js/vendor/supabase.min.js"></script>
<script src="assets/js/config.js"></script>
<script src="https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js"></script>
<script src="orbit/bruecke.js?v=%s"></script>
"""

ANPASSUNGEN = [
    # Den Datenordner gibt es im Browser nicht.
    ('<button onclick="ordnerOeffnen()" title="Ordner mit allen Daten im Finder zeigen">',
     '<button onclick="ordnerOeffnen()" title="Ordner mit allen Daten im Finder zeigen" style="display:none">'),
    # Das Passwort ist im Browser die Anmeldung der Webseite.
    ('["sperre", "Passwort"], ', ''),
    ('title="MeinOrbit sofort abschliessen">', 'title="Abmelden und MeinOrbit schließen">'),
    ("""      <div class="klein mute" style="margin-bottom:10px">Alles steckt in einem einzigen Ordner
        auf diesem Rechner. Keine Cloud, kein Konto, keine Weitergabe. Wer den Ordner kopiert,
        hat den vollständigen Bestand.</div>
      <div class="reihe-weit" style="margin-bottom:20px">""",
     """      <div class="klein mute" style="margin-bottom:10px">Alles liegt in deiner eigenen
        Datenbank bei Supabase (Rechenzentrum in Europa). Nur mit deiner Anmeldung kommt man
        heran. Jede Änderung wird sofort gespeichert und ist auf jedem Gerät gleich.</div>
      <div class="reihe-weit" style="display:none">"""),
    ("""Bei jedem Start entsteht automatisch eine
        Sicherung. <b>Wichtig:</b> Sie liegt auf demselben Rechner. Zieh den Ordner regelmäßig
        zusätzlich auf eine externe Platte oder in deine Cloud – sonst ist bei einem Geräteverlust
        alles weg.</div>""",
     """Beim Öffnen entsteht automatisch eine
        Sicherung, höchstens alle sechs Stunden. Sie liegt getrennt vom Bestand in der Ablage
        der Datenbank. Lade zusätzlich ab und zu die Gesamtausgabe herunter.</div>"""),
    ("Ist das schwarze Fenster noch offen?", "Bitte die Seite neu laden."),
    # Zusaetzliche Rechnungsvorlage mit Logo und Farben von ARTLENN MEDIA (bruecke.py)
    ('[["klar", "Klar"], ["klassisch", "Klassisch"], ["kompakt", "Kompakt"]]',
     '[["artlenn", "ARTLENN"], ["klar", "Klar"], ["klassisch", "Klassisch"], ["kompakt", "Kompakt"]]'),
    ('[["klar", "Klar – ruhig und modern"],',
     '[["artlenn", "ARTLENN – Logo und Farben der Marke"], ["klar", "Klar – ruhig und modern"],'),
]


def main():
    os.makedirs(PROGRAMM, exist_ok=True)
    pruef = hashlib.sha1()
    for name in DATEIEN:
        shutil.copyfile(os.path.join(QUELLE, name), os.path.join(PROGRAMM, name))
        with open(os.path.join(PROGRAMM, name), "rb") as f:
            pruef.update(f.read())
    for name in ("bruecke.py", "bruecke.js"):
        with open(os.path.join(HIER, name), "rb") as f:
            pruef.update(f.read())

    with open(os.path.join(QUELLE, "oberflaeche.html"), encoding="utf-8") as f:
        html = f.read()
    pruef.update(html.encode("utf-8"))
    pruef.update(repr(ANPASSUNGEN).encode("utf-8"))
    for alt, neu in ANPASSUNGEN:
        anzahl = html.count(alt)
        if anzahl != 1:
            sys.exit("Stelle %dx statt 1x gefunden:\n%s" % (anzahl, alt[:120]))
        html = html.replace(alt, neu)

    stand = pruef.hexdigest()[:10]
    html = html.replace("</title>\n", "</title>\n" + KOPF % (stand, stand), 1)
    with open(os.path.join(SEITE, "orbit.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("Übernommen, Stand %s." % stand)


if __name__ == "__main__":
    main()
