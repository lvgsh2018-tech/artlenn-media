#!/usr/bin/env python3
"""MeinOrbit – Verwaltungsprogramm für Kleinunternehmer.

Kunden, Aufträge, Rechnungen, Finanzen, Kalender und Aufgaben an einem Ort.
Alle Daten bleiben auf diesem Rechner, im Ordner `daten`.

Starten mit einem Doppelklick auf `Start.command` oder das Symbol im Dock.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import sys
import threading
import time
import webbrowser
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HIER = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HIER)

import content                  # noqa: E402
import datenbank as db          # noqa: E402
import finanzen                 # noqa: E402
import kalender                 # noqa: E402
import rechnung as rg           # noqa: E402
import sperre                   # noqa: E402
import vorgaenge as vg          # noqa: E402

PORT = 8768
OBERFLAECHE = os.path.join(HIER, "oberflaeche.html")


# --------------------------------------------------------------------------
# Die Endpunkte
# --------------------------------------------------------------------------

def _int(wert):
    try:
        return int(wert)
    except (TypeError, ValueError):
        return None


def endpunkt(pfad: str, frage: dict, koerper: dict, methode: str):
    """Liefert (daten, dateityp, rohbytes). Nur einer der beiden ersten Werte zaehlt."""
    conn = db.verbindung()
    try:
        teile = [t for t in pfad.strip("/").split("/") if t]
        e = db.einstellungen_lesen(conn)

        def f(name, standard=""):
            return (frage.get(name, [standard]) or [standard])[0]

        # ---- Startseite ------------------------------------------------
        if teile == ["api", "start"]:
            return vg.startseite(conn), None, None

        # ---- Einstellungen ---------------------------------------------
        if teile == ["api", "einstellungen"]:
            if methode == "POST":
                db.einstellungen_schreiben(conn, koerper)
                return {"ok": True, "einstellungen": db.einstellungen_lesen(conn)}, None, None
            return {"einstellungen": e,
                    "leistungen": db.zeilen(conn, "SELECT * FROM leistungen ORDER BY name"),
                    "protokoll": db.zeilen(conn, "SELECT * FROM protokoll ORDER BY id DESC LIMIT 60"),
                    "sicherungen": _sicherungen(),
                    "ordner": db.DATEN}, None, None

        # ---- Kunden ----------------------------------------------------
        if teile == ["api", "kunden"]:
            if methode == "POST":
                kunde_id = vg.kunde_speichern(conn, koerper)
                return {"ok": True, "id": kunde_id}, None, None
            return {"kunden": vg.kundenliste(conn, f("suche"), f("merkmal"), f("archiv") == "ja"),
                    "merkmale": vg.alle_merkmale(conn)}, None, None

        if len(teile) == 3 and teile[:2] == ["api", "kunde"]:
            kunde_id = _int(teile[2])
            if methode == "DELETE":
                vg.kunde_loeschen(conn, kunde_id)
                return {"ok": True}, None, None
            return vg.kunde_akte(conn, kunde_id), None, None

        if teile == ["api", "kundennotiz"]:
            if methode == "DELETE":
                conn.execute("DELETE FROM kundennotizen WHERE id=?", (koerper.get("id"),))
                conn.commit()
            else:
                with conn:
                    conn.execute("""INSERT INTO kundennotizen (kunde_id, datum, art, text)
                                    VALUES (?,?,?,?)""",
                                 (koerper.get("kunde_id"), koerper.get("datum") or date.today().isoformat(),
                                  koerper.get("art") or "Notiz", koerper.get("text") or ""))
            return {"ok": True}, None, None

        if teile == ["api", "kundenpreis"]:
            if methode == "DELETE":
                conn.execute("DELETE FROM kundenpreise WHERE id=?", (koerper.get("id"),))
                conn.commit()
            else:
                with conn:
                    conn.execute("""INSERT INTO kundenpreise (kunde_id, leistung_id, bezeichnung,
                                    preis, bemerkung) VALUES (?,?,?,?,?)""",
                                 (koerper.get("kunde_id"), koerper.get("leistung_id"),
                                  koerper.get("bezeichnung") or "", float(koerper.get("preis") or 0),
                                  koerper.get("bemerkung") or ""))
            return {"ok": True}, None, None

        # ---- Auftraege --------------------------------------------------
        if teile == ["api", "auftraege"]:
            if methode == "POST":
                return {"ok": True, "id": vg.auftrag_speichern(conn, koerper)}, None, None
            return {"auftraege": vg.auftragsliste(conn, f("status"), _int(f("kunde")), f("suche")),
                    "status": vg.STATUSNAMEN}, None, None

        if len(teile) == 3 and teile[:2] == ["api", "auftrag"]:
            auftrag_id = _int(teile[2])
            if methode == "DELETE":
                with conn:
                    conn.execute("DELETE FROM auftragsposten WHERE auftrag_id=?", (auftrag_id,))
                    conn.execute("DELETE FROM zeiten WHERE auftrag_id=?", (auftrag_id,))
                    conn.execute("UPDATE belege SET auftrag_id=NULL WHERE auftrag_id=?", (auftrag_id,))
                    conn.execute("DELETE FROM auftraege WHERE id=?", (auftrag_id,))
                return {"ok": True}, None, None
            return vg.auftrag_akte(conn, auftrag_id), None, None

        if len(teile) == 4 and teile[:2] == ["api", "auftrag"] and teile[3] in ("rechnung", "angebot"):
            neu = vg.aus_auftrag(conn, _int(teile[2]), teile[3])
            return {"ok": True, "id": neu}, None, None

        if teile == ["api", "zeit"]:
            if methode == "DELETE":
                conn.execute("DELETE FROM zeiten WHERE id=?", (koerper.get("id"),))
                conn.commit()
            else:
                with conn:
                    conn.execute("""INSERT INTO zeiten (auftrag_id, datum, stunden, beschreibung)
                                    VALUES (?,?,?,?)""",
                                 (koerper.get("auftrag_id"),
                                  koerper.get("datum") or date.today().isoformat(),
                                  float(koerper.get("stunden") or 0), koerper.get("beschreibung") or ""))
            return {"ok": True}, None, None

        # ---- Rechnungen und Angebote ------------------------------------
        if teile == ["api", "rechnungen"]:
            if methode == "POST":
                return {"ok": True, "id": vg.rechnung_speichern(conn, koerper)}, None, None
            return {"rechnungen": vg.rechnungsliste(conn, f("typ", "rechnung"), f("status"),
                                                    f("jahr"), _int(f("kunde")), f("suche")),
                    "jahre": finanzen.jahre(conn)}, None, None

        if len(teile) == 3 and teile[:2] == ["api", "rechnung"]:
            rechnung_id = _int(teile[2])
            if methode == "DELETE":
                vg.rechnung_loeschen(conn, rechnung_id)
                return {"ok": True}, None, None
            return vg.rechnung_akte(conn, rechnung_id), None, None

        if len(teile) == 4 and teile[:2] == ["api", "rechnung"]:
            rechnung_id, was = _int(teile[2]), teile[3]
            if was == "festschreiben":
                return {"ok": True, "rechnung": vg.festschreiben(conn, rechnung_id)}, None, None
            if was == "bezahlt":
                return {"ok": True, "rechnung": vg.bezahlt_setzen(
                    conn, rechnung_id, koerper.get("datum", ""), koerper.get("betrag"))}, None, None
            if was == "storno":
                return {"ok": True, "id": vg.stornieren(conn, rechnung_id,
                                                        koerper.get("grund", ""))}, None, None
            if was == "mahnen":
                return {"ok": True, "rechnung": vg.mahnen(conn, rechnung_id)}, None, None
            if was == "annehmen":
                return {"ok": True, "auftrag_id": vg.angebot_annehmen(conn, rechnung_id)}, None, None
            if was == "ablehnen":
                with conn:
                    conn.execute("UPDATE rechnungen SET status='abgelehnt' WHERE id=?", (rechnung_id,))
                return {"ok": True}, None, None

        # ---- Belege und Ausgaben ----------------------------------------
        if teile == ["api", "belege"]:
            if methode == "POST":
                daten = dict(koerper)
                dateiname = _datei_uebernehmen(conn, daten, "belege")
                if daten.get("id"):
                    felder = {k: daten[k] for k in ("kunde_id", "auftrag_id", "datum", "beschreibung",
                                                    "kategorie", "betrag", "weiterberechnen")
                              if k in daten}
                    if dateiname:
                        felder["dateiname"] = dateiname
                    with conn:
                        conn.execute("UPDATE belege SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [daten["id"]])
                        _datei_nachziehen(conn, "belege", daten["id"])
                else:
                    with conn:
                        conn.execute("""INSERT INTO belege (kunde_id, auftrag_id, datum, beschreibung,
                                        kategorie, betrag, weiterberechnen, dateiname)
                                        VALUES (?,?,?,?,?,?,?,?)""",
                                     (daten.get("kunde_id"), daten.get("auftrag_id"),
                                      daten.get("datum") or date.today().isoformat(),
                                      daten.get("beschreibung") or "",
                                      daten.get("kategorie") or "Sonstiges",
                                      float(daten.get("betrag") or 0),
                                      1 if daten.get("weiterberechnen") else 0, dateiname))
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM belege WHERE id=? AND abgerechnet=0", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None
            return {"belege": db.zeilen(conn, """SELECT b.*, k.nummer AS kundennummer, k.firma,
                                                 k.vorname, k.nachname, k.art FROM belege b
                                                 LEFT JOIN kunden k ON k.id=b.kunde_id
                                                 ORDER BY b.datum DESC, b.id DESC""")}, None, None

        # ---- Geld ohne Rechnung ------------------------------------------
        if teile == ["api", "einnahmen"]:
            if methode == "POST":
                daten = dict(koerper)
                dateiname = _datei_uebernehmen(conn, daten, "einnahmen")
                with conn:
                    if daten.get("id"):
                        felder = {k: daten[k] for k in ("datum", "beschreibung", "kategorie",
                                                        "betrag", "zahlungsart", "kunde_id")
                                  if k in daten}
                        if dateiname:
                            felder["dateiname"] = dateiname
                        conn.execute("UPDATE einnahmen SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [daten["id"]])
                        _datei_nachziehen(conn, "einnahmen", daten["id"])
                        db.protokollieren(conn, "Einnahme", "geändert",
                                          "Beleg %s" % (daten.get("beleg_nummer") or daten["id"]))
                    else:
                        wann = daten.get("datum") or date.today().isoformat()
                        nummer = db.naechste_nummer(conn, "E-{jahr}-{nummer}", 4, "beleg_nummer",
                                                    "einnahmen", jahr=wann[:4])
                        conn.execute("""INSERT INTO einnahmen (datum, beschreibung, kategorie,
                                        betrag, zahlungsart, kunde_id, beleg_nummer, dateiname,
                                        angelegt_am) VALUES (?,?,?,?,?,?,?,?,?)""",
                                     (wann, daten.get("beschreibung") or "",
                                      daten.get("kategorie") or "Barverkauf",
                                      float(daten.get("betrag") or 0),
                                      daten.get("zahlungsart") or "bar",
                                      _int(daten.get("kunde_id")), nummer, dateiname,
                                      datetime.now().isoformat(timespec="seconds")))
                        db.protokollieren(conn, "Einnahme", "gebucht",
                                          "%s über %.2f €" % (nummer, float(daten.get("betrag") or 0)))
                return {"ok": True}, None, None
            if methode == "DELETE":
                with conn:
                    weg = db.zeile(conn, "SELECT * FROM einnahmen WHERE id=?", (koerper.get("id"),))
                    conn.execute("DELETE FROM einnahmen WHERE id=?", (koerper.get("id"),))
                    if weg:
                        db.protokollieren(conn, "Einnahme", "gelöscht", "%s über %.2f €"
                                          % (weg.get("beleg_nummer") or "", float(weg.get("betrag") or 0)))
                return {"ok": True}, None, None
            return {"einnahmen": finanzen.direkte_einnahmen(conn),
                    "zahlungsarten": finanzen.ZAHLUNGSARTEN}, None, None

        if teile == ["api", "ausgaben"]:
            if methode == "POST":
                daten = dict(koerper)
                dateiname = _datei_uebernehmen(conn, daten, "ausgaben")
                with conn:
                    if daten.get("id"):
                        felder = {k: daten[k] for k in ("datum", "beschreibung", "kategorie",
                                                        "betrag", "rhythmus") if k in daten}
                        if dateiname:
                            felder["dateiname"] = dateiname
                        conn.execute("UPDATE ausgaben SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [daten["id"]])
                        _datei_nachziehen(conn, "ausgaben", daten["id"])
                    else:
                        conn.execute("""INSERT INTO ausgaben (datum, beschreibung, kategorie,
                                        betrag, rhythmus, dateiname) VALUES (?,?,?,?,?,?)""",
                                     (daten.get("datum") or date.today().isoformat(),
                                      daten.get("beschreibung") or "",
                                      daten.get("kategorie") or "Sonstiges",
                                      float(daten.get("betrag") or 0),
                                      daten.get("rhythmus") or "", dateiname))
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM ausgaben WHERE id=?", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None
            return {"ausgaben": db.zeilen(conn, "SELECT * FROM ausgaben ORDER BY datum DESC, id DESC")}, None, None

        # ---- Finanzen ----------------------------------------------------
        if teile == ["api", "finanzen"]:
            jahr = f("jahr", str(date.today().year))
            return {"jahr": int(jahr), "jahre": finanzen.jahre(conn),
                    "euer": finanzen.euer(conn, jahr),
                    "statistik": finanzen.statistik(conn, jahr),
                    "eingang": finanzen.erwarteter_eingang(conn),
                    "offene_posten": finanzen.offene_posten(conn),
                    "ruecklage": finanzen.steuerruecklage(conn, jahr)}, None, None

        # ---- Kalender, Termine, Aufgaben ---------------------------------
        if teile == ["api", "kalender"]:
            heute = date.today()
            jahr = _int(f("jahr")) or heute.year
            monat = _int(f("monat")) or heute.month
            return {"monat": kalender.monat(conn, jahr, monat),
                    "naechste": kalender.naechste_tage(conn, 21)}, None, None

        if teile == ["api", "termine"]:
            if methode == "POST":
                felder = {k: koerper.get(k) for k in ("titel", "datum", "von", "bis", "ganztags",
                                                      "ort", "notiz", "kunde_id", "auftrag_id")
                          if k in koerper}
                with conn:
                    if koerper.get("id"):
                        conn.execute("UPDATE termine SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [koerper["id"]])
                    else:
                        conn.execute("INSERT INTO termine (%s) VALUES (%s)"
                                     % (", ".join(felder), ", ".join("?" * len(felder))),
                                     list(felder.values()))
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM termine WHERE id=?", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None
            return {"termine": db.zeilen(conn, "SELECT * FROM termine ORDER BY datum")}, None, None

        if teile == ["api", "aufgaben"]:
            if methode == "POST":
                felder = {k: koerper.get(k) for k in ("titel", "beschreibung", "faellig", "uhrzeit",
                                                      "erledigt", "wichtig", "kunde_id",
                                                      "auftrag_id", "rhythmus")
                          if k in koerper}
                if koerper.get("erledigt"):
                    felder["erledigt_am"] = date.today().isoformat()
                with conn:
                    if koerper.get("id"):
                        conn.execute("UPDATE aufgaben SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [koerper["id"]])
                    else:
                        conn.execute("INSERT INTO aufgaben (%s) VALUES (%s)"
                                     % (", ".join(felder), ", ".join("?" * len(felder))),
                                     list(felder.values()))
                kalender.fristen_nachziehen(conn)
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM aufgaben WHERE id=?", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None
            return {"aufgaben": db.zeilen(conn, """SELECT g.*, k.firma, k.vorname, k.nachname, k.art
                                                   FROM aufgaben g LEFT JOIN kunden k ON k.id=g.kunde_id
                                                   ORDER BY g.erledigt, g.faellig='', g.faellig,
                                                            g.uhrzeit='', g.uhrzeit"""),
                    "vorschlaege": kalender.standardfristen(date.today().year)}, None, None

        # ---- Contentplanung ----------------------------------------------
        if teile == ["api", "content"]:
            heute = date.today()
            jahr = _int(f("jahr")) or heute.year
            mon = _int(f("monat")) or heute.month
            nur = [x for x in f("kanaele").split(",") if x.strip().isdigit()]
            return {"monat": content.monat(conn, jahr, mon, nur),
                    "accounts": content.accounts(conn),
                    "naechste": content.naechste(conn, 21),
                    "ohne_datum": content.ohne_datum(conn, nur),
                    "listen": content.auswahllisten()}, None, None

        if teile == ["api", "content", "account"]:
            if methode == "DELETE":
                geloest = content.account_loeschen(conn, _int(koerper.get("id")))
                return {"ok": True, "geloest": geloest}, None, None
            return {"ok": True, "id": content.account_speichern(conn, koerper)}, None, None

        if len(teile) == 4 and teile[:3] == ["api", "content", "beitrag"]:
            return {"beitrag": content.beitrag(conn, _int(teile[3]))}, None, None

        if teile == ["api", "content", "beitrag"]:
            if methode == "DELETE":
                content.beitrag_loeschen(conn, _int(koerper.get("id")))
                return {"ok": True}, None, None
            return {"ok": True, "id": content.beitrag_speichern(conn, koerper)}, None, None

        # ---- Leistungskatalog --------------------------------------------
        if teile == ["api", "leistungen"]:
            if methode == "POST":
                felder = {k: koerper.get(k) for k in ("name", "beschreibung", "einheit", "preis",
                                                      "steuersatz", "aktiv") if k in koerper}
                with conn:
                    if koerper.get("id"):
                        conn.execute("UPDATE leistungen SET %s WHERE id=?"
                                     % ", ".join("%s=?" % k for k in felder),
                                     list(felder.values()) + [koerper["id"]])
                    else:
                        conn.execute("INSERT INTO leistungen (%s) VALUES (%s)"
                                     % (", ".join(felder), ", ".join("?" * len(felder))),
                                     list(felder.values()))
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM leistungen WHERE id=?", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None
            return {"leistungen": db.zeilen(conn, "SELECT * FROM leistungen ORDER BY name")}, None, None

        # ---- Dokumente ----------------------------------------------------
        if teile == ["api", "dokumente"]:
            if methode == "POST":
                daten = dict(koerper)
                dateiname = _datei_uebernehmen(conn, daten, "dokumente")
                with conn:
                    conn.execute("""INSERT INTO dokumente (kunde_id, auftrag_id, titel, art,
                                    dateiname, datum) VALUES (?,?,?,?,?,?)""",
                                 (daten.get("kunde_id"), daten.get("auftrag_id"),
                                  daten.get("titel") or dateiname, daten.get("art") or "Sonstiges",
                                  dateiname, daten.get("datum") or date.today().isoformat()))
                return {"ok": True}, None, None
            if methode == "DELETE":
                conn.execute("DELETE FROM dokumente WHERE id=?", (koerper.get("id"),))
                conn.commit()
                return {"ok": True}, None, None

        # ---- Sicherung und Ausgabe ----------------------------------------
        if teile == ["api", "sicherung"]:
            ziel = db.sicherung_anlegen(int(e.get("sicherung_anzahl") or 30))
            with conn:
                db.protokollieren(conn, "Daten", "gesichert", os.path.basename(ziel))
            return {"ok": True, "datei": os.path.basename(ziel), "ordner": db.SICHERUNGEN}, None, None

        if teile == ["api", "ordner"]:
            _ordner_zeigen(koerper.get("pfad") or db.DATEN)
            return {"ok": True}, None, None

        # ---- Zuruecksetzen -------------------------------------------------
        # Nur ueber POST und nur mit dem ausgeschriebenen Wort aus der
        # Rueckfrage. So kann kein versehentlicher Aufruf den Bestand leeren.
        if teile == ["api", "zuruecksetzen"]:
            if methode != "POST":
                raise vg.Fehler("Zurücksetzen geht nur über die Rückfrage im Programm.")
            umfang = koerper.get("umfang")
            if umfang not in ("alles", "daten"):
                raise vg.Fehler("Unklar, was zurückgesetzt werden soll.")
            wort = "ALLES LOESCHEN" if umfang == "alles" else "DATEN LOESCHEN"
            if _wort(koerper.get("bestaetigung")) != wort:
                raise vg.Fehler("Das Wort stimmt nicht – es wurde nichts gelöscht.")
            # Vor dem Leeren immer noch einmal sichern, unabhaengig von der
            # Einstellung. Das ist das Netz, falls der Griff danebengeht.
            try:
                gesichert = os.path.basename(db.sicherung_anlegen(0) or "")
            except Exception:  # noqa: BLE001
                gesichert = ""
            db.zuruecksetzen(conn, alles=(umfang == "alles"))
            with conn:
                db.protokollieren(conn, "Daten", "zurückgesetzt",
                                  "Alles zurückgesetzt" if umfang == "alles"
                                  else "Daten gelöscht, Firmenangaben behalten")
            return {"ok": True, "sicherung": gesichert, "ordner": db.SICHERUNGEN}, None, None

        return None, None, None
    finally:
        conn.close()


# Woraus der Dateiname gebaut wird: Datum, Betrag, Kategorie, Wofuer.
# Kundendokumente haben keinen Betrag - dort bleibt die Stelle leer.
_DATEI_FELDER = {
    "belege":    ("datum", "betrag", "kategorie", "beschreibung"),
    "einnahmen": ("datum", "betrag", "kategorie", "beschreibung"),
    "ausgaben":  ("datum", "betrag", "kategorie", "beschreibung"),
    "dokumente": ("datum", None, "art", "titel"),
}


def _eckdaten(conn, tabelle: str, daten: dict) -> dict:
    """Die vier Angaben fuer den Dateinamen. Beim Aendern wird ergaenzt, was im
    Formular fehlt, aber schon in der Datenbank steht."""
    d_feld, b_feld, k_feld, z_feld = _DATEI_FELDER[tabelle]
    alt = {}
    if daten.get("id"):
        alt = db.zeile(conn, "SELECT * FROM %s WHERE id=?" % tabelle, (daten["id"],)) or {}

    def hole(feld):
        if not feld:
            return None
        wert = daten.get(feld)
        return alt.get(feld) if wert in (None, "") else wert

    return {"datum": hole(d_feld) or date.today().isoformat(),
            "betrag": hole(b_feld),
            "kategorie": hole(k_feld) or "",
            "wofuer": hole(z_feld) or ""}


def _datei_uebernehmen(conn, daten: dict, tabelle: str = "") -> str:
    """Nimmt eine als Text uebergebene Datei entgegen, benennt sie nach Datum,
    Betrag, Kategorie und Zweck und legt sie ab."""
    inhalt = daten.pop("datei_inhalt", None)
    name = daten.pop("datei_name", None)
    if not inhalt or not name:
        return ""
    if "," in inhalt and inhalt.startswith("data:"):
        inhalt = inhalt.split(",", 1)[1]
    try:
        roh = base64.b64decode(inhalt)
    except Exception:
        return ""
    if tabelle in _DATEI_FELDER:
        name = vg.sprechender_name(name, **_eckdaten(conn, tabelle, daten))
    return vg.datei_ablegen(conn, roh, name)


def _datei_nachziehen(conn, tabelle: str, eintrag_id) -> None:
    """Zieht den Dateinamen nach, sobald sich Datum, Betrag, Kategorie oder
    Zweck geaendert haben - damit Name und Eintrag zusammenpassen."""
    if not eintrag_id or tabelle not in _DATEI_FELDER:
        return
    eintrag = db.zeile(conn, "SELECT * FROM %s WHERE id=?" % tabelle, (eintrag_id,))
    if not eintrag or not eintrag.get("dateiname"):
        return
    wunsch = vg.sprechender_name(eintrag["dateiname"], **_eckdaten(conn, tabelle, dict(eintrag)))
    neuer = vg.datei_umbenennen(eintrag["dateiname"], wunsch)
    if neuer != eintrag["dateiname"]:
        conn.execute("UPDATE %s SET dateiname=? WHERE id=?" % tabelle, (neuer, eintrag_id))


def _wort(text) -> str:
    """Vergleichbar machen: Umlaute, Leerraum und Gross-/Kleinschreibung egal."""
    text = (text or "").strip().upper()
    for von, nach in (("Ö", "OE"), ("Ä", "AE"), ("Ü", "UE")):
        text = text.replace(von, nach)
    return " ".join(text.split())


def _sicherungen() -> list:
    if not os.path.isdir(db.SICHERUNGEN):
        return []
    liste = []
    for name in sorted(os.listdir(db.SICHERUNGEN), reverse=True)[:12]:
        pfad = os.path.join(db.SICHERUNGEN, name)
        if os.path.isfile(pfad):
            liste.append({"name": name, "groesse": round(os.path.getsize(pfad) / 1024.0, 1),
                          "zeit": datetime.fromtimestamp(os.path.getmtime(pfad)).strftime("%d.%m.%Y %H:%M")})
    return liste


def _ordner_zeigen(pfad: str) -> None:
    try:
        if sys.platform == "darwin":
            os.system('open "%s"' % pfad.replace('"', ''))
        elif os.name == "nt":
            os.startfile(pfad)  # noqa
        else:
            os.system('xdg-open "%s"' % pfad.replace('"', ''))
    except Exception:
        pass


# --------------------------------------------------------------------------
# Seiten zum Ansehen und Herunterladen
# --------------------------------------------------------------------------

def seiten(pfad: str, frage: dict):
    conn = db.verbindung()
    try:
        e = db.einstellungen_lesen(conn)

        treffer = re.match(r"^/(rechnung|angebot|storno)/(\d+)\.html$", pfad)
        if treffer:
            akte = vg.rechnung_akte(conn, int(treffer.group(2)))
            html = rg.seite(akte["rechnung"], akte["posten"], akte["kunde"], e, akte["auftrag"])
            return html.encode("utf-8"), "text/html; charset=utf-8", None

        treffer = re.match(r"^/rechnung/(\d+)\.xml$", pfad)
        if treffer:
            akte = vg.rechnung_akte(conn, int(treffer.group(1)))
            xml = rg.xrechnung(akte["rechnung"], akte["posten"], akte["kunde"], e)
            name = "XRechnung-%s.xml" % (akte["rechnung"].get("nummer") or "entwurf")
            return xml.encode("utf-8"), "application/xml; charset=utf-8", name

        treffer = re.match(r"^/mahnung/(\d+)\.html$", pfad)
        if treffer:
            akte = vg.rechnung_akte(conn, int(treffer.group(1)))
            stufe = int((frage.get("stufe", ["1"]) or ["1"])[0])
            html = rg.mahnung_seite(akte["rechnung"], akte["kunde"], e, stufe)
            return html.encode("utf-8"), "text/html; charset=utf-8", None

        if pfad == "/kalender.ics":
            return kalender.ics(conn).encode("utf-8"), "text/calendar; charset=utf-8", "MeinOrbit.ics"

        treffer = re.match(r"^/ausgabe/(rechnungen|einnahmen|ausgaben|euer|kunden)\.csv$", pfad)
        if treffer:
            jahr = (frage.get("jahr", [str(date.today().year)]) or [""])[0]
            welche = treffer.group(1)
            text = {"rechnungen": lambda: finanzen.csv_rechnungen(conn, jahr),
                    "einnahmen": lambda: finanzen.csv_einnahmen(conn, jahr),
                    "ausgaben": lambda: finanzen.csv_ausgaben(conn, jahr),
                    "euer": lambda: finanzen.csv_euer(conn, jahr),
                    "kunden": lambda: finanzen.csv_kunden(conn)}[welche]()
            name = "%s-%s.csv" % (welche, jahr) if welche != "kunden" else "kunden.csv"
            return ("﻿" + text).encode("utf-8"), "text/csv; charset=utf-8", name

        if pfad == "/ausgabe/alles.json":
            text = json.dumps(db.alles_ausgeben(), ensure_ascii=False, indent=1)
            return text.encode("utf-8"), "application/json; charset=utf-8", \
                "meinorbit-%s.json" % date.today().isoformat()

        treffer = re.match(r"^/datei/(.+)$", pfad)
        if treffer:
            name = os.path.basename(unquote(treffer.group(1)))
            voll = os.path.join(db.DOKUMENTE, name)
            if os.path.isfile(voll):
                typ = mimetypes.guess_type(voll)[0] or "application/octet-stream"
                with open(voll, "rb") as f:
                    return f.read(), typ, None
        return None, None, None
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Der kleine Server
# --------------------------------------------------------------------------

class Bedienung(BaseHTTPRequestHandler):
    server_version = "MeinOrbit/1.0"

    def log_message(self, *_):
        pass

    # -- Antworten ---------------------------------------------------------
    def _senden(self, inhalt: bytes, typ: str, code: int = 200, dateiname: str = None,
                keks: str = None):
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(inhalt)))
        self.send_header("Cache-Control", "no-store")
        if keks:
            self.send_header("Set-Cookie", keks)
        if dateiname:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % dateiname)
        self.end_headers()
        try:
            self.wfile.write(inhalt)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, daten, code: int = 200, keks: str = None):
        self._senden(json.dumps(daten, ensure_ascii=False, default=str).encode("utf-8"),
                     "application/json; charset=utf-8", code, None, keks)

    def _fehler(self, text: str, code: int = 400):
        self._json({"fehler": text}, code)

    # -- Anfragen ----------------------------------------------------------
    def do_GET(self):
        self._bearbeiten("GET")

    def do_POST(self):
        self._bearbeiten("POST")

    def do_DELETE(self):
        self._bearbeiten("DELETE")

    # -- Passwortschutz ----------------------------------------------------
    KEKS = "orbit_schluessel"

    def _schluessel(self) -> str:
        """Holt den Sitzungsschluessel aus dem Keks des Fensters."""
        for stueck in (self.headers.get("Cookie") or "").split(";"):
            name, _, wert = stueck.strip().partition("=")
            if name == self.KEKS:
                return wert
        return ""

    def _keks(self, wert: str) -> str:
        # Ohne Verfallsdatum: der Schluessel gilt nur, solange das Fenster offen
        # ist. HttpOnly haelt ihn von jeder Skriptzeile im Browser fern.
        if not wert:
            return "%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict" % self.KEKS
        return "%s=%s; Path=/; HttpOnly; SameSite=Strict" % (self.KEKS, wert)

    def _sperre(self, teile: list, koerper: dict, methode: str):
        """Alles rund um das Passwort. Laeuft am Torwaechter vorbei."""
        offen = sperre.offen(self._schluessel())
        was = teile[2] if len(teile) > 2 else ""

        if was == "" and methode == "GET":
            antwort = {"aktiv": sperre.eingerichtet(), "offen": offen}
            if offen:
                antwort.update(sperre.regeln())
                antwort["datei"] = sperre.DATEI
            return self._json(antwort)

        if was == "oeffnen" and methode == "POST":
            schluessel = sperre.oeffnen(koerper.get("passwort") or "")
            return self._json({"ok": True, "offen": True}, 200, self._keks(schluessel))

        if was == "zu" and methode == "POST":
            sperre.schliessen(self._schluessel())
            return self._json({"ok": True, "offen": False}, 200, self._keks(""))

        # Alles Weitere aendert die Sperre selbst - das geht nur von innen.
        if sperre.eingerichtet() and not offen:
            raise sperre.Fehler("Dafür muss MeinOrbit erst aufgeschlossen sein.")

        if was == "setzen" and methode == "POST":
            frisch = koerper.get("neu") or ""
            if frisch != (koerper.get("wiederholung") or ""):
                raise sperre.Fehler("Die beiden Eingaben sind nicht gleich.")
            sperre.setzen(frisch, koerper.get("alt") or "")
            # Das Aendern wirft alle Fenster hinaus. Dieses hier darf bleiben.
            schluessel = sperre.oeffnen(frisch)
            return self._json({"ok": True}, 200, self._keks(schluessel))

        if was == "aus" and methode == "POST":
            sperre.entfernen(koerper.get("passwort") or "")
            return self._json({"ok": True}, 200, self._keks(""))

        if was == "regeln" and methode == "POST":
            sperre.regeln_aendern(koerper.get("minuten"), koerper.get("beim_oeffnen"))
            antwort = {"ok": True}
            antwort.update(sperre.regeln())
            return self._json(antwort)

        return self._fehler("Unbekannter Aufruf: /%s" % "/".join(teile), 404)

    def _gesperrt_melden(self, pfad: str):
        """Fuer Seiten ausserhalb der Oberflaeche: eine lesbare Notiz statt Technik."""
        if pfad.startswith("/api/"):
            return self._json({"fehler": "MeinOrbit ist gesperrt.", "gesperrt": True}, 423)
        seite = ("<!doctype html><html lang=de><meta charset=utf-8>"
                 "<title>MeinOrbit ist gesperrt</title>"
                 "<style>body{font-family:-apple-system,Segoe UI,sans-serif;"
                 "background:#f6f9fc;color:#0d253d;display:grid;place-items:center;"
                 "height:100vh;margin:0;text-align:center} a{color:#2563eb}</style>"
                 "<div><h1 style='font-weight:500'>MeinOrbit ist gesperrt</h1>"
                 "<p>Bitte im Hauptfenster das Passwort eingeben.</p>"
                 "<p><a href='/'>Zum Hauptfenster</a></p></div>")
        return self._senden(seite.encode("utf-8"), "text/html; charset=utf-8", 423)

    def _bearbeiten(self, methode: str):
        adresse = urlparse(self.path)
        pfad = unquote(adresse.path)
        frage = parse_qs(adresse.query)

        koerper = {}
        laenge = int(self.headers.get("Content-Length") or 0)
        if laenge:
            roh = self.rfile.read(laenge)
            try:
                koerper = json.loads(roh.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                koerper = {}

        try:
            if pfad in ("/", "/index.html"):
                # Wer "bei jedem Öffnen fragen" gewählt hat, bekommt beim
                # frischen Aufziehen des Fensters wieder den Sperrbildschirm -
                # nicht aber, wenn er gerade eben noch dran war.
                sperre.fenster_geoeffnet(self._schluessel())
                with open(OBERFLAECHE, "rb") as f:
                    return self._senden(f.read(), "text/html; charset=utf-8")

            teile = [x for x in pfad.strip("/").split("/") if x]
            if teile[:2] == ["api", "sperre"]:
                return self._sperre(teile, koerper, methode)

            # Der Torwaechter: ohne Anmeldung geht nichts heraus.
            if not sperre.offen(self._schluessel()):
                return self._gesperrt_melden(pfad)

            if pfad.startswith("/api/"):
                daten, _, _ = endpunkt(pfad, frage, koerper, methode)
                if daten is None:
                    return self._fehler("Unbekannter Aufruf: %s" % pfad, 404)
                return self._json(daten)

            inhalt, typ, dateiname = seiten(pfad, frage)
            if inhalt is None:
                return self._fehler("Nicht gefunden: %s" % pfad, 404)
            return self._senden(inhalt, typ, 200, dateiname)

        except (vg.Fehler, sperre.Fehler) as f:
            return self._fehler(str(f), 400)
        except Exception as f:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            return self._fehler("Da ist etwas schiefgelaufen: %s" % f, 500)


def _antwortet(port: int) -> bool:
    """Wahr, wenn auf dem Port schon jemand lauscht."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _freier_port(start: int) -> int:
    import socket
    for versatz in range(30):
        p = start + versatz
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def _adresse_merken(adresse: str) -> None:
    """Legt die laufende Adresse in den Datenordner.

    Der Starter (Symbol auf dem Mac, Startdatei unter Windows) liest sie und
    findet das Fenster auch dann, wenn Port 8768 auf dem Rechner belegt war und
    MeinOrbit auf einen anderen ausgewichen ist.
    """
    try:
        os.makedirs(db.DATEN, exist_ok=True)
        with open(os.path.join(db.DATEN, "adresse.txt"), "w", encoding="utf-8") as f:
            f.write(adresse)
    except OSError:
        pass


