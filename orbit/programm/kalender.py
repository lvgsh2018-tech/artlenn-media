#!/usr/bin/env python3
"""Kalender, Aufgaben und wiederkehrende Fristen.

Termine lassen sich als ICS-Datei ausgeben - die liest sowohl Apple Kalender
als auch Google Kalender.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta

import datenbank as db
from rechnung import kundenname

WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
          "September", "Oktober", "November", "Dezember"]


def datum_lang(iso: str) -> str:
    try:
        d = datetime.strptime((iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return iso or ""
    return "%s, %d. %s %d" % (WOCHENTAGE[d.weekday()], d.day, MONATE[d.month - 1], d.year)


def monat(conn, jahr: int, mon: int) -> dict:
    """Alle Eintraege eines Monats, nach Tagen sortiert.

    Das Raster reicht ueber den Monat hinaus: oben stehen die letzten Tage des
    Vormonats, unten die ersten des Folgemonats. Diese Randtage werden bewusst
    mit abgefragt - sonst blieben sie leer, obwohl dort etwas ansteht.
    """
    wochen = calendar.Calendar(firstweekday=0).monthdatescalendar(jahr, mon)
    von, bis = wochen[0][0].isoformat(), wochen[-1][-1].isoformat()
    eintraege = {}

    def dazu(tag, art, titel, zusatz="", id_=None, farbe=""):
        if not tag or not (von <= tag[:10] <= bis):
            return
        eintraege.setdefault(tag[:10], []).append(
            {"art": art, "titel": titel, "zusatz": zusatz, "id": id_, "farbe": farbe})

    for t in db.zeilen(conn, """SELECT t.*, k.firma, k.vorname, k.nachname, k.art AS kart
                                FROM termine t LEFT JOIN kunden k ON k.id=t.kunde_id
                                WHERE t.datum BETWEEN ? AND ?""", (von, bis)):
        zeit = t["von"] or ""
        if t["von"] and t["bis"]:
            zeit = "%s–%s" % (t["von"], t["bis"])
        zusatz = " · ".join(x for x in [zeit, t["ort"] or "",
                                        kundenname({"art": t["kart"], "firma": t["firma"],
                                                    "vorname": t["vorname"],
                                                    "nachname": t["nachname"]})] if x)
        dazu(t["datum"], "termin", t["titel"], zusatz, t["id"])

    for a in db.zeilen(conn, """SELECT a.*, k.firma, k.vorname, k.nachname, k.art AS kart
                                FROM auftraege a JOIN kunden k ON k.id=a.kunde_id
                                WHERE a.start BETWEEN ? AND ? OR a.ende BETWEEN ? AND ?""",
                       (von, bis, von, bis)):
        kunde = kundenname({"art": a["kart"], "firma": a["firma"], "vorname": a["vorname"],
                            "nachname": a["nachname"]})
        dazu(a["start"], "auftrag-start", "Start: " + (a["titel"] or a["nummer"]), kunde, a["id"])
        dazu(a["ende"], "auftrag-ende", "Abgabe: " + (a["titel"] or a["nummer"]), kunde, a["id"])

    for r in db.zeilen(conn, """SELECT r.*, k.firma, k.vorname, k.nachname, k.art AS kart
                                FROM rechnungen r JOIN kunden k ON k.id=r.kunde_id
                                WHERE r.typ='rechnung' AND r.status='offen'
                                AND r.faellig_am BETWEEN ? AND ?""", (von, bis)):
        kunde = kundenname({"art": r["kart"], "firma": r["firma"], "vorname": r["vorname"],
                            "nachname": r["nachname"]})
        dazu(r["faellig_am"], "rechnung", "Zahlung fällig: %s" % r["nummer"],
             "%s · %.2f €" % (kunde, r["brutto"] or 0), r["id"])

    for g in db.zeilen(conn, """SELECT * FROM aufgaben WHERE erledigt=0
                                AND faellig BETWEEN ? AND ?
                                ORDER BY uhrzeit='', uhrzeit""",
                       (von, bis)):
        dazu(g["faellig"], "aufgabe", g["titel"],
             "%s Uhr" % g["uhrzeit"] if g["uhrzeit"] else "", g["id"])

    for k in db.zeilen(conn, """SELECT id, nummer, firma, vorname, nachname, art,
                                wiedervorlage, wiedervorlage_text FROM kunden
                                WHERE wiedervorlage BETWEEN ? AND ?""", (von, bis)):
        dazu(k["wiedervorlage"], "wiedervorlage", "Nachfassen: " + kundenname(k),
             k["wiedervorlage_text"] or "", k["id"])

    raster = [[{"datum": t.isoformat(), "tag": t.day, "fremd": t.month != mon,
                "monatskuerzel": MONATE[t.month - 1][:3] if t.month != mon else "",
                "heute": t == date.today(),
                "eintraege": eintraege.get(t.isoformat(), [])} for t in woche]
              for woche in wochen]
    eigener = "%04d-%02d" % (jahr, mon)
    return {"jahr": jahr, "monat": mon, "name": MONATE[mon - 1], "raster": raster,
            "anzahl": sum(len(v) for k, v in eintraege.items() if k[:7] == eigener)}


def naechste_tage(conn, tage: int = 14) -> list:
    """Was in den naechsten Tagen ansteht - fuer die Startseite."""
    heute = date.today()
    ende = heute + timedelta(days=tage)
    ergebnis, gemerkt = [], {}
    for versatz in range((ende - heute).days + 1):
        tag = heute + timedelta(days=versatz)
        schluessel = (tag.year, tag.month)
        if schluessel not in gemerkt:
            m = monat(conn, tag.year, tag.month)
            gemerkt[schluessel] = {z["datum"]: z["eintraege"]
                                   for woche in m["raster"] for z in woche
                                   if not z["fremd"]}
        eintraege = gemerkt[schluessel].get(tag.isoformat())
        if eintraege:
            ergebnis.append({"datum": tag.isoformat(), "lang": datum_lang(tag.isoformat()),
                             "eintraege": eintraege})
    return ergebnis


# --------------------------------------------------------------------------
# Wiederkehrende Fristen
# --------------------------------------------------------------------------

def _weiter(iso: str, rhythmus: str) -> str:
    try:
        d = datetime.strptime((iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return ""
    if rhythmus == "monatlich":
        jahr, mon = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    elif rhythmus == "quartalsweise":
        mon = d.month + 3
        jahr = d.year + (mon - 1) // 12
        mon = (mon - 1) % 12 + 1
    elif rhythmus == "jaehrlich":
        jahr, mon = d.year + 1, d.month
    else:
        return ""
    tag = min(d.day, calendar.monthrange(jahr, mon)[1])
    return date(jahr, mon, tag).isoformat()


def fristen_nachziehen(conn) -> int:
    """Erledigte wiederkehrende Aufgaben legen automatisch die naechste an."""
    neu = 0
    with conn:
        for a in db.zeilen(conn, "SELECT * FROM aufgaben WHERE erledigt=1 AND rhythmus != ''"):
            naechstes = _weiter(a["faellig"], a["rhythmus"])
            if not naechstes:
                continue
            schon_da = conn.execute(
                "SELECT COUNT(*) AS n FROM aufgaben WHERE titel=? AND faellig=? AND erledigt=0",
                (a["titel"], naechstes)).fetchone()["n"]
            if schon_da:
                continue
            conn.execute("""INSERT INTO aufgaben (titel, beschreibung, faellig, uhrzeit,
                            wichtig, kunde_id, auftrag_id, rhythmus, quelle)
                            VALUES (?,?,?,?,?,?,?,?,?)""",
                         (a["titel"], a["beschreibung"], naechstes, a["uhrzeit"], a["wichtig"],
                          a["kunde_id"], a["auftrag_id"], a["rhythmus"], "wiederkehrend"))
            conn.execute("UPDATE aufgaben SET rhythmus='' WHERE id=?", (a["id"],))
            neu += 1
    return neu


def standardfristen(jahr: int) -> list:
    """Vorschlaege fuer wiederkehrende Termine im Jahreslauf."""
    return [
        {"titel": "Einkommensteuererklärung abgeben", "faellig": "%d-07-31" % jahr,
         "rhythmus": "jaehrlich",
         "beschreibung": "Frist ohne Steuerberater. Mit Berater verlängert sie sich."},
        {"titel": "Belege des Vorjahres sortieren", "faellig": "%d-01-31" % jahr,
         "rhythmus": "jaehrlich", "beschreibung": "Alles zusammenlegen, was zur EÜR gehört."},
        {"titel": "Offene Rechnungen prüfen", "faellig": "%d-%02d-01" % (jahr, date.today().month),
         "rhythmus": "monatlich", "beschreibung": "Wer hat noch nicht bezahlt?"},
        {"titel": "Umsatzsteuervoranmeldung", "faellig": "%d-%02d-10" % (jahr, date.today().month),
         "rhythmus": "quartalsweise",
         "beschreibung": "Nur nötig, wenn die Kleinunternehmerregelung nicht mehr gilt."},
        {"titel": "Datensicherung auf externe Platte ziehen", "faellig": "%d-%02d-28" % (jahr, date.today().month),
         "rhythmus": "monatlich", "beschreibung": "Der Ordner „daten“ gehört an einen zweiten Ort."},
    ]


# --------------------------------------------------------------------------
# ICS fuer Apple- und Google-Kalender
# --------------------------------------------------------------------------

def _ics_text(wert: str) -> str:
    return (str(wert or "").replace("\\", "\\\\").replace(";", "\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def _ics_datum(iso: str, zeit: str = "") -> str:
    tag = (iso or "").replace("-", "")[:8]
    if zeit and ":" in zeit:
        return "%sT%s00" % (tag, zeit.replace(":", ""))
    return tag


def ics(conn) -> str:
    zeilen = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MeinOrbit//DE", "CALSCALE:GREGORIAN",
              "X-WR-CALNAME:MeinOrbit"]
    stempel = datetime.now().strftime("%Y%m%dT%H%M%SZ")

    def eintrag(uid, titel, datum, von="", bis="", ort="", notiz=""):
        zeilen.append("BEGIN:VEVENT")
        zeilen.append("UID:%s@meinorbit" % uid)
        zeilen.append("DTSTAMP:" + stempel)
        if von:
            zeilen.append("DTSTART:" + _ics_datum(datum, von))
            zeilen.append("DTEND:" + _ics_datum(datum, bis or von))
        else:
            zeilen.append("DTSTART;VALUE=DATE:" + _ics_datum(datum))
        zeilen.append("SUMMARY:" + _ics_text(titel))
        if ort:
            zeilen.append("LOCATION:" + _ics_text(ort))
        if notiz:
            zeilen.append("DESCRIPTION:" + _ics_text(notiz))
        zeilen.append("END:VEVENT")

    for t in db.zeilen(conn, "SELECT * FROM termine WHERE datum != ''"):
        eintrag("termin-%d" % t["id"], t["titel"], t["datum"], t["von"], t["bis"],
                t["ort"], t["notiz"])
    for a in db.zeilen(conn, "SELECT * FROM auftraege WHERE ende != ''"):
        eintrag("auftrag-%d" % a["id"], "Abgabe: " + (a["titel"] or a["nummer"]), a["ende"],
                notiz=a["beschreibung"])
    for r in db.zeilen(conn, """SELECT * FROM rechnungen WHERE typ='rechnung'
                                AND status='offen' AND faellig_am != ''"""):
        eintrag("rechnung-%d" % r["id"], "Zahlung fällig: %s" % r["nummer"], r["faellig_am"])
    for g in db.zeilen(conn, "SELECT * FROM aufgaben WHERE erledigt=0 AND faellig != ''"):
        eintrag("aufgabe-%d" % g["id"], g["titel"], g["faellig"], g["uhrzeit"],
                notiz=g["beschreibung"])

    zeilen.append("END:VCALENDAR")
    return "\r\n".join(zeilen) + "\r\n"
