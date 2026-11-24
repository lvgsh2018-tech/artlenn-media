#!/usr/bin/env python3
"""Auswertungen: Geldeingang, Einnahmen-Ueberschuss-Rechnung, Steuerruecklage,
Umsatzstatistiken und Ausgaben fuer den Steuerberater."""

from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta

import datenbank as db
from rechnung import geld, kundenname, summen

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

    # Umsatzsteuer steckt in den Bruttobetraegen. Fuer die Anlage EUER wird sie
    # getrennt ausgewiesen; zurueckgelegt wird die noch nicht gezahlte voll.
    ust = _euer_umsatzsteuer(conn, einnahmen, direkte, belege, ausgaben)
    ust_offen = ust_offen_betrag(conn)
    ruecklage = round(max(0.0, gewinn - ust_offen) * satz / 100.0 + ust_offen, 2)
    return {
        "ust": ust,
        "ust_offen": ust_offen,
        "jahr": jahr,
        "einnahmen": einnahme_summe,
        "ausgaben": ausgabe_summe,
        "gewinn": gewinn,
        "ruecklage_satz": satz,
        "ruecklage": ruecklage,
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
        "ust_offen": z["ust_offen"],
        "gewinn": z["gewinn"],
        "hochrechnung": round(max(0.0, z["gewinn"] - z["ust_offen"] + offen["gestellt"])
                              * satz / 100.0 + z["ust_offen"], 2),
        "hinweis": ("Empfehlung, kein Steuerbescheid. Der Satz lässt sich in den "
                    "Einstellungen ändern."),
    }


# --------------------------------------------------------------------------
# Umsatzsteuer: Voranmeldungen und Jahreswerte zum Abtippen in ELSTER
# --------------------------------------------------------------------------
# Rechnungen zaehlen nach Zahlungseingang (Ist-Versteuerung), Vorsteuer nach
# dem Datum der Ausgabe. Allgemeine Rechenhilfe, keine Steuerberatung.

KATEGORIE_UST_ZAHLUNG = "Umsatzsteuer an Finanzamt"
KATEGORIE_UST_ERSTATTUNG = "Umsatzsteuer-Erstattung"


def _anteil(brutto, satz) -> float:
    """Steuer, die in einem Bruttobetrag steckt."""
    brutto, satz = float(brutto or 0), float(satz or 0)
    if satz <= 0:
        return 0.0
    return round(brutto - brutto / (1 + satz / 100.0), 2)


def _monatsende(jahr: int, monat: int) -> date:
    if monat == 12:
        return date(jahr, 12, 31)
    return date(jahr, monat + 1, 1) - timedelta(days=1)


def _frist(bis: date, dauerfrist: bool) -> date:
    """Der 10. des Folgemonats, mit Dauerfristverlaengerung einen Monat spaeter."""
    monat, jahr = bis.month + (2 if dauerfrist else 1), bis.year
    while monat > 12:
        monat, jahr = monat - 12, jahr + 1
    return date(jahr, monat, 10)


def ust_zeitraeume(e: dict, jahr: int) -> list:
    vierteljahr = (e.get("ust_rhythmus") or "monatlich") == "vierteljaehrlich"
    dauer = (e.get("ust_dauerfrist") or "nein") == "ja"
    liste = []
    if vierteljahr:
        for q in range(1, 5):
            von, bis = date(jahr, 3 * q - 2, 1), _monatsende(jahr, 3 * q)
            liste.append({"zeitraum": "%d-Q%d" % (jahr, q), "name": "%d. Quartal %d" % (q, jahr),
                          "von": von.isoformat(), "bis": bis.isoformat(),
                          "frist": _frist(bis, dauer).isoformat()})
    else:
        for m in range(1, 13):
            von, bis = date(jahr, m, 1), _monatsende(jahr, m)
            liste.append({"zeitraum": "%d-%02d" % (jahr, m), "name": "%s %d" % (MONATE[m - 1], jahr),
                          "von": von.isoformat(), "bis": bis.isoformat(),
                          "frist": _frist(bis, dauer).isoformat()})
    return liste


