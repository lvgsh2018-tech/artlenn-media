#!/usr/bin/env python3
"""Datenhaltung fuer MeinOrbit.

Alles liegt in einer einzigen SQLite-Datei im Ordner `daten`. Kein Server,
keine Cloud, kein Konto - die Datei gehoert dem Nutzer und laesst sich
einfach sichern (siehe `sicherung_anlegen`).
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import zipfile
from datetime import date, datetime

HIER = os.path.dirname(os.path.abspath(__file__))
# Wo die Daten liegen. Standard: der Ordner `daten` neben dem Programm.
# Steckt das Programm in einem festen Paket (Symbol auf dem Mac, Programmordner
# unter Windows), gibt der Starter mit MEINORBIT_DATEN einen Ordner beim Nutzer vor.
DATEN = os.environ.get("MEINORBIT_DATEN") or os.path.join(HIER, "daten")
DB_DATEI = os.path.join(DATEN, "meinorbit.db")
# Aus der Zeit vor der Umbenennung: heisst die Datei noch alt, wird sie einmalig
# mitgenommen. Aeltere Sicherungen enthalten weiter "verwaltung.db" - beim
# Zurueckspielen einfach umbenennen.
_ALT = os.path.join(DATEN, "verwaltung.db")
if os.path.exists(_ALT) and not os.path.exists(DB_DATEI):
    os.rename(_ALT, DB_DATEI)
DOKUMENTE = os.path.join(DATEN, "dokumente")
SICHERUNGEN = os.path.join(DATEN, "sicherungen")

# --------------------------------------------------------------------------
# Aufbau der Tabellen
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS einstellungen (
    schluessel TEXT PRIMARY KEY,
    wert       TEXT
);

CREATE TABLE IF NOT EXISTS kunden (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer            TEXT UNIQUE,
    art               TEXT DEFAULT 'firma',      -- firma | privat | verein
    firma             TEXT DEFAULT '',
    vorname           TEXT DEFAULT '',
    nachname          TEXT DEFAULT '',
    anrede            TEXT DEFAULT '',
    strasse           TEXT DEFAULT '',
    plz               TEXT DEFAULT '',
    ort               TEXT DEFAULT '',
    land              TEXT DEFAULT 'Deutschland',
    objekt_strasse    TEXT DEFAULT '',
    objekt_plz        TEXT DEFAULT '',
    objekt_ort        TEXT DEFAULT '',
    telefon           TEXT DEFAULT '',
    mobil             TEXT DEFAULT '',
    email             TEXT DEFAULT '',
    ust_id            TEXT DEFAULT '',
    leitweg_id        TEXT DEFAULT '',
    notizen           TEXT DEFAULT '',
    tags              TEXT DEFAULT '',
    zahlungsziel      INTEGER,
    rabatt            REAL DEFAULT 0,
    wiedervorlage     TEXT DEFAULT '',
    wiedervorlage_text TEXT DEFAULT '',
    archiviert        INTEGER DEFAULT 0,
    angelegt_am       TEXT
);

CREATE TABLE IF NOT EXISTS kundennotizen (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    kunde_id INTEGER NOT NULL,
    datum    TEXT,
    art      TEXT DEFAULT 'Notiz',   -- Notiz | Telefon | E-Mail | Treffen | Briefing
    text     TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kundenpreise (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kunde_id     INTEGER NOT NULL,
    leistung_id  INTEGER,
    bezeichnung  TEXT DEFAULT '',
    preis        REAL DEFAULT 0,
    bemerkung    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS dokumente (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kunde_id    INTEGER,
    auftrag_id  INTEGER,
    titel       TEXT DEFAULT '',
    art         TEXT DEFAULT 'Sonstiges',  -- Vertrag | Nutzungsrecht | Freigabe | Beleg | Sonstiges
    dateiname   TEXT DEFAULT '',
    datum       TEXT
);

CREATE TABLE IF NOT EXISTS leistungen (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT DEFAULT '',
    beschreibung TEXT DEFAULT '',
    einheit     TEXT DEFAULT 'Stück',
    preis       REAL DEFAULT 0,
    steuersatz  REAL DEFAULT 0,
    aktiv       INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS auftraege (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer       TEXT UNIQUE,
    kunde_id     INTEGER NOT NULL,
    titel        TEXT DEFAULT '',
    beschreibung TEXT DEFAULT '',
    ort          TEXT DEFAULT '',
    status       TEXT DEFAULT 'anfrage',  -- anfrage|angebot|planung|bearbeitung|fertig|abgerechnet|abgelehnt
    fortschritt  INTEGER DEFAULT 0,
    start        TEXT DEFAULT '',
    ende         TEXT DEFAULT '',
    stundensatz  REAL DEFAULT 0,
    notizen      TEXT DEFAULT '',
    angelegt_am  TEXT
);

CREATE TABLE IF NOT EXISTS auftragsposten (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    auftrag_id  INTEGER NOT NULL,
    position    INTEGER DEFAULT 0,
    bezeichnung TEXT DEFAULT '',
    menge       REAL DEFAULT 1,
    einheit     TEXT DEFAULT 'Stück',
    einzelpreis REAL DEFAULT 0,
    steuersatz  REAL DEFAULT 0,
    -- wie bei Zeiten und Belegen: was einmal auf einer Rechnung stand,
    -- gilt als abgerechnet und wird nicht noch einmal berechnet
    abgerechnet INTEGER DEFAULT 0,
    rechnung_id INTEGER
);

CREATE TABLE IF NOT EXISTS zeiten (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    auftrag_id  INTEGER NOT NULL,
    datum       TEXT,
    stunden     REAL DEFAULT 0,
    beschreibung TEXT DEFAULT '',
    abgerechnet INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS belege (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kunde_id      INTEGER,
    auftrag_id    INTEGER,
    datum         TEXT,
    beschreibung  TEXT DEFAULT '',
    kategorie     TEXT DEFAULT 'Sonstiges',
    betrag        REAL DEFAULT 0,
    weiterberechnen INTEGER DEFAULT 0,
    abgerechnet   INTEGER DEFAULT 0,
    rechnung_id   INTEGER,
    dateiname     TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rechnungen (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer         TEXT,
    typ            TEXT DEFAULT 'rechnung',   -- angebot | rechnung | storno
    kunde_id       INTEGER NOT NULL,
    auftrag_id     INTEGER,
    datum          TEXT,
    leistungsdatum TEXT DEFAULT '',
    zahlungsziel   INTEGER DEFAULT 14,
    faellig_am     TEXT DEFAULT '',
    status         TEXT DEFAULT 'entwurf',    -- entwurf|offen|bezahlt|storniert|abgelehnt|angenommen
    netto          REAL DEFAULT 0,
    steuer         REAL DEFAULT 0,
    brutto         REAL DEFAULT 0,
    bezahlt_am     TEXT DEFAULT '',
    bezahlt_betrag REAL DEFAULT 0,
    festgeschrieben INTEGER DEFAULT 0,
    storno_von     INTEGER,
    storniert_durch INTEGER,
    mahnstufe      INTEGER DEFAULT 0,
    mahnung_am     TEXT DEFAULT '',
    kopftext       TEXT DEFAULT '',
    fusstext       TEXT DEFAULT '',
    vorlage        TEXT DEFAULT 'klar',
    wiederkehrend  INTEGER DEFAULT 0,
    rhythmus       TEXT DEFAULT '',
    naechste_am    TEXT DEFAULT '',
    angelegt_am    TEXT
);

CREATE TABLE IF NOT EXISTS rechnungsposten (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rechnung_id  INTEGER NOT NULL,
    position     INTEGER DEFAULT 0,
    bezeichnung  TEXT DEFAULT '',
    menge        REAL DEFAULT 1,
    einheit      TEXT DEFAULT 'Stück',
    einzelpreis  REAL DEFAULT 0,
    steuersatz   REAL DEFAULT 0,
    betrag       REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS termine (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    titel      TEXT DEFAULT '',
    datum      TEXT,
    von        TEXT DEFAULT '',
    bis        TEXT DEFAULT '',
    ganztags   INTEGER DEFAULT 0,
    ort        TEXT DEFAULT '',
    notiz      TEXT DEFAULT '',
    kunde_id   INTEGER,
    auftrag_id INTEGER
);

CREATE TABLE IF NOT EXISTS aufgaben (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    titel       TEXT DEFAULT '',
    beschreibung TEXT DEFAULT '',
    faellig     TEXT DEFAULT '',
    uhrzeit     TEXT DEFAULT '',
    erledigt    INTEGER DEFAULT 0,
    erledigt_am TEXT DEFAULT '',
    wichtig     INTEGER DEFAULT 0,
    kunde_id    INTEGER,
    auftrag_id  INTEGER,
    rhythmus    TEXT DEFAULT '',      -- '' | monatlich | quartalsweise | jaehrlich
    quelle      TEXT DEFAULT 'manuell'
);

CREATE TABLE IF NOT EXISTS ausgaben (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    datum        TEXT,
    beschreibung TEXT DEFAULT '',
    kategorie    TEXT DEFAULT 'Sonstiges',
    betrag       REAL DEFAULT 0,
    rhythmus     TEXT DEFAULT '',
    dateiname    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS einnahmen (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    datum        TEXT,
    beschreibung TEXT DEFAULT '',
    kategorie    TEXT DEFAULT 'Barverkauf',
    betrag       REAL DEFAULT 0,
    zahlungsart  TEXT DEFAULT 'bar',      -- bar | karte | ueberweisung | sonstiges
    kunde_id     INTEGER,
    beleg_nummer TEXT DEFAULT '',
    dateiname    TEXT DEFAULT '',
    angelegt_am  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT DEFAULT '',            -- @badsalzuflen_bilder
    plattform  TEXT DEFAULT 'instagram',   -- instagram | facebook | tiktok | youtube | ...
    farbe      TEXT DEFAULT 'blau',        -- Name aus der Farbtafel der Oberflaeche
    kunde_id   INTEGER,
    notiz      TEXT DEFAULT '',
    aktiv      INTEGER DEFAULT 1,
    reihung    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS beitraege (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER,
    titel       TEXT DEFAULT '',
    datum       TEXT,
    uhrzeit     TEXT DEFAULT '',
    format      TEXT DEFAULT 'post',       -- post | reel | story | karussell | video | text
    status      TEXT DEFAULT 'idee',       -- idee | geplant | fertig | veroeffentlicht
    text        TEXT DEFAULT '',           -- Bildunterschrift
    notiz       TEXT DEFAULT '',
    kunde_id    INTEGER,
    auftrag_id  INTEGER,
    angelegt_am TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS protokoll (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    zeit     TEXT,
    bereich  TEXT DEFAULT '',
    vorgang  TEXT DEFAULT '',
    text     TEXT DEFAULT ''
);
"""

