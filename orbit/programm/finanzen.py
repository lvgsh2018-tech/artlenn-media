#!/usr/bin/env python3
"""Auswertungen: Geldeingang, Einnahmen-Ueberschuss-Rechnung, Steuerruecklage,
Umsatzstatistiken und Ausgaben fuer den Steuerberater."""

from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta

import datenbank as db
from rechnung import geld, kundenname

MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
          "September", "Oktober", "November", "Dezember"]


def _jahr(wert) -> int:
    try:
        return int(wert)
    except (TypeError, ValueError):
        return date.today().year


def _summe(werte) -> float:
    return round(sum(float(w or 0) for w in werte), 2)


# --------------------------------------------------------------------------
# Geldeingang
# --------------------------------------------------------------------------

def offene_posten(conn) -> list:
    """Alle gestellten, noch nicht bezahlten Rechnungen - mit Faelligkeit."""
    heute = date.today().isoformat()
    posten = db.zeilen(conn, """
        SELECT r.*, k.nummer AS kundennummer, k.firma, k.vorname, k.nachname, k.art
        FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
        WHERE r.typ IN ('rechnung', 'storno') AND r.status = 'offen'
        ORDER BY r.faellig_am""")
    for p in posten:
        p["kunde"] = kundenname(p)
        # Eine Korrektur ist Geld, das zurueckgeht - deshalb mit Minus
        p["vorzeichen"] = -1 if p["typ"] == "storno" else 1
        p["betrag"] = round(float(p.get("brutto") or 0) * p["vorzeichen"], 2)
        p["ueberfaellig"] = bool(p.get("faellig_am") and p["faellig_am"] < heute)
        try:
            f = datetime.strptime((p.get("faellig_am") or "")[:10], "%Y-%m-%d").date()
            p["tage"] = (f - date.today()).days
        except ValueError:
            p["tage"] = None
    return posten


def erwarteter_eingang(conn) -> dict:
    """Was voraussichtlich noch hereinkommt - gestellt, laufend, angeboten."""
    alle_offen = offene_posten(conn)
    gestellt = _summe(p["betrag"] for p in alle_offen)
    ueberfaellig = _summe(p["betrag"] for p in alle_offen
                          if p["ueberfaellig"] and p["typ"] == "rechnung")
    erstattung = _summe(-p["betrag"] for p in alle_offen if p["typ"] == "storno")

    laufend = 0.0
    for a in db.zeilen(conn, """SELECT id FROM auftraege
                                WHERE status IN ('planung','bearbeitung','fertig')"""):
        laufend += _summe(
            float(p["menge"] or 0) * float(p["einzelpreis"] or 0)
            for p in db.zeilen(conn, "SELECT menge, einzelpreis FROM auftragsposten WHERE auftrag_id=?",
                               (a["id"],)))
    angeboten = _summe(r["brutto"] for r in db.zeilen(
        conn, "SELECT brutto FROM rechnungen WHERE typ='angebot' AND status IN ('offen','entwurf')"))
    return {"gestellt": round(gestellt, 2), "ueberfaellig": round(ueberfaellig, 2),
            "laufend": round(laufend, 2), "angeboten": round(angeboten, 2),
            "erstattung": round(erstattung, 2),
            "gesamt": round(gestellt + laufend, 2)}


# --------------------------------------------------------------------------
# Geld, das ohne Rechnung hereinkommt
# --------------------------------------------------------------------------

ZAHLUNGSARTEN = {"bar": "Bar", "karte": "Karte", "ueberweisung": "Überweisung",
                 "sonstiges": "Sonstiges"}


def direkte_einnahmen(conn, von: str = "", bis: str = "") -> list:
    """Geldeingaenge ausserhalb der Auftraege - Selbstbedienungsladen, Barverkauf."""
    sql = """SELECT e.*, k.nummer AS kundennummer, k.firma, k.vorname, k.nachname, k.art
             FROM einnahmen e LEFT JOIN kunden k ON k.id = e.kunde_id"""
    werte = []
    if von and bis:
        sql += " WHERE e.datum BETWEEN ? AND ?"
        werte = [von, bis]
    liste = db.zeilen(conn, sql + " ORDER BY e.datum DESC, e.id DESC", werte)
    for x in liste:
        x["kunde"] = kundenname(x) if x.get("kunde_id") else ""
        x["zahlungsart_name"] = ZAHLUNGSARTEN.get(x.get("zahlungsart") or "", "Sonstiges")
    return liste