def ust_werte(conn, von: str, bis: str) -> dict:
    """Alle Kennzahlen der Umsatzsteuer-Voranmeldung fuer einen Zeitraum."""
    grundlage = {}          # Satz -> Nettobetrag der Umsaetze
    posten_liste = []
    for r in db.zeilen(conn, """
            SELECT r.id, r.nummer, r.typ, r.bezahlt_am, r.netto, r.steuer, r.brutto,
                   k.firma, k.vorname, k.nachname, k.art
            FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
            WHERE r.typ IN ('rechnung','storno') AND r.festgeschrieben = 1
              AND r.bezahlt_am BETWEEN ? AND ?""", (von, bis)):
        vz = -1 if r["typ"] == "storno" else 1
        s = summen(db.zeilen(conn, "SELECT menge, einzelpreis, steuersatz FROM rechnungsposten "
                                   "WHERE rechnung_id=?", (r["id"],)))
        for z in s["steuerzeilen"]:
            grundlage[z["satz"]] = round(grundlage.get(z["satz"], 0.0) + vz * z["grundlage"], 2)
        posten_liste.append({"art": "Rechnung", "datum": r["bezahlt_am"], "nummer": r["nummer"],
                             "text": kundenname(r), "netto": round(vz * float(r["netto"] or 0), 2),
                             "steuer": round(vz * float(r["steuer"] or 0), 2)})
    for x in db.zeilen(conn, "SELECT * FROM einnahmen WHERE datum BETWEEN ? AND ? "
                             "AND COALESCE(steuersatz,0) > 0", (von, bis)):
        st = _anteil(x["betrag"], x["steuersatz"])
        netto = round(float(x["betrag"] or 0) - st, 2)
        satz = float(x["steuersatz"])
        grundlage[satz] = round(grundlage.get(satz, 0.0) + netto, 2)
        posten_liste.append({"art": "Einnahme", "datum": x["datum"], "nummer": x.get("beleg_nummer") or "",
                             "text": x.get("beschreibung") or "", "netto": netto, "steuer": st})

    vorsteuer, ausland_netto, ausland_steuer = 0.0, 0.0, 0.0
    ausgaben_liste = []
    for tabelle in ("belege", "ausgaben"):
        for a in db.zeilen(conn, "SELECT * FROM %s WHERE datum BETWEEN ? AND ?" % tabelle, (von, bis)):
            if a.get("kategorie") == KATEGORIE_UST_ZAHLUNG:
                continue
            if a.get("ausland"):
                satz = float(a.get("steuersatz") or 0) or 19.0
                netto = float(a["betrag"] or 0)
                st = round(netto * satz / 100.0, 2)
                ausland_netto += netto
                ausland_steuer += st
                ausgaben_liste.append({"art": "Ausland", "datum": a["datum"], "text": a["beschreibung"],
                                       "netto": netto, "steuer": st})
            elif float(a.get("steuersatz") or 0) > 0:
                st = _anteil(a["betrag"], a["steuersatz"])
                vorsteuer += st
                ausgaben_liste.append({"art": "Vorsteuer", "datum": a["datum"], "text": a["beschreibung"],
                                       "netto": round(float(a["betrag"] or 0) - st, 2), "steuer": st})

    # ELSTER verlangt die Bemessungsgrundlagen in ganzen Euro (abgerundet) und
    # rechnet die Steuer darauf selbst aus.
    def euro(w):
        return int(w) if w >= 0 else -int(-w)
    kz81 = euro(grundlage.get(19.0, 0.0))
    kz86 = euro(grundlage.get(7.0, 0.0))
    andere = {k: v for k, v in grundlage.items() if k not in (19.0, 7.0) and abs(v) > 0.005}
    st81 = round(kz81 * 0.19, 2)
    st86 = round(kz86 * 0.07, 2)
    kz46 = euro(round(ausland_netto, 2))
    kz47 = round(ausland_steuer, 2)
    kz66 = round(vorsteuer, 2)
    kz67 = kz47
    kz83 = round(st81 + st86 + kz47 - kz66 - kz67, 2)
    return {"kz81": kz81, "st81": st81, "kz86": kz86, "st86": st86,
            "kz46": kz46, "kz47": kz47, "kz66": kz66, "kz67": kz67, "kz83": kz83,
            "andere_saetze": [{"satz": k, "grundlage": v} for k, v in andere.items()],
            "umsaetze": sorted(posten_liste, key=lambda x: x["datum"] or ""),
            "ausgaben": sorted(ausgaben_liste, key=lambda x: x["datum"] or ""),
            "leer": not posten_liste and not ausgaben_liste}


def _meldung(conn, zeitraum: str) -> dict:
    return db.zeile(conn, "SELECT * FROM ust_meldungen WHERE zeitraum=?", (zeitraum,)) or {}