STANDARD_EINSTELLUNGEN = {
    "firma_name": "",
    "firma_inhaber": "",
    "firma_strasse": "",
    "firma_plz": "",
    "firma_ort": "",
    "firma_land": "Deutschland",
    "firma_telefon": "",
    "firma_email": "",
    "firma_web": "",
    "firma_steuernummer": "",
    "firma_ust_id": "",
    "firma_logo": "",
    "bank_inhaber": "",
    "bank_name": "",
    "bank_iban": "",
    "bank_bic": "",
    "kleinunternehmer": "ja",
    "steuersatz": "0",
    "hinweis_19": "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
    "zahlungsziel": "14",
    "kunden_praefix": "K-",
    "kunden_stellen": "4",
    "rechnung_muster": "{jahr}-{nummer}",
    "rechnung_stellen": "4",
    "angebot_muster": "AN-{jahr}-{nummer}",
    "auftrag_muster": "A-{jahr}-{nummer}",
    "vorlage": "klar",
    "akzentfarbe": "#2563eb",
    "fusstext": "Vielen Dank für die gute Zusammenarbeit.",
    "steuerruecklage": "25",
    "verzugszins": "9",
    "mahntext_1": "Sicher ist es Ihrer Aufmerksamkeit entgangen: Die unten genannte Rechnung ist noch offen. Bitte gleichen Sie den Betrag in den nächsten Tagen aus.",
    "mahntext_2": "Trotz unserer Zahlungserinnerung ist die unten genannte Rechnung weiterhin offen. Wir bitten Sie, den Betrag umgehend zu überweisen.",
    "mahntext_3": "Die unten genannte Rechnung ist trotz mehrfacher Erinnerung nicht ausgeglichen. Wir setzen Ihnen eine letzte Frist, bevor wir weitere Schritte einleiten.",
    "sicherung_automatisch": "ja",
    "sicherung_anzahl": "30",
}