# --------------------------------------------------------------------------
# Einnahmen-Ueberschuss-Rechnung
# --------------------------------------------------------------------------

def euer(conn, jahr) -> dict:
    """EUER nach dem Zufluss-Abfluss-Prinzip: es zaehlt, wann Geld floss."""
    jahr = _jahr(jahr)
    von, bis = "%d-01-01" % jahr, "%d-12-31" % jahr

    # Gezaehlt wird, wann das Geld floss. Eine Korrektur zaehlt negativ, sobald
    # sie erstattet wurde - so bleibt ein abgeschlossenes Jahr unangetastet.
    einnahmen = db.zeilen(conn, """
        SELECT r.id, r.nummer, r.bezahlt_am, r.brutto, r.netto, r.steuer, r.typ,
               k.firma, k.vorname, k.nachname, k.art
        FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
        WHERE r.typ IN ('rechnung', 'storno') AND r.festgeschrieben = 1
          AND r.bezahlt_am BETWEEN ? AND ?
        ORDER BY r.bezahlt_am""", (von, bis))
    for e_ in einnahmen:
        e_["betrag"] = round(float(e_.get("brutto") or 0) * (-1 if e_["typ"] == "storno" else 1), 2)
    rechnungs_summe = _summe(e_["betrag"] for e_ in einnahmen)

    # Geld ohne Rechnung - Selbstbedienungsladen, Barverkauf. Zaehlt am Tag,
    # an dem es hereinkam, genau wie eine bezahlte Rechnung.
    direkte = direkte_einnahmen(conn, von, bis)
    direkt_summe = _summe(x["betrag"] for x in direkte)
    einnahme_summe = round(rechnungs_summe + direkt_summe, 2)

    belege = db.zeilen(conn, """
        SELECT b.*, k.firma, k.vorname, k.nachname, k.art
        FROM belege b LEFT JOIN kunden k ON k.id = b.kunde_id
        WHERE b.datum BETWEEN ? AND ? ORDER BY b.datum""", (von, bis))
    ausgaben = db.zeilen(conn, "SELECT * FROM ausgaben WHERE datum BETWEEN ? AND ? ORDER BY datum",
                         (von, bis))
    ausgabe_summe = _summe([b["betrag"] for b in belege] + [a["betrag"] for a in ausgaben])

    nach_kategorie = {}
    for p in belege + ausgaben:
        schluessel = p.get("kategorie") or "Sonstiges"
        nach_kategorie[schluessel] = round(nach_kategorie.get(schluessel, 0.0)
                                           + float(p.get("betrag") or 0), 2)

    gewinn = round(einnahme_summe - ausgabe_summe, 2)
    e = db.einstellungen_lesen(conn)
    satz = float(e.get("steuerruecklage") or 0)
    return {
        "jahr": jahr,
        "einnahmen": einnahme_summe,
        "ausgaben": ausgabe_summe,
        "gewinn": gewinn,
        "ruecklage_satz": satz,
        "ruecklage": round(max(0.0, gewinn) * satz / 100.0, 2),
        "kategorien": sorted(({"name": k, "betrag": v} for k, v in nach_kategorie.items()),
                             key=lambda x: -x["betrag"]),
        "einnahmen_rechnungen": rechnungs_summe,
        "einnahmen_direkt": direkt_summe,
        "direkte_liste": direkte,
        "einnahmen_liste": [dict(x, kunde=kundenname(x), quelle="Rechnung") for x in einnahmen]
                           + [dict(x, quelle="Direkt", bezahlt_am=x.get("datum") or "",
                                   nummer=x.get("beleg_nummer") or "") for x in direkte],
        "ausgaben_liste": [dict(b, quelle="Beleg", kunde=kundenname(b)) for b in belege]
                          + [dict(a, quelle="Betriebsausgabe", kunde="") for a in ausgaben],
    }