def ust_offen_betrag(conn) -> float:
    """Umsatzsteuer, die schon eingenommen, aber noch nicht ans Finanzamt gezahlt ist."""
    e = db.einstellungen_lesen(conn)
    ab = e.get("ust_ab") or ""
    if not ab:
        return 0.0
    heute = date.today()
    offen = 0.0
    for jahr in range(int(ab[:4]), heute.year + 1):
        for z in ust_zeitraeume(e, jahr):
            if z["bis"] < ab or z["von"] > heute.isoformat():
                continue
            if _meldung(conn, z["zeitraum"]).get("bezahlt_am"):
                continue
            offen += ust_werte(conn, max(z["von"], ab), z["bis"])["kz83"]
    return round(max(0.0, offen), 2)


def umsatzsteuer(conn, jahr) -> dict:
    """Alles fuer die Seite Umsatzsteuer: Voranmeldungen eines Jahres und Jahreswerte."""
    jahr = _jahr(jahr)
    e = db.einstellungen_lesen(conn)
    ab = e.get("ust_ab") or ""
    pflichtig = e.get("kleinunternehmer") != "ja"
    heute = date.today().isoformat()
    meldungen = []
    if ab:
        for z in ust_zeitraeume(e, jahr):
            if z["bis"] < ab or z["von"] > heute:
                continue
            w = ust_werte(conn, max(z["von"], ab), z["bis"])
            m = _meldung(conn, z["zeitraum"])
            laeuft = z["bis"] >= heute
            z.update(w)
            z.update({"uebermittelt_am": m.get("uebermittelt_am") or "",
                      "bezahlt_am": m.get("bezahlt_am") or "",
                      "gezahlt": float(m.get("betrag") or 0),
                      "laeuft": laeuft,
                      "ueberfaellig": not laeuft and not m.get("uebermittelt_am") and z["frist"] < heute})
            meldungen.append(z)
    meldungen.reverse()

    jahr_von = max("%d-01-01" % jahr, ab) if ab else "%d-01-01" % jahr
    jw = ust_werte(conn, jahr_von, "%d-12-31" % jahr) if ab else None
    vorauszahlungen = round(sum(m["kz83"] for m in meldungen), 2)
    jm = _meldung(conn, str(jahr))
    naechste = None
    for m in sorted(meldungen, key=lambda x: x["frist"]):
        if not m["uebermittelt_am"] and not m["laeuft"]:
            naechste = m
            break
    return {"jahr": jahr, "pflichtig": pflichtig, "ab": ab,
            "rhythmus": e.get("ust_rhythmus") or "monatlich",
            "dauerfrist": (e.get("ust_dauerfrist") or "nein") == "ja",
            "meldungen": meldungen, "naechste": naechste,
            "jahreswerte": dict(jw, vorauszahlungen=vorauszahlungen,
                                abschluss=round(jw["kz83"] - vorauszahlungen, 2),
                                frist="%d-07-31" % (jahr + 1),
                                uebermittelt_am=jm.get("uebermittelt_am") or "",
                                bezahlt_am=jm.get("bezahlt_am") or "",
                                umsaetze=[], ausgaben=[]) if jw else None,
            "euer": euer(conn, jahr)["ust"]}


def ust_erinnerungen(conn) -> list:
    """Hinweise fuer die Startseite: Meldungen, die bald faellig oder ueberfaellig sind."""
    e = db.einstellungen_lesen(conn)
    if not e.get("ust_ab"):
        return []
    heute = date.today()
    hinweise = []
    for jahr in {heute.year - 1, heute.year}:
        for z in ust_zeitraeume(e, jahr):
            if z["bis"] < e["ust_ab"] or z["bis"] >= heute.isoformat():
                continue
            if _meldung(conn, z["zeitraum"]).get("uebermittelt_am"):
                continue
            tage = (date.fromisoformat(z["frist"]) - heute).days
            if tage < 0:
                hinweise.append({"art": "warnung", "text": "Umsatzsteuer-Voranmeldung %s war am %s fällig "
                                 "und ist noch nicht als übermittelt markiert."
                                 % (z["name"], date.fromisoformat(z["frist"]).strftime("%d.%m.%Y"))})
            elif tage <= 14:
                hinweise.append({"art": "hinweis", "text": "Umsatzsteuer-Voranmeldung %s bis %s an das "
                                 "Finanzamt übermitteln. Die Zahlen stehen unter Finanzen, Umsatzsteuer."
                                 % (z["name"], date.fromisoformat(z["frist"]).strftime("%d.%m.%Y"))})
    return hinweise