def _ordner_anlegen() -> None:
    for ordner in (DATEN, DOKUMENTE, SICHERUNGEN):
        os.makedirs(ordner, exist_ok=True)


def verbindung() -> sqlite3.Connection:
    _ordner_anlegen()
    conn = sqlite3.connect(DB_DATEI)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Spalten, die erst spaeter dazugekommen sind. SQLite kennt kein
# "ADD COLUMN IF NOT EXISTS", darum wird vorher nachgesehen.
NACHZURUESTEN = (
    ("auftragsposten", "abgerechnet", "INTEGER DEFAULT 0"),
    ("auftragsposten", "rechnung_id", "INTEGER"),
    ("aufgaben", "uhrzeit", "TEXT DEFAULT ''"),
)


def _spalten_nachruesten(conn: sqlite3.Connection) -> None:
    frisch = set()
    for tabelle, spalte, art in NACHZURUESTEN:
        vorhanden = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % tabelle)}
        if spalte not in vorhanden:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (tabelle, spalte, art))
            frisch.add((tabelle, spalte))

    # Aeltere Auftraege: was schon auf einer Rechnung stand, gilt rueckwirkend als
    # abgerechnet. Sonst zeigte die neue Spalte "offen" fuer laengst Bezahltes.
    if ("auftragsposten", "abgerechnet") in frisch:
        conn.execute("""
            UPDATE auftragsposten SET abgerechnet=1, rechnung_id=(
                SELECT r.id FROM rechnungen r
                 WHERE r.auftrag_id = auftragsposten.auftrag_id AND r.typ='rechnung'
                 ORDER BY r.id LIMIT 1)
             WHERE auftrag_id IN (SELECT auftrag_id FROM rechnungen
                                   WHERE typ='rechnung' AND auftrag_id IS NOT NULL)
                OR auftrag_id IN (SELECT id FROM auftraege WHERE status='abgerechnet')""")