def steuerruecklage(conn, jahr) -> dict:
    """Wie viel vom bereits eingegangenen Geld zurueckgelegt werden sollte."""
    z = euer(conn, jahr)
    e = db.einstellungen_lesen(conn)
    offen = erwarteter_eingang(conn)
    satz = float(e.get("steuerruecklage") or 0)
    return {
        "satz": satz,
        "bisher": z["ruecklage"],
        "gewinn": z["gewinn"],
        "hochrechnung": round(max(0.0, z["gewinn"] + offen["gestellt"]) * satz / 100.0, 2),
        "hinweis": ("Empfehlung, kein Steuerbescheid. Der Satz lässt sich in den "
                    "Einstellungen ändern."),
    }


# --------------------------------------------------------------------------
# Statistiken
# --------------------------------------------------------------------------

def statistik(conn, jahr) -> dict:
    jahr = _jahr(jahr)

    GEFLOSSEN = ("""SELECT bezahlt_am, brutto, typ FROM rechnungen
                    WHERE typ IN ('rechnung','storno') AND festgeschrieben=1
                      AND bezahlt_am != ''""")

    def direkt_jahr(j):
        return _summe(x["betrag"] for x in db.zeilen(
            conn, "SELECT betrag FROM einnahmen WHERE datum BETWEEN ? AND ?",
            ("%d-01-01" % j, "%d-12-31" % j)))

    def umsatz_jahr(j):
        aus_rechnungen = _summe(
            float(r["brutto"] or 0) * (-1 if r["typ"] == "storno" else 1)
            for r in db.zeilen(conn, GEFLOSSEN + " AND bezahlt_am BETWEEN ? AND ?",
                               ("%d-01-01" % j, "%d-12-31" % j)))
        return round(aus_rechnungen + direkt_jahr(j), 2)

    monate = [0.0] * 12
    vorjahr_monate = [0.0] * 12

    def eintragen(stempel: str, wert: float) -> None:
        if len(stempel) != 7:
            return
        j, m = int(stempel[:4]), int(stempel[5:7])
        if j == jahr:
            monate[m - 1] = round(monate[m - 1] + wert, 2)
        elif j == jahr - 1:
            vorjahr_monate[m - 1] = round(vorjahr_monate[m - 1] + wert, 2)

    for r in db.zeilen(conn, GEFLOSSEN):
        eintragen((r["bezahlt_am"] or "")[:7],
                  float(r["brutto"] or 0) * (-1 if r["typ"] == "storno" else 1))
    # Geld ohne Rechnung zaehlt im Verlauf genauso mit
    for x in db.zeilen(conn, "SELECT datum, betrag FROM einnahmen WHERE datum != ''"):
        eintragen((x["datum"] or "")[:7], float(x["betrag"] or 0))

    nach_kunde = db.zeilen(conn, """
        SELECT k.id, k.nummer, k.art, k.firma, k.vorname, k.nachname,
               ROUND(SUM(r.brutto), 2) AS umsatz, COUNT(*) AS anzahl
        FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
        WHERE r.typ='rechnung' AND r.festgeschrieben=1
          AND r.bezahlt_am BETWEEN ? AND ?
        GROUP BY k.id ORDER BY umsatz DESC""", ("%d-01-01" % jahr, "%d-12-31" % jahr))
    for k in nach_kunde:
        k["kunde"] = kundenname(k)

    nach_leistung = db.zeilen(conn, """
        SELECT p.bezeichnung AS name,
               ROUND(SUM(p.menge * p.einzelpreis), 2) AS umsatz,
               ROUND(SUM(p.menge), 2) AS menge
        FROM rechnungsposten p JOIN rechnungen r ON r.id = p.rechnung_id
        WHERE r.typ='rechnung' AND r.festgeschrieben=1
          AND r.bezahlt_am BETWEEN ? AND ?
        GROUP BY p.bezeichnung ORDER BY umsatz DESC LIMIT 15""",
        ("%d-01-01" % jahr, "%d-12-31" % jahr))

    dieses = umsatz_jahr(jahr)
    letztes = umsatz_jahr(jahr - 1)
    # Fuer Anzahl, Schnitt und Zahlungsdauer zaehlen nur Rechnungen, die auch
    # Bestand haben - eine stornierte Rechnung wuerde den Schnitt verzerren.
    bezahlte = db.zeilen(conn, """SELECT datum, bezahlt_am, brutto FROM rechnungen
                                  WHERE typ='rechnung' AND festgeschrieben=1
                                  AND status != 'storniert'
                                  AND bezahlt_am BETWEEN ? AND ?""",
                         ("%d-01-01" % jahr, "%d-12-31" % jahr))
    summe_bestand = _summe(r["brutto"] for r in bezahlte)
    tage = []
    for r in bezahlte:
        try:
            d1 = datetime.strptime((r["datum"] or "")[:10], "%Y-%m-%d").date()
            d2 = datetime.strptime((r["bezahlt_am"] or "")[:10], "%Y-%m-%d").date()
            tage.append((d2 - d1).days)
        except ValueError:
            pass

    return {
        "jahr": jahr,
        "monate": [{"name": MONATE[i], "kurz": MONATE[i][:3], "wert": monate[i],
                    "vorjahr": vorjahr_monate[i]} for i in range(12)],
        "umsatz": dieses,
        "vorjahr": letztes,
        "veraenderung": round((dieses - letztes) / letztes * 100, 1) if letztes else None,
        "kunden": nach_kunde,
        "leistungen": nach_leistung,
        "direkt": direkt_jahr(jahr),
        "anzahl_rechnungen": len(bezahlte),
        "schnitt_rechnung": round(summe_bestand / len(bezahlte), 2) if bezahlte else 0.0,
        "zahlungsdauer": round(sum(tage) / len(tage), 1) if tage else None,
    }


