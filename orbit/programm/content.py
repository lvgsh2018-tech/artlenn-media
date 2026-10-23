#!/usr/bin/env python3
"""Contentplanung: Kanaele, geplante Beitraege und ihr Monatsraster.

Jeder Kanal (Instagram-Konto, Facebook-Seite, Newsletter ...) bekommt eine
Farbe. Die Farbe ist nur eine Zugabe - im Kalender steht immer auch der Name
des Kanals daneben, damit die Zuordnung ohne Farbsehen funktioniert.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta

import datenbank as db
from kalender import MONATE, datum_lang

# Auswahllisten. Erster Wert wird gespeichert, zweiter angezeigt.
PLATTFORMEN = [
    ("instagram", "Instagram"), ("facebook", "Facebook"), ("tiktok", "TikTok"),
    ("youtube", "YouTube"), ("linkedin", "LinkedIn"), ("pinterest", "Pinterest"),
    ("newsletter", "Newsletter"), ("webseite", "Webseite"), ("sonstiges", "Sonstiges"),
]

FORMATE = [
    ("post", "Beitrag"), ("reel", "Reel"), ("story", "Story"),
    ("karussell", "Karussell"), ("video", "Video"), ("text", "Text"),
]

# "Veroeffentlicht" gab es bis 2026-09-12 als vierten Stand. Lennart plant hier,
# was rausgeht - was schon draussen ist, steht ohnehin auf dem Kanal.
STAENDE = [
    ("idee", "Idee"), ("geplant", "Geplant"), ("fertig", "Fertig"),
]

# Namen der Farbtafel. Die Werte dazu stehen in der Oberflaeche, einmal fuer
# hell und einmal fuer dunkel.
FARBEN = ["blau", "tuerkis", "gruen", "limette", "gelb",
          "orange", "rot", "pink", "lila", "grau"]


def _farbe(wert: str) -> str:
    wert = (wert or "").strip().lower()
    return wert if wert in FARBEN else "blau"


# --------------------------------------------------------------------------
# Kanaele
# --------------------------------------------------------------------------

def accounts(conn, nur_aktive: bool = False) -> list:
    wo = "WHERE a.aktiv=1" if nur_aktive else ""
    return db.zeilen(conn, """
        SELECT a.*, (SELECT COUNT(*) FROM beitraege b WHERE b.account_id=a.id) AS beitraege
          FROM accounts a %s
         ORDER BY a.aktiv DESC, a.reihung, a.name COLLATE NOCASE""" % wo)


def account_speichern(conn, daten: dict) -> int:
    alle = {
        "name": lambda: (daten.get("name") or "").strip(),
        "plattform": lambda: daten.get("plattform") or "instagram",
        "farbe": lambda: _farbe(daten.get("farbe")),
        "kunde_id": lambda: daten.get("kunde_id") or None,
        "notiz": lambda: daten.get("notiz") or "",
        "aktiv": lambda: 1 if daten.get("aktiv", 1) else 0,
    }
    # Beim Aendern nur anfassen, was auch mitgeschickt wurde. Sonst wuerde ein
    # Teilaufruf die uebrigen Felder auf ihre Standardwerte zuruecksetzen.
    schluessel = [k for k in alle if k in daten] if daten.get("id") else list(alle)
    felder = {k: alle[k]() for k in schluessel}
    if not felder:
        return int(daten["id"])
    with conn:
        if daten.get("id"):
            conn.execute("UPDATE accounts SET %s WHERE id=?"
                         % ", ".join("%s=?" % k for k in felder),
                         list(felder.values()) + [daten["id"]])
            return int(daten["id"])
        naechste_reihung = conn.execute(
            "SELECT COALESCE(MAX(reihung), 0) + 1 AS n FROM accounts").fetchone()["n"]
        felder["reihung"] = naechste_reihung
        kopf = conn.execute("INSERT INTO accounts (%s) VALUES (%s)"
                            % (", ".join(felder), ", ".join("?" * len(felder))),
                            list(felder.values()))
        return int(kopf.lastrowid)


def account_loeschen(conn, account_id: int) -> int:
    """Loescht den Kanal. Seine Beitraege bleiben stehen, aber ohne Kanal."""
    offen = conn.execute("SELECT COUNT(*) AS n FROM beitraege WHERE account_id=?",
                         (account_id,)).fetchone()["n"]
    with conn:
        conn.execute("UPDATE beitraege SET account_id=NULL WHERE account_id=?", (account_id,))
        conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
    return offen


# --------------------------------------------------------------------------
# Beitraege
# --------------------------------------------------------------------------

def beitrag_speichern(conn, daten: dict) -> int:
    alle = {
        "account_id": lambda: daten.get("account_id") or None,
        "titel": lambda: (daten.get("titel") or "").strip(),
        "datum": lambda: (daten.get("datum") or "")[:10],
        "uhrzeit": lambda: daten.get("uhrzeit") or "",
        "format": lambda: daten.get("format") or "post",
        "status": lambda: daten.get("status") or "idee",
        "text": lambda: daten.get("text") or "",
        "notiz": lambda: daten.get("notiz") or "",
        "kunde_id": lambda: daten.get("kunde_id") or None,
        "auftrag_id": lambda: daten.get("auftrag_id") or None,
    }
    # Wird ein Beitrag im Kalender auf einen anderen Tag gezogen, kommt nur das
    # neue Datum an. Alles andere muss dann unangetastet stehen bleiben.
    schluessel = [k for k in alle if k in daten] if daten.get("id") else list(alle)
    felder = {k: alle[k]() for k in schluessel}
    if not felder:
        return int(daten["id"])
    with conn:
        if daten.get("id"):
            conn.execute("UPDATE beitraege SET %s WHERE id=?"
                         % ", ".join("%s=?" % k for k in felder),
                         list(felder.values()) + [daten["id"]])
            return int(daten["id"])
        felder["angelegt_am"] = date.today().isoformat()
        kopf = conn.execute("INSERT INTO beitraege (%s) VALUES (%s)"
                            % (", ".join(felder), ", ".join("?" * len(felder))),
                            list(felder.values()))
        return int(kopf.lastrowid)


def beitrag_loeschen(conn, beitrag_id: int) -> None:
    with conn:
        conn.execute("DELETE FROM beitraege WHERE id=?", (beitrag_id,))


def beitrag(conn, beitrag_id: int):
    return db.zeile(conn, "SELECT * FROM beitraege WHERE id=?", (beitrag_id,))


def _beitraege(conn, von: str, bis: str, nur: list = None) -> list:
    zeilen = db.zeilen(conn, """
        SELECT b.*, a.name AS account, a.farbe AS farbe, a.plattform AS plattform
          FROM beitraege b LEFT JOIN accounts a ON a.id = b.account_id
         WHERE b.datum BETWEEN ? AND ?
         ORDER BY b.datum, b.uhrzeit='', b.uhrzeit, b.id""", (von, bis))
    if nur:
        erlaubt = {int(x) for x in nur}
        zeilen = [z for z in zeilen if z["account_id"] in erlaubt]
    return zeilen


def _eintrag(b: dict) -> dict:
    return {"id": b["id"], "titel": b["titel"] or "Ohne Titel",
            "account": b["account"] or "Ohne Kanal",
            "farbe": _farbe(b["farbe"]) if b["account_id"] else "grau",
            "uhrzeit": b["uhrzeit"] or "", "format": b["format"] or "post",
            "status": b["status"] or "idee", "datum": b["datum"] or ""}


# --------------------------------------------------------------------------
# Monatsraster - genau wie im Kalender inklusive der Randtage
# --------------------------------------------------------------------------

def monat(conn, jahr: int, mon: int, nur: list = None) -> dict:
    wochen = calendar.Calendar(firstweekday=0).monthdatescalendar(jahr, mon)
    von, bis = wochen[0][0].isoformat(), wochen[-1][-1].isoformat()

    nach_tag = {}
    for b in _beitraege(conn, von, bis, nur):
        nach_tag.setdefault(b["datum"][:10], []).append(_eintrag(b))

    raster = [[{"datum": t.isoformat(), "tag": t.day, "fremd": t.month != mon,
                "monatskuerzel": MONATE[t.month - 1][:3] if t.month != mon else "",
                "heute": t == date.today(),
                "eintraege": nach_tag.get(t.isoformat(), [])} for t in woche]
              for woche in wochen]

    eigener = "%04d-%02d" % (jahr, mon)
    im_monat = [b for tag, liste in nach_tag.items() if tag[:7] == eigener for b in liste]
    verteilung = {}
    for b in im_monat:
        verteilung[b["account"]] = verteilung.get(b["account"], 0) + 1

    return {"jahr": jahr, "monat": mon, "name": MONATE[mon - 1], "raster": raster,
            "anzahl": len(im_monat),
            "nach_stand": {s: sum(1 for b in im_monat if b["status"] == s)
                           for s, _ in STAENDE},
            "verteilung": verteilung}


def naechste(conn, tage: int = 21) -> list:
    """Was als Naechstes rausgeht - fuer die Spalte neben dem Kalender."""
    heute = date.today()
    bis = (heute + timedelta(days=tage)).isoformat()
    gruppen = []
    for b in _beitraege(conn, heute.isoformat(), bis):
        tag = b["datum"][:10]
        if not gruppen or gruppen[-1]["datum"] != tag:
            gruppen.append({"datum": tag, "lang": datum_lang(tag), "eintraege": []})
        gruppen[-1]["eintraege"].append(_eintrag(b))
    return gruppen


def ohne_datum(conn, nur: list = None) -> list:
    """Ideen, die noch auf keinem Tag liegen."""
    zeilen = db.zeilen(conn, """
        SELECT b.*, a.name AS account, a.farbe AS farbe, a.plattform AS plattform
          FROM beitraege b LEFT JOIN accounts a ON a.id = b.account_id
         WHERE b.datum IS NULL OR b.datum = ''
         ORDER BY b.id DESC""")
    if nur:
        erlaubt = {int(x) for x in nur}
        zeilen = [z for z in zeilen if z["account_id"] in erlaubt]
    return [_eintrag(z) for z in zeilen]


def auswahllisten() -> dict:
    return {"plattformen": PLATTFORMEN, "formate": FORMATE,
            "staende": STAENDE, "farben": FARBEN}