def vorbereiten() -> None:
    """Tabellen anlegen und fehlende Einstellungen ergaenzen."""
    _ordner_anlegen()
    conn = verbindung()
    with conn:
        conn.executescript(SCHEMA)
        _spalten_nachruesten(conn)
        vorhanden = {r["schluessel"] for r in conn.execute("SELECT schluessel FROM einstellungen")}
        for schluessel, wert in STANDARD_EINSTELLUNGEN.items():
            if schluessel not in vorhanden:
                conn.execute(
                    "INSERT INTO einstellungen (schluessel, wert) VALUES (?, ?)",
                    (schluessel, wert),
                )
        anzahl = conn.execute("SELECT COUNT(*) AS n FROM leistungen").fetchone()["n"]
        if anzahl == 0:
            for name, einheit, preis in (
                ("Videoschnitt", "Stunde", 55.0),
                ("Fotoproduktion", "Tag", 650.0),
                ("Social-Media-Betreuung", "Monat", 450.0),
                ("Grafikdesign", "Stunde", 65.0),
                ("Fahrtkosten", "km", 0.30),
            ):
                conn.execute(
                    "INSERT INTO leistungen (name, einheit, preis) VALUES (?, ?, ?)",
                    (name, einheit, preis),
                )
    conn.close()


# --------------------------------------------------------------------------
# Kleine Helfer
# --------------------------------------------------------------------------

def zeilen(conn: sqlite3.Connection, sql: str, werte=()) -> list:
    return [dict(r) for r in conn.execute(sql, werte)]


def zeile(conn: sqlite3.Connection, sql: str, werte=()):
    r = conn.execute(sql, werte).fetchone()
    return dict(r) if r else None


def einstellungen_lesen(conn: sqlite3.Connection) -> dict:
    daten = dict(STANDARD_EINSTELLUNGEN)
    for r in conn.execute("SELECT schluessel, wert FROM einstellungen"):
        daten[r["schluessel"]] = r["wert"] if r["wert"] is not None else ""
    return daten


def einstellungen_schreiben(conn: sqlite3.Connection, daten: dict) -> None:
    with conn:
        for schluessel, wert in daten.items():
            conn.execute(
                "INSERT INTO einstellungen (schluessel, wert) VALUES (?, ?) "
                "ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert",
                (schluessel, "" if wert is None else str(wert)),
            )


def protokollieren(conn: sqlite3.Connection, bereich: str, vorgang: str, text: str) -> None:
    conn.execute(
        "INSERT INTO protokoll (zeit, bereich, vorgang, text) VALUES (?, ?, ?, ?)",
        (datetime.now().isoformat(timespec="seconds"), bereich, vorgang, text),
    )