def jahre(conn) -> list:
    gefunden = set()
    for r in db.zeilen(conn, "SELECT datum, bezahlt_am FROM rechnungen"):  # noqa
        for wert in (r["datum"], r["bezahlt_am"]):
            if wert and len(wert) >= 4 and wert[:4].isdigit():
                gefunden.add(int(wert[:4]))
    for r in db.zeilen(conn, "SELECT datum FROM einnahmen"):
        wert = r["datum"] or ""
        if len(wert) >= 4 and wert[:4].isdigit():
            gefunden.add(int(wert[:4]))
    gefunden.add(date.today().year)
    return sorted(gefunden, reverse=True)


# --------------------------------------------------------------------------
# Ausgaben fuer den Steuerberater
# --------------------------------------------------------------------------

def _csv(kopf: list, reihen: list) -> str:
    puffer = io.StringIO()
    schreiber = csv.writer(puffer, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    schreiber.writerow(kopf)
    for r in reihen:
        schreiber.writerow(r)
    return puffer.getvalue()


def csv_rechnungen(conn, jahr) -> str:
    jahr = _jahr(jahr)
    reihen = []
    for r in db.zeilen(conn, """
            SELECT r.*, k.nummer AS kdnr, k.firma, k.vorname, k.nachname, k.art
            FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
            WHERE r.datum BETWEEN ? AND ? AND r.typ IN ('rechnung','storno')
            ORDER BY r.datum, r.nummer""", ("%d-01-01" % jahr, "%d-12-31" % jahr)):
        reihen.append([r["nummer"], r["typ"], r["datum"], r["leistungsdatum"], r["kdnr"],
                       kundenname(r), ("%.2f" % (r["netto"] or 0)).replace(".", ","),
                       ("%.2f" % (r["steuer"] or 0)).replace(".", ","),
                       ("%.2f" % (r["brutto"] or 0)).replace(".", ","),
                       r["status"], r["bezahlt_am"]])
    return _csv(["Rechnungsnummer", "Art", "Datum", "Leistungsdatum", "Kundennummer", "Kunde",
                 "Netto", "Steuer", "Brutto", "Status", "Bezahlt am"], reihen)


def csv_einnahmen(conn, jahr) -> str:
    """Alle Geldeingaenge des Jahres - aus Rechnungen und ohne Rechnung."""
    jahr = _jahr(jahr)
    von, bis = "%d-01-01" % jahr, "%d-12-31" % jahr
    reihen = []
    for r in db.zeilen(conn, """
            SELECT r.nummer, r.typ, r.bezahlt_am, r.brutto,
                   k.nummer AS kdnr, k.firma, k.vorname, k.nachname, k.art
            FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
            WHERE r.typ IN ('rechnung','storno') AND r.festgeschrieben = 1
              AND r.bezahlt_am BETWEEN ? AND ?""", (von, bis)):
        betrag = float(r["brutto"] or 0) * (-1 if r["typ"] == "storno" else 1)
        reihen.append([r["bezahlt_am"], "Rechnung", r["nummer"], "", "",
                       kundenname(r), ("%.2f" % betrag).replace(".", ","), ""])
    for x in direkte_einnahmen(conn, von, bis):
        reihen.append([x["datum"], "Direkt", x.get("beleg_nummer") or "",
                       x.get("kategorie") or "", x.get("zahlungsart_name") or "",
                       x.get("kunde") or "", ("%.2f" % float(x["betrag"] or 0)).replace(".", ","),
                       x.get("beschreibung") or ""])
    reihen.sort(key=lambda r: r[0] or "")
    return _csv(["Datum", "Herkunft", "Nummer", "Kategorie", "Zahlungsart", "Kunde", "Betrag",
                 "Beschreibung"], reihen)


def csv_ausgaben(conn, jahr) -> str:
    jahr = _jahr(jahr)
    von, bis = "%d-01-01" % jahr, "%d-12-31" % jahr
    reihen = []
    for b in db.zeilen(conn, """SELECT b.*, k.nummer AS kdnr FROM belege b
                                LEFT JOIN kunden k ON k.id=b.kunde_id
                                WHERE b.datum BETWEEN ? AND ? ORDER BY b.datum""", (von, bis)):
        reihen.append([b["datum"], "Beleg", b["kategorie"], b["beschreibung"],
                       ("%.2f" % (b["betrag"] or 0)).replace(".", ","), b["kdnr"] or "",
                       b["dateiname"] or ""])
    for a in db.zeilen(conn, "SELECT * FROM ausgaben WHERE datum BETWEEN ? AND ? ORDER BY datum",
                       (von, bis)):
        reihen.append([a["datum"], "Betriebsausgabe", a["kategorie"], a["beschreibung"],
                       ("%.2f" % (a["betrag"] or 0)).replace(".", ","), "", a["dateiname"] or ""])
    reihen.sort(key=lambda r: r[0] or "")
    return _csv(["Datum", "Art", "Kategorie", "Beschreibung", "Betrag", "Kundennummer", "Datei"],
                reihen)


def csv_euer(conn, jahr) -> str:
    z = euer(conn, jahr)
    reihen = [["Einnahmen (Zufluss)", ("%.2f" % z["einnahmen"]).replace(".", ",")],
              ["davon aus Rechnungen", ("%.2f" % z["einnahmen_rechnungen"]).replace(".", ",")],
              ["davon ohne Rechnung (bar, Selbstbedienung)",
               ("%.2f" % z["einnahmen_direkt"]).replace(".", ",")],
              ["Ausgaben (Abfluss)", ("%.2f" % z["ausgaben"]).replace(".", ",")],
              ["Gewinn", ("%.2f" % z["gewinn"]).replace(".", ",")],
              ["", ""], ["Ausgaben nach Kategorie", ""]]
    for k in z["kategorien"]:
        reihen.append([k["name"], ("%.2f" % k["betrag"]).replace(".", ",")])
    return _csv(["Position", "Betrag in Euro"], reihen)


def csv_kunden(conn) -> str:
    reihen = []
    for k in db.zeilen(conn, "SELECT * FROM kunden ORDER BY nummer"):
        reihen.append([k["nummer"], k["art"], k["firma"], k["vorname"], k["nachname"],
                       k["strasse"], k["plz"], k["ort"], k["telefon"], k["email"], k["tags"]])
    return _csv(["Kundennummer", "Art", "Firma", "Vorname", "Nachname", "Straße", "PLZ",
                 "Ort", "Telefon", "E-Mail", "Merkmale"], reihen)