def ust_vermerken(conn, zeitraum: str, aktion: str, datum: str = "", betrag=None, name: str = "") -> None:
    """Uebermittelt / bezahlt markieren. Beim Bezahlen wird die Zahlung ans
    Finanzamt (oder die Erstattung) gleich als Ausgabe bzw. Einnahme gebucht,
    damit die Einnahmen-Ueberschuss-Rechnung stimmt."""
    tag = datum or date.today().isoformat()
    m = _meldung(conn, zeitraum)
    with conn:
        if not m:
            conn.execute("INSERT INTO ust_meldungen (zeitraum) VALUES (?)", (zeitraum,))
        if aktion == "uebermittelt":
            conn.execute("UPDATE ust_meldungen SET uebermittelt_am=? WHERE zeitraum=?", (tag, zeitraum))
        elif aktion == "bezahlt":
            betrag = round(float(betrag or 0), 2)
            _buchung_loeschen(conn, m.get("buchung") or "")
            buchung = ""
            if betrag > 0:
                cur = conn.execute("""INSERT INTO ausgaben (datum, beschreibung, kategorie, betrag,
                                      rhythmus, dateiname, steuersatz, ausland) VALUES (?,?,?,?,?,?,0,0)""",
                                   (tag, "Umsatzsteuer %s" % name, KATEGORIE_UST_ZAHLUNG, betrag, "", ""))
                buchung = "ausgaben:%d" % cur.lastrowid
            elif betrag < 0:
                nummer = db.naechste_nummer(conn, "E-{jahr}-{nummer}", 4, "beleg_nummer",
                                            "einnahmen", jahr=tag[:4])
                cur = conn.execute("""INSERT INTO einnahmen (datum, beschreibung, kategorie, betrag,
                                      zahlungsart, beleg_nummer, dateiname, angelegt_am, steuersatz)
                                      VALUES (?,?,?,?,?,?,?,?,0)""",
                                   (tag, "Umsatzsteuer %s" % name, KATEGORIE_UST_ERSTATTUNG, -betrag,
                                    "ueberweisung", nummer, "", datetime.now().isoformat(timespec="seconds")))
                buchung = "einnahmen:%d" % cur.lastrowid
            conn.execute("""UPDATE ust_meldungen SET bezahlt_am=?, betrag=?, buchung=?,
                            uebermittelt_am=CASE WHEN uebermittelt_am='' THEN ? ELSE uebermittelt_am END
                            WHERE zeitraum=?""", (tag, betrag, buchung, tag, zeitraum))
        elif aktion == "zuruecksetzen":
            _buchung_loeschen(conn, m.get("buchung") or "")
            conn.execute("DELETE FROM ust_meldungen WHERE zeitraum=?", (zeitraum,))
        db.protokollieren(conn, "Umsatzsteuer", aktion, "%s %s" % (name or zeitraum, tag))


def _buchung_loeschen(conn, buchung: str) -> None:
    if ":" in buchung:
        tabelle, nr = buchung.split(":", 1)
        if tabelle in ("ausgaben", "einnahmen"):
            conn.execute("DELETE FROM %s WHERE id=?" % tabelle, (int(nr),))


def _euer_umsatzsteuer(conn, einnahmen, direkte, belege, ausgaben) -> dict:
    """Die Umsatzsteuer-Zeilen der Anlage EUER."""
    vereinnahmt = 0.0
    for r in einnahmen:
        vereinnahmt += float(r.get("steuer") or 0) * (-1 if r["typ"] == "storno" else 1)
    erstattet = 0.0
    for x in direkte:
        if x.get("kategorie") == KATEGORIE_UST_ERSTATTUNG:
            erstattet += float(x["betrag"] or 0)
        else:
            vereinnahmt += _anteil(x["betrag"], x.get("steuersatz"))
    vorsteuer, an_finanzamt = 0.0, 0.0
    for a in list(belege) + list(ausgaben):
        if a.get("kategorie") == KATEGORIE_UST_ZAHLUNG:
            an_finanzamt += float(a["betrag"] or 0)
        elif not a.get("ausland"):
            vorsteuer += _anteil(a["betrag"], a.get("steuersatz"))
    einnahmen_brutto = _summe([r["betrag"] for r in einnahmen] + [x["betrag"] for x in direkte])
    ausgaben_brutto = _summe([a["betrag"] for a in list(belege) + list(ausgaben)])
    return {"vereinnahmt": round(vereinnahmt, 2), "erstattet": round(erstattet, 2),
            "vorsteuer": round(vorsteuer, 2), "an_finanzamt": round(an_finanzamt, 2),
            "einnahmen_netto": round(einnahmen_brutto - vereinnahmt - erstattet, 2),
            "ausgaben_netto": round(ausgaben_brutto - vorsteuer - an_finanzamt, 2)}


