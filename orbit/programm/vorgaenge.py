#!/usr/bin/env python3
"""Die Vorgaenge hinter der Oberflaeche - alles, was Daten veraendert.

Hier liegen die Regeln: Nummernvergabe, Uebernahme von Belegen in Rechnungen,
Festschreibung nach GoBD, Storno statt Loeschen, Mahnstufen.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime

import datenbank as db
import rechnung as rg


class Fehler(Exception):
    """Etwas ist nicht erlaubt - die Meldung geht an die Oberflaeche."""


# --------------------------------------------------------------------------
# Kunden
# --------------------------------------------------------------------------

KUNDENFELDER = ["art", "firma", "vorname", "nachname", "anrede", "strasse", "plz", "ort", "land",
                "objekt_strasse", "objekt_plz", "objekt_ort", "telefon", "mobil", "email",
                "ust_id", "leitweg_id", "notizen", "tags", "zahlungsziel", "rabatt",
                "wiedervorlage", "wiedervorlage_text", "archiviert"]


def kunde_speichern(conn, daten: dict) -> int:
    e = db.einstellungen_lesen(conn)
    werte = {f: daten.get(f) for f in KUNDENFELDER if f in daten}
    kunde_id = daten.get("id")
    with conn:
        if kunde_id:
            if werte:
                conn.execute("UPDATE kunden SET %s WHERE id=?"
                             % ", ".join("%s=?" % f for f in werte),
                             list(werte.values()) + [kunde_id])
        else:
            nummer = daten.get("nummer") or db.naechste_nummer(
                conn, e["kunden_praefix"] + "{nummer}", int(e["kunden_stellen"] or 4),
                "nummer", "kunden")
            werte["nummer"] = nummer
            werte["angelegt_am"] = date.today().isoformat()
            spalten = ", ".join(werte)
            conn.execute("INSERT INTO kunden (%s) VALUES (%s)"
                         % (spalten, ", ".join("?" * len(werte))), list(werte.values()))
            kunde_id = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
            db.protokollieren(conn, "Kunde", "angelegt", "%s %s" % (nummer, rg.kundenname(werte)))
    return kunde_id


def kunde_loeschen(conn, kunde_id: int) -> None:
    anzahl = conn.execute("SELECT COUNT(*) AS n FROM rechnungen WHERE kunde_id=? AND festgeschrieben=1",
                          (kunde_id,)).fetchone()["n"]
    if anzahl:
        raise Fehler("Zu diesem Kunden gibt es %d festgeschriebene Rechnungen. "
                     "Er lässt sich nur archivieren, nicht löschen." % anzahl)
    with conn:
        for tabelle in ("kundennotizen", "kundenpreise", "dokumente", "belege"):
            conn.execute("DELETE FROM %s WHERE kunde_id=?" % tabelle, (kunde_id,))
        for a in db.zeilen(conn, "SELECT id FROM auftraege WHERE kunde_id=?", (kunde_id,)):
            conn.execute("DELETE FROM auftragsposten WHERE auftrag_id=?", (a["id"],))
            conn.execute("DELETE FROM zeiten WHERE auftrag_id=?", (a["id"],))
        conn.execute("DELETE FROM auftraege WHERE kunde_id=?", (kunde_id,))
        for r in db.zeilen(conn, "SELECT id FROM rechnungen WHERE kunde_id=?", (kunde_id,)):
            conn.execute("DELETE FROM rechnungsposten WHERE rechnung_id=?", (r["id"],))
        conn.execute("DELETE FROM rechnungen WHERE kunde_id=?", (kunde_id,))
        conn.execute("DELETE FROM kunden WHERE id=?", (kunde_id,))
        db.protokollieren(conn, "Kunde", "gelöscht", "Kunde %d" % kunde_id)


def kunde_akte(conn, kunde_id: int) -> dict:
    kunde = db.zeile(conn, "SELECT * FROM kunden WHERE id=?", (kunde_id,))
    if not kunde:
        raise Fehler("Dieses Kundenkonto gibt es nicht.")
    kunde["name"] = rg.kundenname(kunde)
    kunde["merkmale"] = [t.strip() for t in (kunde.get("tags") or "").split(",") if t.strip()]

    auftraege = db.zeilen(conn, "SELECT * FROM auftraege WHERE kunde_id=? ORDER BY angelegt_am DESC, id DESC",
                          (kunde_id,))
    for a in auftraege:
        a["summe"] = auftrag_summe(conn, a["id"])
        a["stunden"] = round(sum(float(z["stunden"] or 0) for z in db.zeilen(
            conn, "SELECT stunden FROM zeiten WHERE auftrag_id=?", (a["id"],))), 2)

    rechnungen = db.zeilen(conn, """SELECT * FROM rechnungen WHERE kunde_id=?
                                    ORDER BY datum DESC, id DESC""", (kunde_id,))
    belege = db.zeilen(conn, "SELECT * FROM belege WHERE kunde_id=? ORDER BY datum DESC", (kunde_id,))
    notizen = db.zeilen(conn, "SELECT * FROM kundennotizen WHERE kunde_id=? ORDER BY datum DESC, id DESC",
                        (kunde_id,))
    dokumente = db.zeilen(conn, "SELECT * FROM dokumente WHERE kunde_id=? ORDER BY datum DESC",
                          (kunde_id,))
    preise = db.zeilen(conn, "SELECT * FROM kundenpreise WHERE kunde_id=? ORDER BY id", (kunde_id,))

    bezahlt = sum(float(r["brutto"] or 0) for r in rechnungen
                  if r["typ"] == "rechnung" and r["status"] == "bezahlt")
    offen = sum(float(r["brutto"] or 0) for r in rechnungen
                if r["typ"] == "rechnung" and r["status"] == "offen")
    return {"kunde": kunde, "auftraege": auftraege, "rechnungen": rechnungen, "belege": belege,
            "notizen": notizen, "dokumente": dokumente, "preise": preise,
            "kennzahlen": {"umsatz": round(bezahlt, 2), "offen": round(offen, 2),
                           "auftraege": len(auftraege),
                           "seit": kunde.get("angelegt_am") or ""}}


def kundenliste(conn, suche: str = "", merkmal: str = "", mit_archiv: bool = False) -> list:
    sql = """SELECT k.*,
                (SELECT COUNT(*) FROM auftraege a WHERE a.kunde_id=k.id) AS anzahl_auftraege,
                (SELECT IFNULL(ROUND(SUM(r.brutto),2),0) FROM rechnungen r
                   WHERE r.kunde_id=k.id AND r.typ='rechnung' AND r.status='bezahlt') AS umsatz,
                (SELECT IFNULL(ROUND(SUM(r.brutto),2),0) FROM rechnungen r
                   WHERE r.kunde_id=k.id AND r.typ='rechnung' AND r.status='offen') AS offen,
                (SELECT MAX(r.datum) FROM rechnungen r WHERE r.kunde_id=k.id) AS letzte_rechnung
             FROM kunden k"""
    bedingungen, werte = [], []
    if not mit_archiv:
        bedingungen.append("k.archiviert = 0")
    if suche:
        felder = ["firma", "vorname", "nachname", "ort", "nummer", "email", "telefon", "tags", "notizen"]
        bedingungen.append("(" + " OR ".join("k.%s LIKE ?" % f for f in felder) + ")")
        werte += ["%" + suche + "%"] * len(felder)
    if merkmal:
        bedingungen.append("k.tags LIKE ?")
        werte.append("%" + merkmal + "%")
    if bedingungen:
        sql += " WHERE " + " AND ".join(bedingungen)
    sql += " ORDER BY k.archiviert, k.nummer"
    liste = db.zeilen(conn, sql, werte)
    for k in liste:
        k["name"] = rg.kundenname(k)
        k["merkmale"] = [t.strip() for t in (k.get("tags") or "").split(",") if t.strip()]
    return liste


def alle_merkmale(conn) -> list:
    gefunden = set()
    for k in db.zeilen(conn, "SELECT tags FROM kunden"):
        for t in (k["tags"] or "").split(","):
            if t.strip():
                gefunden.add(t.strip())
    return sorted(gefunden)


# --------------------------------------------------------------------------
# Auftraege
# --------------------------------------------------------------------------

AUFTRAGSFELDER = ["kunde_id", "titel", "beschreibung", "ort", "status", "fortschritt",
                  "start", "ende", "stundensatz", "notizen"]

STATUSNAMEN = {"anfrage": "Anfrage", "angebot": "Angebot", "planung": "In der Planung",
               "bearbeitung": "In Bearbeitung", "fertig": "Fertig",
               "abgerechnet": "Abgerechnet", "abgelehnt": "Abgelehnt"}


def auftrag_summe(conn, auftrag_id: int) -> float:
    posten = db.zeilen(conn, "SELECT menge, einzelpreis, steuersatz FROM auftragsposten WHERE auftrag_id=?",
                       (auftrag_id,))
    return rg.summen(posten)["brutto"]


def auftrag_speichern(conn, daten: dict) -> int:
    e = db.einstellungen_lesen(conn)
    werte = {f: daten.get(f) for f in AUFTRAGSFELDER if f in daten}
    auftrag_id = daten.get("id")
    with conn:
        if auftrag_id:
            if werte:
                conn.execute("UPDATE auftraege SET %s WHERE id=?"
                             % ", ".join("%s=?" % f for f in werte),
                             list(werte.values()) + [auftrag_id])
        else:
            if not werte.get("kunde_id"):
                raise Fehler("Ein Auftrag braucht ein Kundenkonto.")
            werte["nummer"] = db.naechste_nummer(conn, e["auftrag_muster"], 3, "nummer", "auftraege")
            werte["angelegt_am"] = date.today().isoformat()
            conn.execute("INSERT INTO auftraege (%s) VALUES (%s)"
                         % (", ".join(werte), ", ".join("?" * len(werte))), list(werte.values()))
            auftrag_id = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
            db.protokollieren(conn, "Auftrag", "angelegt", werte["nummer"])
    if "posten" in daten:
        posten_setzen(conn, "auftragsposten", "auftrag_id", auftrag_id, daten["posten"])
    return auftrag_id


def posten_setzen(conn, tabelle: str, spalte: str, eltern_id: int, posten: list) -> None:
    """Schreibt die Positionsliste neu.

    Bei Auftragspositionen bleiben bereits abgerechnete Zeilen unangetastet -
    dieselbe Regel wie bei gebuchten Zeiten und weiterberechneten Belegen.
    Neue Zeilen haengen sich hinten an.
    """
    fest, beginn = [], 0
    if tabelle == "auftragsposten":
        fest = db.zeilen(conn, "SELECT id, position FROM auftragsposten "
                               "WHERE auftrag_id=? AND abgerechnet=1", (eltern_id,))
        beginn = max([int(f["position"] or 0) for f in fest] + [0])
    feste_ids = {f["id"] for f in fest}

    with conn:
        if fest:
            conn.execute("DELETE FROM auftragsposten WHERE auftrag_id=? AND COALESCE(abgerechnet,0)=0",
                         (eltern_id,))
        else:
            conn.execute("DELETE FROM %s WHERE %s=?" % (tabelle, spalte), (eltern_id,))
        i = beginn
        for p in posten or []:
            # Kaeme eine abgerechnete Zeile zurueck (alte Seite im Browser),
            # wuerde sie sonst ein zweites Mal entstehen.
            if p.get("id") in feste_ids:
                continue
            i += 1
            felder = {spalte: eltern_id, "position": i,
                      "bezeichnung": p.get("bezeichnung") or "",
                      "menge": float(p.get("menge") or 0),
                      "einheit": p.get("einheit") or "Stück",
                      "einzelpreis": float(p.get("einzelpreis") or 0),
                      "steuersatz": float(p.get("steuersatz") or 0)}
            if tabelle == "rechnungsposten":
                felder["betrag"] = round(felder["menge"] * felder["einzelpreis"], 2)
            conn.execute("INSERT INTO %s (%s) VALUES (%s)"
                         % (tabelle, ", ".join(felder), ", ".join("?" * len(felder))),
                         list(felder.values()))


def auftrag_akte(conn, auftrag_id: int) -> dict:
    auftrag = db.zeile(conn, "SELECT * FROM auftraege WHERE id=?", (auftrag_id,))
    if not auftrag:
        raise Fehler("Diesen Auftrag gibt es nicht.")
    kunde = db.zeile(conn, "SELECT * FROM kunden WHERE id=?", (auftrag["kunde_id"],)) or {}
    kunde["name"] = rg.kundenname(kunde)
    posten = db.zeilen(conn, "SELECT * FROM auftragsposten WHERE auftrag_id=? ORDER BY position",
                       (auftrag_id,))
    zeiten = db.zeilen(conn, "SELECT * FROM zeiten WHERE auftrag_id=? ORDER BY datum DESC, id DESC",
                       (auftrag_id,))
    belege = db.zeilen(conn, "SELECT * FROM belege WHERE auftrag_id=? ORDER BY datum", (auftrag_id,))
    rechnungen = db.zeilen(conn, "SELECT * FROM rechnungen WHERE auftrag_id=? ORDER BY datum",
                           (auftrag_id,))
    auftrag["statusname"] = STATUSNAMEN.get(auftrag["status"], auftrag["status"])
    offene_posten = [p for p in posten if not p.get("abgerechnet")]
    return {"auftrag": auftrag, "kunde": kunde, "posten": posten,
            "posten_offen": offene_posten, "zeiten": zeiten,
            "belege": belege, "rechnungen": rechnungen,
            "summe": rg.summen(posten), "summe_offen": rg.summen(offene_posten),
            "stunden": round(sum(float(z["stunden"] or 0) for z in zeiten), 2),
            "stunden_offen": round(sum(float(z["stunden"] or 0) for z in zeiten
                                       if not z["abgerechnet"]), 2)}


def auftragsliste(conn, status: str = "", kunde_id=None, suche: str = "") -> list:
    sql = """SELECT a.*, k.nummer AS kundennummer, k.firma, k.vorname, k.nachname, k.art
             FROM auftraege a JOIN kunden k ON k.id=a.kunde_id"""
    bedingungen, werte = [], []
    if status:
        bedingungen.append("a.status=?")
        werte.append(status)
    if kunde_id:
        bedingungen.append("a.kunde_id=?")
        werte.append(kunde_id)
    if suche:
        bedingungen.append("(a.titel LIKE ? OR a.nummer LIKE ? OR a.beschreibung LIKE ? "
                           "OR k.firma LIKE ? OR k.nachname LIKE ?)")
        werte += ["%" + suche + "%"] * 5
    if bedingungen:
        sql += " WHERE " + " AND ".join(bedingungen)
    sql += " ORDER BY CASE a.status WHEN 'bearbeitung' THEN 0 WHEN 'planung' THEN 1 " \
           "WHEN 'angebot' THEN 2 WHEN 'anfrage' THEN 3 WHEN 'fertig' THEN 4 ELSE 5 END, " \
           "a.ende, a.id DESC"
    liste = db.zeilen(conn, sql, werte)
    for a in liste:
        a["kunde"] = rg.kundenname(a)
        a["summe"] = auftrag_summe(conn, a["id"])
        a["statusname"] = STATUSNAMEN.get(a["status"], a["status"])
        a["stunden"] = round(sum(float(z["stunden"] or 0) for z in db.zeilen(
            conn, "SELECT stunden FROM zeiten WHERE auftrag_id=?", (a["id"],))), 2)
    return liste


# --------------------------------------------------------------------------
# Rechnungen und Angebote
# --------------------------------------------------------------------------

def _nummer_vergeben(conn, typ: str, e: dict) -> str:
    if typ == "angebot":
        return db.naechste_nummer(conn, e["angebot_muster"], int(e["rechnung_stellen"] or 4),
                                  "nummer", "rechnungen", "typ='angebot'")
    return db.naechste_nummer(conn, e["rechnung_muster"], int(e["rechnung_stellen"] or 4),
                              "nummer", "rechnungen", "typ IN ('rechnung','storno')")


def _summen_schreiben(conn, rechnung_id: int) -> dict:
    posten = db.zeilen(conn, "SELECT * FROM rechnungsposten WHERE rechnung_id=? ORDER BY position",
                       (rechnung_id,))
    s = rg.summen(posten)
    with conn:
        conn.execute("UPDATE rechnungen SET netto=?, steuer=?, brutto=? WHERE id=?",
                     (s["netto"], s["steuer"], s["brutto"], rechnung_id))
    return s


RECHNUNGSFELDER = ["kunde_id", "auftrag_id", "typ", "datum", "leistungsdatum", "zahlungsziel",
                   "kopftext", "fusstext", "vorlage", "wiederkehrend", "rhythmus", "naechste_am"]


def rechnung_speichern(conn, daten: dict) -> int:
    e = db.einstellungen_lesen(conn)
    rechnung_id = daten.get("id")
    if rechnung_id:
        vorher = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
        if not vorher:
            raise Fehler("Diese Rechnung gibt es nicht.")
        if vorher["festgeschrieben"]:
            raise Fehler("Diese Rechnung ist festgeschrieben und darf nicht mehr geändert "
                         "werden. Erstelle stattdessen eine Rechnungskorrektur.")
    werte = {f: daten.get(f) for f in RECHNUNGSFELDER if f in daten}
    if "datum" in werte or "zahlungsziel" in werte or not rechnung_id:
        datum = werte.get("datum") or (vorher["datum"] if rechnung_id else date.today().isoformat())
        ziel = werte.get("zahlungsziel", vorher["zahlungsziel"] if rechnung_id
                         else int(e["zahlungsziel"] or 14))
        werte["faellig_am"] = rg.faelligkeit(datum, int(ziel or 0))
    with conn:
        if rechnung_id:
            if werte:
                conn.execute("UPDATE rechnungen SET %s WHERE id=?"
                             % ", ".join("%s=?" % f for f in werte),
                             list(werte.values()) + [rechnung_id])
        else:
            if not werte.get("kunde_id"):
                raise Fehler("Eine Rechnung braucht ein Kundenkonto.")
            werte.setdefault("typ", "rechnung")
            werte.setdefault("datum", date.today().isoformat())
            werte.setdefault("zahlungsziel", int(e["zahlungsziel"] or 14))
            werte.setdefault("vorlage", e.get("vorlage") or "klar")
            werte.setdefault("fusstext", e.get("fusstext") or "")
            werte["status"] = "entwurf"
            werte["angelegt_am"] = date.today().isoformat()
            conn.execute("INSERT INTO rechnungen (%s) VALUES (%s)"
                         % (", ".join(werte), ", ".join("?" * len(werte))), list(werte.values()))
            rechnung_id = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
    if "posten" in daten:
        posten_setzen(conn, "rechnungsposten", "rechnung_id", rechnung_id, daten["posten"])
    _summen_schreiben(conn, rechnung_id)
    return rechnung_id


def rechnung_akte(conn, rechnung_id: int) -> dict:
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    kunde = db.zeile(conn, "SELECT * FROM kunden WHERE id=?", (r["kunde_id"],)) or {}
    kunde["name"] = rg.kundenname(kunde)
    posten = db.zeilen(conn, "SELECT * FROM rechnungsposten WHERE rechnung_id=? ORDER BY position",
                       (rechnung_id,))
    auftrag = db.zeile(conn, "SELECT * FROM auftraege WHERE id=?", (r["auftrag_id"],)) if r["auftrag_id"] else None
    r["ueberfaellig"] = bool(r["status"] == "offen" and r["faellig_am"]
                             and r["faellig_am"] < date.today().isoformat())
    return {"rechnung": r, "kunde": kunde, "posten": posten, "auftrag": auftrag,
            "summe": rg.summen(posten)}


def rechnungsliste(conn, typ: str = "", status: str = "", jahr: str = "", kunde_id=None,
                   suche: str = "") -> list:
    sql = """SELECT r.*, k.nummer AS kundennummer, k.firma, k.vorname, k.nachname, k.art,
                    a.nummer AS auftragsnummer
             FROM rechnungen r JOIN kunden k ON k.id=r.kunde_id
             LEFT JOIN auftraege a ON a.id=r.auftrag_id"""
    bedingungen, werte = [], []
    if typ == "angebot":
        bedingungen.append("r.typ='angebot'")
    elif typ:
        bedingungen.append("r.typ IN ('rechnung','storno')")
    if status:
        if status == "ueberfaellig":
            bedingungen.append("r.status='offen' AND r.faellig_am < ?")
            werte.append(date.today().isoformat())
        else:
            bedingungen.append("r.status=?")
            werte.append(status)
    if jahr:
        bedingungen.append("r.datum BETWEEN ? AND ?")
        werte += ["%s-01-01" % jahr, "%s-12-31" % jahr]
    if kunde_id:
        bedingungen.append("r.kunde_id=?")
        werte.append(kunde_id)
    if suche:
        bedingungen.append("(r.nummer LIKE ? OR k.firma LIKE ? OR k.nachname LIKE ? "
                           "OR k.vorname LIKE ?)")
        werte += ["%" + suche + "%"] * 4
    if bedingungen:
        sql += " WHERE " + " AND ".join(bedingungen)
    sql += " ORDER BY r.datum DESC, r.id DESC"
    heute = date.today().isoformat()
    liste = db.zeilen(conn, sql, werte)
    for r in liste:
        r["kunde"] = rg.kundenname(r)
        r["ueberfaellig"] = bool(r["status"] == "offen" and r["faellig_am"] and r["faellig_am"] < heute)
    return liste


def aus_auftrag(conn, auftrag_id: int, typ: str = "rechnung") -> int:
    """Erzeugt Angebot oder Rechnung aus einem Auftrag - samt Belegen und Zeiten."""
    akte = auftrag_akte(conn, auftrag_id)
    auftrag = akte["auftrag"]
    e = db.einstellungen_lesen(conn)
    kunde = akte["kunde"]

    # Fuer eine Rechnung zaehlt nur, was noch nicht abgerechnet ist - wie bei
    # Zeiten und Belegen. Ein Angebot zeigt dagegen immer den ganzen Auftrag.
    quelle = akte["posten"] if typ == "angebot" else akte["posten_offen"]
    posten = [{"bezeichnung": p["bezeichnung"], "menge": p["menge"], "einheit": p["einheit"],
               "einzelpreis": p["einzelpreis"], "steuersatz": p["steuersatz"]}
              for p in quelle]

    # Nicht abgerechnete Stunden mit dem Stundensatz des Auftrags
    if typ == "rechnung" and akte["stunden_offen"] and float(auftrag.get("stundensatz") or 0) > 0:
        posten.append({"bezeichnung": "Arbeitszeit %s" % (auftrag["titel"] or auftrag["nummer"]),
                       "menge": akte["stunden_offen"], "einheit": "Stunde",
                       "einzelpreis": float(auftrag["stundensatz"]),
                       "steuersatz": 0 if e.get("kleinunternehmer") == "ja"
                       else float(e.get("steuersatz") or 0)})

    # Weiterberechenbare Belege
    offene_belege = [b for b in akte["belege"] if b["weiterberechnen"] and not b["abgerechnet"]]
    if typ == "rechnung":
        for b in offene_belege:
            posten.append({"bezeichnung": "Auslage: %s" % (b["beschreibung"] or b["kategorie"]),
                           "menge": 1, "einheit": "Pauschale",
                           "einzelpreis": float(b["betrag"] or 0),
                           "steuersatz": 0 if e.get("kleinunternehmer") == "ja"
                           else float(e.get("steuersatz") or 0)})

    if not posten:
        if typ == "rechnung" and akte["posten"]:
            raise Fehler("Aus diesem Auftrag ist bereits alles abgerechnet. Trag neue "
                         "Positionen ein oder buche Zeiten, dann geht es weiter.")
        raise Fehler("Der Auftrag hat noch keine Positionen. Trag zuerst ein, "
                     "was abgerechnet werden soll.")

    rechnung_id = rechnung_speichern(conn, {
        "kunde_id": auftrag["kunde_id"], "auftrag_id": auftrag_id, "typ": typ,
        "datum": date.today().isoformat(),
        "leistungsdatum": auftrag.get("ende") or auftrag.get("start") or "",
        "zahlungsziel": int(kunde.get("zahlungsziel") or e.get("zahlungsziel") or 14),
        "posten": posten,
    })
    with conn:
        if typ == "rechnung":
            for b in offene_belege:
                conn.execute("UPDATE belege SET abgerechnet=1, rechnung_id=? WHERE id=?",
                             (rechnung_id, b["id"]))
            conn.execute("UPDATE zeiten SET abgerechnet=1 WHERE auftrag_id=? AND abgerechnet=0",
                         (auftrag_id,))
            conn.execute("""UPDATE auftragsposten SET abgerechnet=1, rechnung_id=?
                            WHERE auftrag_id=? AND COALESCE(abgerechnet,0)=0""",
                         (rechnung_id, auftrag_id))
        conn.execute("UPDATE auftraege SET status=? WHERE id=?",
                     ("angebot" if typ == "angebot" else "abgerechnet", auftrag_id))
        db.protokollieren(conn, "Auftrag", "abgerechnet",
                          "%s → Vorgang %d" % (auftrag["nummer"], rechnung_id))
    return rechnung_id


def festschreiben(conn, rechnung_id: int) -> dict:
    """Vergibt die endgueltige Nummer. Danach ist der Beleg unveraenderlich."""
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    if r["festgeschrieben"]:
        raise Fehler("Dieser Vorgang ist bereits festgeschrieben.")
    posten = db.zeilen(conn, "SELECT * FROM rechnungsposten WHERE rechnung_id=?", (rechnung_id,))
    if not posten:
        raise Fehler("Ohne Positionen lässt sich nichts festschreiben.")
    e = db.einstellungen_lesen(conn)
    nummer = r["nummer"] or _nummer_vergeben(conn, r["typ"], e)
    _summen_schreiben(conn, rechnung_id)
    with conn:
        conn.execute("""UPDATE rechnungen SET nummer=?, festgeschrieben=1, status=?
                        WHERE id=?""",
                     (nummer, "offen", rechnung_id))
        db.protokollieren(conn, "Rechnung", "festgeschrieben",
                          "%s über %.2f €" % (nummer, r["brutto"] or 0))
    return db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))


def bezahlt_setzen(conn, rechnung_id: int, datum: str = "", betrag=None) -> dict:
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    with conn:
        if r["status"] == "bezahlt":
            conn.execute("""UPDATE rechnungen SET status='offen', bezahlt_am='',
                            bezahlt_betrag=0 WHERE id=?""", (rechnung_id,))
            db.protokollieren(conn, "Rechnung", "Zahlung zurückgenommen", r["nummer"] or "")
        else:
            conn.execute("""UPDATE rechnungen SET status='bezahlt', bezahlt_am=?,
                            bezahlt_betrag=?, mahnstufe=0 WHERE id=?""",
                         (datum or date.today().isoformat(),
                          float(betrag) if betrag is not None else r["brutto"], rechnung_id))
            db.protokollieren(conn, "Rechnung", "Geld eingegangen",
                              "%s über %.2f €" % (r["nummer"] or "", r["brutto"] or 0))
    return db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))


def stornieren(conn, rechnung_id: int, grund: str = "") -> int:
    """Legt eine Rechnungskorrektur an - das Original bleibt unangetastet."""
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    if r["typ"] != "rechnung":
        raise Fehler("Nur Rechnungen lassen sich korrigieren.")
    if r["storniert_durch"]:
        raise Fehler("Zu dieser Rechnung gibt es bereits eine Korrektur.")
    if not r["festgeschrieben"]:
        raise Fehler("Ein Entwurf braucht keine Korrektur – du kannst ihn einfach löschen.")
    posten = db.zeilen(conn, "SELECT * FROM rechnungsposten WHERE rechnung_id=? ORDER BY position",
                       (rechnung_id,))
    e = db.einstellungen_lesen(conn)
    neu_id = rechnung_speichern(conn, {
        "kunde_id": r["kunde_id"], "auftrag_id": r["auftrag_id"], "typ": "storno",
        "datum": date.today().isoformat(), "leistungsdatum": r["leistungsdatum"],
        "zahlungsziel": 0,
        "kopftext": grund or ("Hiermit korrigieren wir die Rechnung %s vollständig."
                              % (r["nummer"] or "")),
        "posten": [{"bezeichnung": p["bezeichnung"], "menge": p["menge"], "einheit": p["einheit"],
                    "einzelpreis": p["einzelpreis"], "steuersatz": p["steuersatz"]} for p in posten],
    })
    nummer = _nummer_vergeben(conn, "storno", e)
    with conn:
        conn.execute("""UPDATE rechnungen SET nummer=?, festgeschrieben=1, status='offen',
                        storno_von=? WHERE id=?""", (nummer, rechnung_id, neu_id))
        conn.execute("UPDATE rechnungen SET status='storniert', storniert_durch=? WHERE id=?",
                     (neu_id, rechnung_id))
        for b in db.zeilen(conn, "SELECT id FROM belege WHERE rechnung_id=?", (rechnung_id,)):
            conn.execute("UPDATE belege SET abgerechnet=0, rechnung_id=NULL WHERE id=?", (b["id"],))
        # Was die stornierte Rechnung getragen hat, steht im Auftrag wieder offen.
        conn.execute("UPDATE auftragsposten SET abgerechnet=0, rechnung_id=NULL WHERE rechnung_id=?",
                     (rechnung_id,))
        db.protokollieren(conn, "Rechnung", "korrigiert",
                          "%s storniert durch %s" % (r["nummer"] or "", nummer))
    return neu_id


def mahnen(conn, rechnung_id: int) -> dict:
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    if r["status"] != "offen":
        raise Fehler("Nur offene Rechnungen lassen sich anmahnen.")
    stufe = min(3, int(r["mahnstufe"] or 0) + 1)
    with conn:
        conn.execute("UPDATE rechnungen SET mahnstufe=?, mahnung_am=? WHERE id=?",
                     (stufe, date.today().isoformat(), rechnung_id))
        db.protokollieren(conn, "Rechnung", "Mahnstufe %d" % stufe, r["nummer"] or "")
    return db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))


def rechnung_loeschen(conn, rechnung_id: int) -> None:
    r = db.zeile(conn, "SELECT * FROM rechnungen WHERE id=?", (rechnung_id,))
    if not r:
        raise Fehler("Diesen Vorgang gibt es nicht.")
    if r["festgeschrieben"]:
        raise Fehler("Festgeschriebene Belege dürfen nicht gelöscht werden – das verlangt "
                     "die GoBD. Erstelle eine Rechnungskorrektur.")
    with conn:
        conn.execute("UPDATE belege SET abgerechnet=0, rechnung_id=NULL WHERE rechnung_id=?",
                     (rechnung_id,))
        conn.execute("UPDATE auftragsposten SET abgerechnet=0, rechnung_id=NULL WHERE rechnung_id=?",
                     (rechnung_id,))
        conn.execute("DELETE FROM rechnungsposten WHERE rechnung_id=?", (rechnung_id,))
        conn.execute("DELETE FROM rechnungen WHERE id=?", (rechnung_id,))
        db.protokollieren(conn, "Rechnung", "Entwurf gelöscht", str(rechnung_id))


def angebot_annehmen(conn, rechnung_id: int) -> int:
    """Aus einem angenommenen Angebot wird ein Auftrag."""
    a = rechnung_akte(conn, rechnung_id)
    r = a["rechnung"]
    if r["typ"] != "angebot":
        raise Fehler("Das ist kein Angebot.")
    auftrag_id = r["auftrag_id"]
    if not auftrag_id:
        auftrag_id = auftrag_speichern(conn, {
            "kunde_id": r["kunde_id"], "titel": "Auftrag zu Angebot %s" % (r["nummer"] or ""),
            "status": "planung", "start": date.today().isoformat(),
            "posten": [{"bezeichnung": p["bezeichnung"], "menge": p["menge"],
                        "einheit": p["einheit"], "einzelpreis": p["einzelpreis"],
                        "steuersatz": p["steuersatz"]} for p in a["posten"]]})
    with conn:
        conn.execute("UPDATE rechnungen SET status='angenommen', auftrag_id=? WHERE id=?",
                     (auftrag_id, rechnung_id))
        conn.execute("UPDATE auftraege SET status='planung' WHERE id=? AND status IN ('anfrage','angebot')",
                     (auftrag_id,))
        db.protokollieren(conn, "Angebot", "angenommen", r["nummer"] or "")
    return auftrag_id


def wiederkehrende_pruefen(conn) -> int:
    """Legt faellige Folgerechnungen fuer Daueraufträge als Entwurf an."""
    heute = date.today().isoformat()
    neu = 0
    for r in db.zeilen(conn, """SELECT * FROM rechnungen WHERE wiederkehrend=1
                                AND naechste_am != '' AND naechste_am <= ?""", (heute,)):
        posten = db.zeilen(conn, "SELECT * FROM rechnungsposten WHERE rechnung_id=? ORDER BY position",
                           (r["id"],))
        neu_id = rechnung_speichern(conn, {
            "kunde_id": r["kunde_id"], "auftrag_id": r["auftrag_id"], "typ": "rechnung",
            "datum": r["naechste_am"], "zahlungsziel": r["zahlungsziel"],
            "kopftext": r["kopftext"], "fusstext": r["fusstext"], "vorlage": r["vorlage"],
            "posten": [{"bezeichnung": p["bezeichnung"], "menge": p["menge"],
                        "einheit": p["einheit"], "einzelpreis": p["einzelpreis"],
                        "steuersatz": p["steuersatz"]} for p in posten]})
        import kalender
        naechstes = kalender._weiter(r["naechste_am"], r["rhythmus"])
        with conn:
            conn.execute("UPDATE rechnungen SET naechste_am=? WHERE id=?", (naechstes, r["id"]))
            db.protokollieren(conn, "Rechnung", "Folgerechnung angelegt",
                              "aus %s → Entwurf %d" % (r["nummer"] or "", neu_id))
        neu += 1
    return neu


# --------------------------------------------------------------------------
# Dateien
# --------------------------------------------------------------------------

# Zeichen, die Mac oder Windows im Dateinamen nicht erlauben. Alles andere -
# Umlaute, Gedankenstriche, Klammern, Euro-Zeichen - darf bleiben, damit der
# Name lesbar aussieht.
_VERBOTEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sicherer_name(name: str) -> str:
    name = _VERBOTEN.sub("_", os.path.basename(name or "datei"))
    name = " ".join(name.split()).strip(" .")
    return name[:120].strip(" .") or "datei"


def sprechender_name(originalname: str, datum=None, betrag=None,
                     kategorie: str = "", wofuer: str = "") -> str:
    """Baut den sprechenden Dateinamen: Datum, Betrag, Kategorie, Wofuer.

    Aus "IMG_4711.jpg" wird "2026-08-15 58,89 EUR Software Jahreslizenz.jpg".
    Was fehlt, faellt einfach weg; die Endung bleibt immer erhalten.
    """
    endung = os.path.splitext(originalname or "")[1].lower() or ".dat"
    teile = []
    if datum:
        teile.append(str(datum)[:10])
    if betrag not in (None, ""):
        try:
            teile.append(("%.2f" % float(betrag)).replace(".", ",") + " EUR")
        except (TypeError, ValueError):
            pass
    kategorie = " ".join(str(kategorie or "").replace("/", "-").replace("\\", "-").split())
    wofuer = " ".join(str(wofuer or "").replace("/", "-").replace("\\", "-").split())
    # Steht die Kategorie schon vorn im Zweck ("Vertrag" / "Vertrag Bad Salzuflen"),
    # wird sie nicht doppelt genannt.
    if kategorie and not wofuer.lower().startswith(kategorie.lower()):
        teile.append(kategorie[:60])
    if wofuer:
        teile.append(wofuer[:60])
    stamm = _sicherer_name(" ".join(teile))[:110].strip(" .")
    return (stamm or "Beleg") + endung


def _freier_pfad(name: str, ausser: str = "") -> str:
    """Sucht einen noch freien Platz im Dokumentenordner (haengt _1, _2 an)."""
    ziel = os.path.join(db.DOKUMENTE, name)
    stamm, endung = os.path.splitext(name)
    zaehler = 1
    while os.path.exists(ziel) and ziel != ausser:
        ziel = os.path.join(db.DOKUMENTE, "%s_%d%s" % (stamm, zaehler, endung))
        zaehler += 1
    return ziel


def datei_ablegen(conn, inhalt: bytes, dateiname: str) -> str:
    """Speichert eine Datei im Ordner `daten/dokumente` und gibt den Namen zurueck."""
    os.makedirs(db.DOKUMENTE, exist_ok=True)
    ziel = _freier_pfad(_sicherer_name(dateiname))
    with open(ziel, "wb") as f:
        f.write(inhalt)
    return os.path.basename(ziel)


def datei_umbenennen(alt: str, wunschname: str) -> str:
    """Benennt eine schon abgelegte Datei um und gibt den gueltigen Namen zurueck:
    den neuen, wenn es geklappt hat, sonst unveraendert den alten."""
    if not alt or not wunschname:
        return alt
    quelle = os.path.join(db.DOKUMENTE, alt)
    name = _sicherer_name(wunschname)
    if name == alt or not os.path.isfile(quelle):
        return alt
    ziel = _freier_pfad(name, ausser=quelle)
    if ziel == quelle:
        return alt
    try:
        os.rename(quelle, ziel)
    except OSError:
        return alt
    return os.path.basename(ziel)


# --------------------------------------------------------------------------
# Startseite
# --------------------------------------------------------------------------

def startseite(conn) -> dict:
    import content
    import finanzen
    import kalender

    heute = date.today()
    e = db.einstellungen_lesen(conn)
    kalender.fristen_nachziehen(conn)
    neue_folgerechnungen = wiederkehrende_pruefen(conn)

    offen = finanzen.offene_posten(conn)
    eingang = finanzen.erwarteter_eingang(conn)
    stat = finanzen.statistik(conn, heute.year)
    z = finanzen.euer(conn, heute.year)

    erinnerungen = []
    for p in offen:
        if p["typ"] == "storno":
            erinnerungen.append({"art": "hinweis", "text": "Rechnungskorrektur %s an %s über %s € "
                                 "ist noch nicht erstattet." % (p["nummer"], p["kunde"],
                                                                rg.geld(p["brutto"])),
                                 "ziel": "rechnung", "id": p["id"]})
        elif p["ueberfaellig"]:
            erinnerungen.append({"art": "warnung", "text": "Rechnung %s an %s ist seit %d Tagen "
                                 "überfällig (%s €)." % (p["nummer"], p["kunde"], abs(p["tage"] or 0),
                                                         rg.geld(p["brutto"])),
                                 "ziel": "rechnung", "id": p["id"]})
    entwuerfe = db.zeilen(conn, "SELECT COUNT(*) AS n FROM rechnungen WHERE status='entwurf'")[0]["n"]
    if entwuerfe:
        erinnerungen.append({"art": "hinweis", "text": "%d Rechnungsentwürfe warten darauf, "
                             "festgeschrieben und verschickt zu werden." % entwuerfe,
                             "ziel": "rechnungen", "id": None})
    if neue_folgerechnungen:
        erinnerungen.append({"art": "hinweis", "text": "%d Folgerechnung(en) für Daueraufträge "
                             "wurden als Entwurf angelegt." % neue_folgerechnungen,
                             "ziel": "rechnungen", "id": None})
    for k in db.zeilen(conn, """SELECT id, nummer, firma, vorname, nachname, art, wiedervorlage,
                                wiedervorlage_text FROM kunden
                                WHERE wiedervorlage != '' AND wiedervorlage <= ?""",
                       (heute.isoformat(),)):
        erinnerungen.append({"art": "hinweis", "text": "Wiedervorlage: %s – %s"
                             % (rg.kundenname(k), k["wiedervorlage_text"] or "nachfassen"),
                             "ziel": "kunde", "id": k["id"]})
    for a in db.zeilen(conn, """SELECT a.*, k.firma, k.vorname, k.nachname, k.art FROM auftraege a
                                JOIN kunden k ON k.id=a.kunde_id
                                WHERE a.status='fertig'"""):
        erinnerungen.append({"art": "hinweis", "text": "Auftrag %s für %s ist fertig – "
                             "abrechnen?" % (a["nummer"], rg.kundenname(a)),
                             "ziel": "auftrag", "id": a["id"]})

    aufgaben = db.zeilen(conn, """SELECT * FROM aufgaben WHERE erledigt=0
                                  ORDER BY faellig='', faellig, uhrzeit='', uhrzeit,
                                           wichtig DESC LIMIT 12""")
    for g in aufgaben:
        g["ueberfaellig"] = bool(g["faellig"] and g["faellig"] < heute.isoformat())
        g["heute"] = g["faellig"] == heute.isoformat()

    return {
        "datum": heute.isoformat(),
        "datum_lang": kalender.datum_lang(heute.isoformat()),
        "firma": e.get("firma_name") or e.get("firma_inhaber") or "",
        "eingerichtet": bool(e.get("firma_name") or e.get("firma_inhaber")),
        "kennzahlen": {
            "umsatz_jahr": stat["umsatz"], "vorjahr": stat["vorjahr"],
            "veraenderung": stat["veraenderung"],
            "gewinn": z["gewinn"], "ausgaben": z["ausgaben"],
            "ruecklage": z["ruecklage"], "ruecklage_satz": z["ruecklage_satz"],
            "offene_anzahl": len(offen),
            "kunden": db.zeilen(conn, "SELECT COUNT(*) AS n FROM kunden WHERE archiviert=0")[0]["n"],
            "auftraege_laufend": db.zeilen(
                conn, "SELECT COUNT(*) AS n FROM auftraege WHERE status IN ('planung','bearbeitung')")[0]["n"],
        },
        "eingang": eingang,
        "offene_posten": offen[:8],
        "erinnerungen": erinnerungen,
        "aufgaben": aufgaben,
        "termine": kalender.naechste_tage(conn, 14)[:6],
        "monat": kalender.monat(conn, heute.year, heute.month),
        "monate": stat["monate"],
        "content": _content_kurz(conn, content, heute),
    }


def _content_kurz(conn, content, heute) -> dict:
    """Was die Startseite von der Contentplanung zeigt: was demnaechst
    rausgeht, was noch ohne Datum herumliegt und wie der laufende Monat steht."""
    kanaele = [a for a in content.accounts(conn, nur_aktive=True)]
    monat = content.monat(conn, heute.year, heute.month)
    stand = monat["nach_stand"]
    ideen = content.ohne_datum(conn)
    return {
        "kanaele": len(kanaele),
        "naechste": content.naechste(conn, 14)[:5],
        "ideen": ideen[:6],
        "ideen_anzahl": len(ideen),
        "monat_name": monat["name"],
        "monat_anzahl": monat["anzahl"],
        "fertig": stand.get("fertig", 0),
    }