def starten(oeffnen: bool = True, fester_port: bool = False) -> None:
    if fester_port:
        # Der Hintergrunddienst besteht auf Port 8768, damit das Symbol im Dock
        # immer die gleiche Adresse findet. Laeuft dort schon ein zweiter Start,
        # wird gewartet statt abgebrochen.
        gemeldet = False
        while _antwortet(PORT):
            if not gemeldet:
                print("Port %d ist belegt, warte." % PORT, flush=True)
                gemeldet = True
            time.sleep(3)
    db.vorbereiten()
    conn = db.verbindung()
    e = db.einstellungen_lesen(conn)
    conn.close()
    if e.get("sicherung_automatisch") == "ja":
        try:
            db.sicherung_anlegen(int(e.get("sicherung_anzahl") or 30))
        except Exception:
            pass

    port = PORT if fester_port else _freier_port(PORT)
    server = ThreadingHTTPServer(("127.0.0.1", port), Bedienung)
    adresse = "http://127.0.0.1:%d/" % port
    _adresse_merken(adresse)

    print("MeinOrbit läuft.")
    print("  Oberfläche: %s" % adresse)
    print("  Daten:      %s" % db.DATEN)
    print("  Zum Beenden dieses Fenster schließen oder Strg+C drücken.")

    if oeffnen:
        threading.Thread(target=lambda: (time.sleep(0.6), webbrowser.open(adresse)),
                         daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")
        server.server_close()


if __name__ == "__main__":
    _hintergrund = "--hintergrund" in sys.argv
    starten(oeffnen=not _hintergrund and "--kein-browser" not in sys.argv,
            fester_port=_hintergrund)