def csv_umsatzsteuer(conn, jahr) -> str:
    u = umsatzsteuer(conn, jahr)
    k = lambda w: ("%.2f" % float(w or 0)).replace(".", ",")
    reihen = []
    for m in sorted(u["meldungen"], key=lambda x: x["von"]):
        reihen.append([m["name"], m["frist"], m["kz81"], k(m["st81"]), m["kz86"], k(m["st86"]),
                       m["kz46"], k(m["kz47"]), k(m["kz66"]), k(m["kz67"]), k(m["kz83"]),
                       m["uebermittelt_am"], m["bezahlt_am"]])
    return _csv(["Zeitraum", "Frist", "Kz 81 Umsatz 19 %", "Steuer 19 %", "Kz 86 Umsatz 7 %",
                 "Steuer 7 %", "Kz 46 Leistungen Ausland", "Kz 47 Steuer Ausland", "Kz 66 Vorsteuer",
                 "Kz 67 Vorsteuer Ausland", "Kz 83 Zahllast", "Übermittelt am", "Bezahlt am"], reihen)


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
                       ("%.2f" % (b["betrag"] or 0)).replace(".", ","), _ust_text(b),
                       ("%.2f" % _anteil(b["betrag"], 0 if b.get("ausland") else b.get("steuersatz"))
                        ).replace(".", ","), b["kdnr"] or "", b["dateiname"] or ""])
    for a in db.zeilen(conn, "SELECT * FROM ausgaben WHERE datum BETWEEN ? AND ? ORDER BY datum",
                       (von, bis)):
        reihen.append([a["datum"], "Betriebsausgabe", a["kategorie"], a["beschreibung"],
                       ("%.2f" % (a["betrag"] or 0)).replace(".", ","), _ust_text(a),
                       ("%.2f" % _anteil(a["betrag"], 0 if a.get("ausland") else a.get("steuersatz"))
                        ).replace(".", ","), "", a["dateiname"] or ""])
    reihen.sort(key=lambda r: r[0] or "")
    return _csv(["Datum", "Art", "Kategorie", "Beschreibung", "Betrag brutto", "Umsatzsteuer",
                 "darin Vorsteuer", "Kundennummer", "Datei"], reihen)


def _ust_text(a) -> str:
    if a.get("ausland"):
        return "Ausland (§ 13b)"
    satz = float(a.get("steuersatz") or 0)
    return ("%g %%" % satz).replace(".", ",") if satz else "keine"


def csv_euer(conn, jahr) -> str:
    z = euer(conn, jahr)
    reihen = [["Einnahmen (Zufluss)", ("%.2f" % z["einnahmen"]).replace(".", ",")],
              ["davon aus Rechnungen", ("%.2f" % z["einnahmen_rechnungen"]).replace(".", ",")],
              ["davon ohne Rechnung (bar, Selbstbedienung)",
               ("%.2f" % z["einnahmen_direkt"]).replace(".", ",")],
              ["Ausgaben (Abfluss)", ("%.2f" % z["ausgaben"]).replace(".", ",")],
              ["Gewinn", ("%.2f" % z["gewinn"]).replace(".", ",")],
              ["", ""],
              ["Einnahmen ohne Umsatzsteuer", ("%.2f" % z["ust"]["einnahmen_netto"]).replace(".", ",")],
              ["Vereinnahmte Umsatzsteuer", ("%.2f" % z["ust"]["vereinnahmt"]).replace(".", ",")],
              ["Vom Finanzamt erstattete Umsatzsteuer", ("%.2f" % z["ust"]["erstattet"]).replace(".", ",")],
              ["Ausgaben ohne Vorsteuer", ("%.2f" % z["ust"]["ausgaben_netto"]).replace(".", ",")],
              ["Gezahlte Vorsteuer", ("%.2f" % z["ust"]["vorsteuer"]).replace(".", ",")],
              ["An das Finanzamt gezahlte Umsatzsteuer", ("%.2f" % z["ust"]["an_finanzamt"]).replace(".", ",")],
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
