"""Bruecke zwischen dem Browser und dem unveraenderten MeinOrbit-Programm.

Statt eines Servers ruft orbit/bruecke.js die Funktion `anfrage` auf. Alles
Weitere - Endpunkte, Rechnungen, Finanzen - ist der Code vom Mac.
Daten liegen in /daten (Speicher im Browser) und werden von bruecke.js nach
jeder Anfrage in Supabase gesichert.
"""

import base64
import gzip
import hashlib
import json
import os
import sys
import traceback
from datetime import datetime
from urllib.parse import parse_qs, unquote, urlparse

os.environ["MEINORBIT_DATEN"] = "/daten"
sys.path.insert(0, "/programm")

import datenbank as db      # noqa: E402
import meinorbit as mo      # noqa: E402
import sperre               # noqa: E402
import vorgaenge as vg      # noqa: E402

# Die Liste der Sicherungen kommt aus der Ablage in Supabase, nicht vom Datentraeger.
_SICHERUNGEN = []
mo._sicherungen = lambda: _SICHERUNGEN
mo._ordner_zeigen = lambda pfad: None


def _sicherung_anlegen(anzahl_behalten=30):
    """Wie am Mac, aber nur mit der Datendatei: die Dokumente liegen in der
    Ablage ohnehin einzeln und werden dort nie geloescht, nur verschoben.
    Aufgeraeumt wird in bruecke.js, nachdem die Datei hochgeladen ist."""
    db._ordner_anlegen()
    if not os.path.exists(db.DB_DATEI):
        return ""
    import zipfile
    stempel = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    ziel = os.path.join(db.SICHERUNGEN, "sicherung_%s.zip" % stempel)
    with zipfile.ZipFile(ziel, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(db.DB_DATEI, "meinorbit.db")
    return ziel


db.sicherung_anlegen = _sicherung_anlegen


def vorbereiten():
    db.vorbereiten()


def sicherungen_setzen(text):
    global _SICHERUNGEN
    _SICHERUNGEN = json.loads(text)


def einstellung(name, standard=""):
    conn = db.verbindung()
    try:
        return str(db.einstellungen_lesen(conn).get(name) or standard)
    finally:
        conn.close()


def anfrage(methode, adresse, koerper_text):
    """Liefert [Status, Dateityp, Inhalt, Dateiname] wie der Server am Mac."""
    teile = urlparse(adresse)
    pfad = unquote(teile.path)
    frage = parse_qs(teile.query)
    try:
        koerper = json.loads(koerper_text) if koerper_text else {}
    except ValueError:
        koerper = {}
    try:
        if pfad.startswith("/api/"):
            daten, _, _ = mo.endpunkt(pfad, frage, koerper, methode)
            if daten is None:
                return _json({"fehler": "Unbekannter Aufruf: %s" % pfad}, 404)
            return _json(daten)
        inhalt, typ, name = mo.seiten(pfad, frage)
        if inhalt is None:
            return _json({"fehler": "Nicht gefunden: %s" % pfad}, 404)
        return [200, typ, inhalt, name or ""]
    except (vg.Fehler, sperre.Fehler) as f:
        return _json({"fehler": str(f)}, 400)
    except Exception as f:  # noqa: BLE001
        traceback.print_exc()
        return _json({"fehler": "Da ist etwas schiefgelaufen: %s" % f}, 500)


def _json(daten, code=200):
    roh = json.dumps(daten, ensure_ascii=False, default=str).encode("utf-8")
    return [code, "application/json; charset=utf-8", roh, ""]


# ---- Fuer das Speichern in Supabase -------------------------------------

def stand():
    """Fingerabdruck der Datendatei: aendert er sich, muss gespeichert werden."""
    if not os.path.exists(db.DB_DATEI):
        return ""
    with open(db.DB_DATEI, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


def paket():
    with open(db.DB_DATEI, "rb") as f:
        return base64.b64encode(gzip.compress(f.read())).decode("ascii")


def einspielen(text):
    os.makedirs(db.DATEN, exist_ok=True)
    with open(db.DB_DATEI, "wb") as f:
        f.write(gzip.decompress(base64.b64decode(text)))


def dokumente():
    """Name -> [Groesse, Aenderungszeit] aller abgelegten Dateien."""
    if not os.path.isdir(db.DOKUMENTE):
        return "{}"
    liste = {}
    for name in os.listdir(db.DOKUMENTE):
        voll = os.path.join(db.DOKUMENTE, name)
        if os.path.isfile(voll):
            s = os.stat(voll)
            liste[name] = [s.st_size, int(s.st_mtime)]
    return json.dumps(liste)


def neue_sicherungen():
    if not os.path.isdir(db.SICHERUNGEN):
        return "[]"
    return json.dumps(sorted(n for n in os.listdir(db.SICHERUNGEN) if n.endswith(".zip")))


# ---- Einmalig: Eintraege aus der ersten Browser-Fassung ------------------

def alte_webdaten(text):
    """Holt Kunden, Leistungen und Kontaktangaben aus den Tabellen der ersten
    Browser-Fassung (bis 2026-10-23) herueber. Laeuft nur einmal; Vorhandenes
    wird nicht doppelt angelegt."""
    alt = json.loads(text)
    conn = db.verbindung()
    try:
        e = db.einstellungen_lesen(conn)
        if e.get("web_alt_uebernommen") == "ja":
            return 0
        neu = 0
        with conn:
            for k in alt.get("kunden") or []:
                if db.zeile(conn, "SELECT id FROM kunden WHERE nummer=?", (k.get("nummer"),)) or \
                   db.zeile(conn, "SELECT id FROM kunden WHERE firma<>'' AND firma=?", (k.get("firma") or "",)):
                    continue
                nummer = k.get("nummer")
                if not nummer or db.zeile(conn, "SELECT id FROM kunden WHERE nummer=?", (nummer,)):
                    nummer = db.naechste_nummer(conn, (e.get("kunden_praefix") or "K-") + "{nummer}",
                                                int(e.get("kunden_stellen") or 4), "nummer", "kunden")
                conn.execute("""INSERT INTO kunden (nummer, art, firma, vorname, nachname, strasse, plz,
                                ort, land, telefon, email, notizen, archiviert, angelegt_am)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                             (nummer, k.get("art") or "firma", k.get("firma") or "", k.get("vorname") or "",
                              k.get("nachname") or "", k.get("strasse") or "", k.get("plz") or "",
                              k.get("ort") or "", k.get("land") or "Deutschland", k.get("telefon") or "",
                              k.get("email") or "", k.get("notizen") or "", 1 if k.get("archiviert") else 0,
                              k.get("angelegt_am")))
                neu += 1
            for l in alt.get("leistungen") or []:
                if db.zeile(conn, "SELECT id FROM leistungen WHERE name=?", (l.get("name") or "",)):
                    continue
                conn.execute("INSERT INTO leistungen (name, beschreibung, einheit, preis, aktiv) VALUES (?,?,?,?,?)",
                             (l.get("name") or "", l.get("beschreibung") or "", l.get("einheit") or "Stück",
                              float(l.get("preis") or 0), 1 if l.get("aktiv", True) else 0))
                neu += 1
        werte = {"web_alt_uebernommen": "ja"}
        for schl in ("firma_email", "firma_telefon"):
            wert = (alt.get("einstellungen") or {}).get(schl)
            if wert:
                werte[schl] = wert
        db.einstellungen_schreiben(conn, werte)
        with conn:
            db.protokollieren(conn, "Daten", "übernommen",
                              "%d Einträge aus der ersten Browser-Fassung" % neu)
        return neu
    finally:
        conn.close()