def naechste_nummer(conn: sqlite3.Connection, muster: str, stellen: int, spalte: str, tabelle: str,
                    bedingung: str = "", jahr: str = "") -> str:
    """Baut die naechste freie Nummer nach einem Muster wie '{jahr}-{nummer}'."""
    jahr = jahr or str(date.today().year)
    praefix = muster.replace("{jahr}", jahr).replace("{nummer}", "")
    sql = "SELECT %s AS n FROM %s WHERE %s LIKE ?" % (spalte, tabelle, spalte)
    if bedingung:
        sql += " AND " + bedingung
    hoechste = 0
    for r in conn.execute(sql, (praefix + "%",)):
        rest = (r["n"] or "")[len(praefix):]
        ziffern = "".join(c for c in rest if c.isdigit())
        if ziffern:
            hoechste = max(hoechste, int(ziffern))
    return praefix + str(hoechste + 1).zfill(stellen)


# --------------------------------------------------------------------------
# Sicherung
# --------------------------------------------------------------------------

def sicherung_anlegen(anzahl_behalten: int = 30) -> str:
    """Packt die Datendatei und die Dokumente in ein ZIP mit Zeitstempel."""
    _ordner_anlegen()
    if not os.path.exists(DB_DATEI):
        return ""
    stempel = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    ziel = os.path.join(SICHERUNGEN, "sicherung_%s.zip" % stempel)
    with zipfile.ZipFile(ziel, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(DB_DATEI, "meinorbit.db")
        for wurzel, _, dateien in os.walk(DOKUMENTE):
            for d in dateien:
                voll = os.path.join(wurzel, d)
                z.write(voll, os.path.join("dokumente", os.path.relpath(voll, DOKUMENTE)))
    alle = sorted(f for f in os.listdir(SICHERUNGEN) if f.startswith("sicherung_") and f.endswith(".zip"))
    for alt in alle[:-anzahl_behalten] if anzahl_behalten > 0 else []:
        try:
            os.remove(os.path.join(SICHERUNGEN, alt))
        except OSError:
            pass
    return ziel


def alles_ausgeben() -> dict:
    """Kompletter Datenbestand als JSON-faehiges Verzeichnis (fuer Export)."""
    conn = verbindung()
    tabellen = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    daten = {t: zeilen(conn, "SELECT * FROM %s" % t) for t in tabellen}
    conn.close()
    return daten


# --------------------------------------------------------------------------
# Zuruecksetzen
# --------------------------------------------------------------------------

# Alles, was im Alltag entsteht. Reihenfolge so, dass Kinder vor Eltern gehen.
BEWEGUNGSDATEN = (
    "rechnungsposten", "rechnungen", "auftragsposten", "zeiten", "belege",
    "dokumente", "kundennotizen", "kundenpreise", "auftraege", "kunden",
    "termine", "aufgaben", "einnahmen", "ausgaben", "beitraege", "accounts",
    "protokoll",
)


def _dokumente_leeren() -> None:
    """Loescht die abgelegten Dateien, laesst den Ordner selbst stehen."""
    if not os.path.isdir(DOKUMENTE):
        return
    for name in os.listdir(DOKUMENTE):
        voll = os.path.join(DOKUMENTE, name)
        try:
            if os.path.isdir(voll):
                shutil.rmtree(voll)
            else:
                os.remove(voll)
        except OSError:
            pass


def zuruecksetzen(conn: sqlite3.Connection, alles: bool = False) -> None:
    """Leert den Bestand.

    Ohne `alles` bleiben Firmenprofil, Rechnungseinstellungen und
    Leistungskatalog stehen - nur die eigentlichen Daten verschwinden.
    Mit `alles` ist das Programm danach wie frisch eingerichtet.
    Sicherungen werden in keinem Fall angeruehrt.
    """
    tabellen = list(BEWEGUNGSDATEN)
    if alles:
        tabellen += ["leistungen", "einstellungen"]
    with conn:
        for tabelle in tabellen:
            conn.execute("DELETE FROM %s" % tabelle)
        # Zaehler mit zuruecksetzen, sonst laufen die internen Nummern weiter.
        if zeile(conn, "SELECT name FROM sqlite_master WHERE name='sqlite_sequence'"):
            conn.execute("DELETE FROM sqlite_sequence WHERE name IN (%s)"
                         % ", ".join("?" * len(tabellen)), tabellen)
    _dokumente_leeren()
    # Datei schrumpfen. VACUUM vertraegt keine offene Transaktion.
    vorher = conn.isolation_level
    conn.isolation_level = None
    try:
        conn.execute("VACUUM")
    except sqlite3.Error:
        pass
    conn.isolation_level = vorher
    # Legt fehlende Standardeinstellungen und die Beispielleistungen neu an.
    vorbereiten()
