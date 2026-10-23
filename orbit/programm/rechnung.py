#!/usr/bin/env python3
"""Rechnungen, Angebote, Stornos und Mahnungen als druckfertige Seite.

Aus der Vorschau heraus druckt der Browser die Seite - oder sichert sie
als PDF. Zusaetzlich wird die E-Rechnung (XRechnung) als XML erzeugt.
"""

from __future__ import annotations

import html
import os
from datetime import date, datetime, timedelta

import qr

HIER = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# Rechnen
# --------------------------------------------------------------------------

def summen(posten: list) -> dict:
    """Netto, Steuer je Satz und Brutto aus den Positionen."""
    netto = 0.0
    nach_satz = {}
    for p in posten:
        menge = float(p.get("menge") or 0)
        preis = float(p.get("einzelpreis") or 0)
        satz = float(p.get("steuersatz") or 0)
        betrag = round(menge * preis, 2)
        netto += betrag
        nach_satz[satz] = round(nach_satz.get(satz, 0.0) + betrag, 2)
    steuer = 0.0
    steuerzeilen = []
    for satz in sorted(nach_satz):
        wert = round(nach_satz[satz] * satz / 100.0, 2)
        if satz > 0:
            steuerzeilen.append({"satz": satz, "grundlage": nach_satz[satz], "betrag": wert})
        steuer += wert
    netto = round(netto, 2)
    steuer = round(steuer, 2)
    return {"netto": netto, "steuer": steuer, "brutto": round(netto + steuer, 2),
            "steuerzeilen": steuerzeilen}


def geld(wert) -> str:
    """1234.5 -> '1.234,50'"""
    try:
        wert = float(wert or 0)
    except (TypeError, ValueError):
        wert = 0.0
    text = "%.2f" % abs(wert)
    ganz, komma = text.split(".")
    gruppen = []
    while len(ganz) > 3:
        gruppen.insert(0, ganz[-3:])
        ganz = ganz[:-3]
    gruppen.insert(0, ganz)
    return ("-" if wert < 0 else "") + ".".join(gruppen) + "," + komma


def menge_text(wert) -> str:
    try:
        wert = float(wert or 0)
    except (TypeError, ValueError):
        return "0"
    if abs(wert - round(wert)) < 0.0001:
        return str(int(round(wert)))
    return ("%.2f" % wert).replace(".", ",")


def datum_text(iso: str) -> str:
    if not iso:
        return ""
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%d.%m.%Y")
    except ValueError:
        return iso


def faelligkeit(datum_iso: str, tage: int) -> str:
    try:
        d = datetime.strptime((datum_iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        d = date.today()
    return (d + timedelta(days=int(tage or 0))).isoformat()


def kundenname(kunde: dict) -> str:
    if not kunde:
        return ""
    if kunde.get("art") in ("firma", "verein") and kunde.get("firma"):
        return kunde["firma"]
    name = " ".join(x for x in [kunde.get("vorname", ""), kunde.get("nachname", "")] if x).strip()
    return name or kunde.get("firma", "")


def anschrift_zeilen(kunde: dict) -> list:
    zeilen = []
    if kunde.get("firma"):
        zeilen.append(kunde["firma"])
    person = " ".join(x for x in [kunde.get("anrede", ""), kunde.get("vorname", ""),
                                  kunde.get("nachname", "")] if x).strip()
    if person:
        zeilen.append(person)
    if kunde.get("strasse"):
        zeilen.append(kunde["strasse"])
    ort = " ".join(x for x in [kunde.get("plz", ""), kunde.get("ort", "")] if x).strip()
    if ort:
        zeilen.append(ort)
    if kunde.get("land") and kunde.get("land") != "Deutschland":
        zeilen.append(kunde["land"])
    return zeilen


# --------------------------------------------------------------------------
# Die druckfertige Seite
# --------------------------------------------------------------------------

_TITEL = {"rechnung": "Rechnung", "angebot": "Angebot", "storno": "Rechnungskorrektur"}


def _stil(vorlage: str, akzent: str) -> str:
    """Drei Anmutungen - ruhig, klassisch, kompakt."""
    grundgroesse = {"klar": "10.5pt", "klassisch": "11pt", "kompakt": "9.5pt"}.get(vorlage, "10.5pt")
    kopfgroesse = {"klar": "26pt", "klassisch": "17pt", "kompakt": "16pt"}.get(vorlage, "26pt")
    kopfgewicht = {"klar": "300", "klassisch": "600", "kompakt": "600"}.get(vorlage, "300")
    zeilenabstand = {"klar": "1.55", "klassisch": "1.5", "kompakt": "1.35"}.get(vorlage, "1.55")
    seitenrand = {"klar": "20mm 18mm", "klassisch": "25mm 20mm", "kompakt": "14mm 14mm"}.get(
        vorlage, "20mm 18mm")
    akzentnutzung = akzent if vorlage == "klar" else "#0d253d"
    tabellenkopf = ("border-bottom:1.5px solid " + akzentnutzung) if vorlage == "klar" \
        else "border-top:1px solid #0d253d;border-bottom:1px solid #0d253d"
    return """
    :root {
      --ink:#0d253d; --ink-2:#273951; --mute:#64718a;
      --hair:#e3e8ee; --akzent:%(akzent)s; --canvas:#ffffff;
    }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; background:#eef1f5; }
    body {
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,Helvetica,Arial,sans-serif;
      font-size:%(grund)s; line-height:%(zeile)s; color:var(--ink);
      -webkit-font-smoothing:antialiased;
      font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1;
    }
    .blatt {
      width:210mm; min-height:297mm; margin:16px auto; padding:%(rand)s;
      background:var(--canvas); box-shadow:0 1px 3px rgba(13,37,61,.10),0 12px 32px rgba(13,37,61,.10);
      display:flex; flex-direction:column;
    }
    .kopf { display:flex; justify-content:space-between; align-items:flex-start; gap:16mm; }
    .logo img { max-height:22mm; max-width:70mm; display:block; }
    .absender-klein { font-size:7.5pt; color:var(--mute); letter-spacing:.01em; }
    .firma-block { text-align:right; font-size:9pt; color:var(--ink-2); line-height:1.45; white-space:pre-line; }
    .firma-block b { display:block; color:var(--ink); font-size:10.5pt; font-weight:600; margin-bottom:2px; }
    .anschrift { margin-top:14mm; min-height:28mm; }
    .anschrift .zeile { display:block; }
    .metablock { margin-top:2mm; display:flex; gap:10mm; flex-wrap:wrap; font-size:9pt; }
    .metablock div span { display:block; color:var(--mute); font-size:7.5pt;
      text-transform:uppercase; letter-spacing:.06em; margin-bottom:1px; }
    h1 { font-size:%(kopfgroesse)s; font-weight:%(kopfgewicht)s; letter-spacing:-0.02em;
      margin:10mm 0 1mm; color:var(--ink); }
    .untertitel { color:var(--mute); font-size:9.5pt; margin-bottom:6mm; }
    .kopftext { margin-bottom:6mm; white-space:pre-line; }
    table.posten { width:100%%; border-collapse:collapse; margin-bottom:6mm; }
    table.posten th { %(tabkopf)s; padding:2.5mm 2mm; font-size:8pt; font-weight:600;
      text-transform:uppercase; letter-spacing:.05em; color:var(--mute); text-align:left; }
    table.posten td { padding:2.8mm 2mm; border-bottom:1px solid var(--hair); vertical-align:top; }
    table.posten tr:last-child td { border-bottom:1px solid var(--hair); }
    .r { text-align:right; white-space:nowrap; }
    .z { text-align:center; }
    .pos-nr { color:var(--mute); width:8mm; }
    .pos-bez b { font-weight:500; }
    .pos-bez small { display:block; color:var(--mute); font-size:8.5pt; margin-top:.5mm; }
    .summen { margin-left:auto; width:78mm; }
    .summen div { display:flex; justify-content:space-between; padding:1.6mm 0; }
    .summen .zwischen { border-top:1px solid var(--hair); }
    .summen .gesamt { border-top:1.5px solid var(--ink); margin-top:1mm; padding-top:2.5mm;
      font-size:12.5pt; font-weight:600; }
    .summen .gesamt span:last-child { color:%(akzentnutz)s; }
    .hinweis { margin-top:7mm; padding:3mm 4mm; background:#f6f9fc;
      border-left:2px solid %(akzentnutz)s; font-size:9pt; color:var(--ink-2); border-radius:2px; }
    .zahlung { margin-top:8mm; display:flex; gap:8mm; align-items:flex-start;
      border-top:1px solid var(--hair); padding-top:5mm; }
    .zahlung .text { flex:1; font-size:9.5pt; }
    .zahlung .text b { font-weight:600; }
    .zahlung dl { margin:3mm 0 0; display:grid; grid-template-columns:auto 1fr;
      gap:1mm 4mm; font-size:9pt; }
    .zahlung dt { color:var(--mute); }
    .zahlung dd { margin:0; }
    .qr { text-align:center; font-size:7.5pt; color:var(--mute); }
    .qr svg { display:block; border:1px solid var(--hair); border-radius:3px; margin-bottom:1.5mm; }
    .fuss { margin-top:auto; padding-top:6mm; border-top:1px solid var(--hair);
      display:flex; gap:8mm; font-size:7.8pt; color:var(--mute); line-height:1.5; }
    .fuss > div { flex:1; white-space:pre-line; }
    .fusstext { margin-top:6mm; white-space:pre-line; font-size:9.5pt; }
    .werkzeugleiste { position:sticky; top:0; z-index:5; background:rgba(255,255,255,.92);
      backdrop-filter:saturate(180%%) blur(8px); border-bottom:1px solid var(--hair);
      padding:10px 16px; display:flex; gap:8px; align-items:center; }
    .werkzeugleiste b { flex:1; font-weight:600; font-size:13px; }
    .werkzeugleiste button, .werkzeugleiste a {
      font:inherit; font-size:13px; padding:7px 14px; border-radius:999px; cursor:pointer;
      border:1px solid var(--hair); background:#fff; color:var(--ink); text-decoration:none;
      transition:background .18s ease, border-color .18s ease; }
    .werkzeugleiste button:hover, .werkzeugleiste a:hover { background:#f6f9fc; border-color:#cfd8e3; }
    .werkzeugleiste .haupt { background:var(--akzent); border-color:var(--akzent); color:#fff; }
    .werkzeugleiste .haupt:hover { filter:brightness(.92); }
    .werkzeugleiste :focus-visible { outline:2px solid var(--akzent); outline-offset:2px; }
    .entwurf { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
      pointer-events:none; font-size:120pt; font-weight:700; color:rgba(13,37,61,.05);
      transform:rotate(-24deg); letter-spacing:.05em; }
    @media print {
      html,body { background:#fff; }
      .werkzeugleiste { display:none; }
      .blatt { margin:0; box-shadow:none; width:auto; min-height:0; padding:0; }
      @page { size:A4; margin:%(rand)s; }
    }
    """ % {"akzent": akzent, "grund": grundgroesse, "zeile": zeilenabstand, "rand": seitenrand,
           "kopfgroesse": kopfgroesse, "kopfgewicht": kopfgewicht, "tabkopf": tabellenkopf,
           "akzentnutz": akzentnutzung}


def seite(rechnung: dict, posten: list, kunde: dict, e: dict, auftrag: dict = None) -> str:
    """Baut die komplette druckbare Seite fuer Angebot, Rechnung oder Storno."""
    typ = rechnung.get("typ") or "rechnung"
    ist_storno = typ == "storno"
    ist_angebot = typ == "angebot"
    vorlage = rechnung.get("vorlage") or e.get("vorlage") or "klar"
    akzent = e.get("akzentfarbe") or "#2563eb"
    s = summen(posten)
    vorzeichen = -1 if ist_storno else 1
    q = html.escape

    # Kopf: Logo und Firmenangaben
    logo = '<div class="logo"></div>'
    if e.get("firma_logo"):
        logo = '<div class="logo"><img src="%s" alt="%s"></div>' % (
            q(e["firma_logo"]), q(e.get("firma_name", "Logo")))
    firmenzeilen = [x for x in [e.get("firma_strasse", ""),
                                " ".join(y for y in [e.get("firma_plz", ""), e.get("firma_ort", "")] if y).strip(),
                                e.get("firma_telefon", ""), e.get("firma_email", ""),
                                e.get("firma_web", "")] if x]
    firma_block = '<div class="firma-block"><b>%s</b>%s</div>' % (
        q(e.get("firma_name") or e.get("firma_inhaber") or ""), q("\n".join(firmenzeilen)))

    absender_klein = " · ".join(x for x in [
        e.get("firma_name", ""), e.get("firma_strasse", ""),
        " ".join(y for y in [e.get("firma_plz", ""), e.get("firma_ort", "")] if y).strip()] if x)

    anschrift = "".join('<span class="zeile">%s</span>' % q(z) for z in anschrift_zeilen(kunde))

    # Angaben rechts oben
    meta = [("Nummer", rechnung.get("nummer") or "Entwurf"),
            ("Datum", datum_text(rechnung.get("datum")))]
    if rechnung.get("leistungsdatum"):
        meta.append(("Leistungsdatum", datum_text(rechnung["leistungsdatum"])))
    meta.append(("Kundennummer", kunde.get("nummer", "")))
    if auftrag and auftrag.get("nummer"):
        meta.append(("Auftrag", auftrag["nummer"]))
    if not ist_angebot and rechnung.get("faellig_am"):
        meta.append(("Fällig am", datum_text(rechnung["faellig_am"])))
    meta_html = "".join('<div><span>%s</span>%s</div>' % (q(k), q(str(v))) for k, v in meta if v)

    # Positionen
    mit_steuer = bool(s["steuerzeilen"])
    kopfzeile = "<tr><th class='pos-nr'>Pos</th><th>Leistung</th><th class='r'>Menge</th>" \
                "<th>Einheit</th><th class='r'>Einzelpreis</th>"
    if mit_steuer:
        kopfzeile += "<th class='z'>USt</th>"
    kopfzeile += "<th class='r'>Betrag</th></tr>"

    reihen = []
    for i, p in enumerate(posten, 1):
        betrag = round(float(p.get("menge") or 0) * float(p.get("einzelpreis") or 0), 2) * vorzeichen
        bez = q(p.get("bezeichnung") or "")
        zusatz = p.get("beschreibung") or ""
        bez_html = "<b>%s</b>" % bez + ("<small>%s</small>" % q(zusatz) if zusatz else "")
        reihe = ("<tr><td class='pos-nr'>%d</td><td class='pos-bez'>%s</td>"
                 "<td class='r'>%s</td><td>%s</td><td class='r'>%s €</td>") % (
            i, bez_html, menge_text(p.get("menge")), q(p.get("einheit") or ""),
            geld(p.get("einzelpreis")))
        if mit_steuer:
            reihe += "<td class='z'>%s %%</td>" % menge_text(p.get("steuersatz"))
        reihe += "<td class='r'>%s €</td></tr>" % geld(betrag)
        reihen.append(reihe)

    # Summen
    summenzeilen = []
    if mit_steuer:
        summenzeilen.append('<div class="zwischen"><span>Zwischensumme netto</span>'
                            '<span>%s €</span></div>' % geld(s["netto"] * vorzeichen))
        for z in s["steuerzeilen"]:
            summenzeilen.append('<div><span>zzgl. %s %% USt auf %s €</span><span>%s €</span></div>'
                                % (menge_text(z["satz"]), geld(z["grundlage"] * vorzeichen),
                                   geld(z["betrag"] * vorzeichen)))
    beschriftung = "Angebotssumme" if ist_angebot else ("Gutschriftbetrag" if ist_storno else "Rechnungsbetrag")
    summenzeilen.append('<div class="gesamt"><span>%s</span><span>%s €</span></div>'
                        % (beschriftung, geld(s["brutto"] * vorzeichen)))

    # Hinweise
    hinweise = []
    if e.get("kleinunternehmer") == "ja" and not mit_steuer:
        hinweise.append(e.get("hinweis_19") or "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.")
    if ist_storno and rechnung.get("storno_text"):
        hinweise.append(rechnung["storno_text"])
    hinweis_html = ('<div class="hinweis">%s</div>' % q("\n".join(hinweise))) if hinweise else ""

    # Zahlungsteil mit GiroCode
    zahlung_html = ""
    if not ist_angebot and not ist_storno:
        frist = rechnung.get("zahlungsziel") or e.get("zahlungsziel") or 14
        verwendung = "Rechnung %s" % (rechnung.get("nummer") or "")
        text = ("<b>Zahlung innerhalb von %s Tagen</b> nach Rechnungserhalt, "
                "ohne Abzug bis zum %s. Bitte geben Sie bei der Überweisung "
                "<b>%s</b> und den Namen <b>%s</b> an."
                % (q(str(frist)), q(datum_text(rechnung.get("faellig_am"))),
                   q(verwendung), q(kundenname(kunde))))
        angaben = []
        if e.get("bank_inhaber"):
            angaben.append(("Empfänger", e["bank_inhaber"]))
        if e.get("bank_iban"):
            angaben.append(("IBAN", e["bank_iban"]))
        if e.get("bank_bic"):
            angaben.append(("BIC", e["bank_bic"]))
        if e.get("bank_name"):
            angaben.append(("Bank", e["bank_name"]))
        angaben_html = "".join("<dt>%s</dt><dd>%s</dd>" % (q(k), q(v)) for k, v in angaben)
        qr_html = ""
        if e.get("bank_iban"):
            try:
                inhalt = qr.girocode(e.get("bank_inhaber") or e.get("firma_name", ""),
                                     e["bank_iban"], s["brutto"], verwendung,
                                     e.get("bank_bic", ""))
                if inhalt:
                    qr_html = ('<div class="qr">%s Mit der Bank-App scannen</div>'
                               % qr.svg(inhalt, 108, 3))
            except Exception:
                qr_html = ""
        zahlung_html = ('<div class="zahlung"><div class="text">%s<dl>%s</dl></div>%s</div>'
                        % (text, angaben_html, qr_html))
    elif ist_angebot:
        zahlung_html = ('<div class="zahlung"><div class="text">Dieses Angebot ist '
                        '30 Tage gültig. Bei Zusage genügt eine kurze Rückmeldung, '
                        'dann geht es direkt in die Umsetzung.</div></div>')
    elif ist_storno:
        zahlung_html = ('<div class="zahlung"><div class="text">Der ausgewiesene Betrag '
                        'wird erstattet bzw. mit offenen Posten verrechnet.</div></div>')

    # Fusszeile
    fuss_spalten = []
    spalte1 = [e.get("firma_name", ""), e.get("firma_inhaber", ""), e.get("firma_strasse", ""),
               " ".join(y for y in [e.get("firma_plz", ""), e.get("firma_ort", "")] if y).strip()]
    spalte2 = []
    if e.get("firma_telefon"):
        spalte2.append("Telefon " + e["firma_telefon"])
    if e.get("firma_email"):
        spalte2.append(e["firma_email"])
    if e.get("firma_web"):
        spalte2.append(e["firma_web"])
    spalte3 = []
    if e.get("firma_steuernummer"):
        spalte3.append("Steuernummer " + e["firma_steuernummer"])
    if e.get("firma_ust_id"):
        spalte3.append("USt-IdNr. " + e["firma_ust_id"])
    if e.get("bank_iban"):
        spalte3.append("IBAN " + e["bank_iban"])
    for spalte in (spalte1, spalte2, spalte3):
        fuss_spalten.append("<div>%s</div>" % q("\n".join(x for x in spalte if x)))

    entwurf = ""
    if rechnung.get("status") == "entwurf" and not ist_angebot:
        entwurf = '<div class="entwurf">ENTWURF</div>'

    titel = _TITEL.get(typ, "Rechnung")
    untertitel = ""
    if ist_storno and rechnung.get("storno_nummer"):
        untertitel = "zur Rechnung %s" % rechnung["storno_nummer"]
    elif auftrag and auftrag.get("titel"):
        untertitel = auftrag["titel"]

    kopftext = rechnung.get("kopftext") or ""
    fusstext = rechnung.get("fusstext") or e.get("fusstext") or ""

    return """<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(titel)s %(nummer)s</title><style>%(stil)s</style></head>
<body>
<div class="werkzeugleiste">
  <b>%(titel)s %(nummer)s &middot; %(kunde)s</b>
  <button class="haupt" onclick="window.print()">Drucken oder als PDF sichern</button>
  <button onclick="window.close()">Schließen</button>
</div>
<div class="blatt">
  %(entwurf)s
  <div class="kopf">%(logo)s%(firma)s</div>
  <div class="anschrift">
    <div class="absender-klein">%(absender)s</div>
    <div style="margin-top:3mm">%(anschrift)s</div>
  </div>
  <div class="metablock">%(meta)s</div>
  <h1>%(titel)s %(nummer)s</h1>
  <div class="untertitel">%(untertitel)s</div>
  <div class="kopftext">%(kopftext)s</div>
  <table class="posten"><thead>%(kopfzeile)s</thead><tbody>%(reihen)s</tbody></table>
  <div class="summen">%(summen)s</div>
  %(hinweis)s
  %(zahlung)s
  <div class="fusstext">%(fusstext)s</div>
  <div class="fuss">%(fuss)s</div>
</div>
</body></html>""" % {
        "titel": q(titel), "nummer": q(rechnung.get("nummer") or ""),
        "kunde": q(kundenname(kunde)), "stil": _stil(vorlage, akzent),
        "entwurf": entwurf, "logo": logo, "firma": firma_block,
        "absender": q(absender_klein), "anschrift": anschrift, "meta": meta_html,
        "untertitel": q(untertitel), "kopftext": q(kopftext),
        "kopfzeile": kopfzeile, "reihen": "".join(reihen),
        "summen": "".join(summenzeilen), "hinweis": hinweis_html,
        "zahlung": zahlung_html, "fusstext": q(fusstext), "fuss": "".join(fuss_spalten),
    }


# --------------------------------------------------------------------------
# Mahnung
# --------------------------------------------------------------------------

_MAHNTITEL = {1: "Zahlungserinnerung", 2: "1. Mahnung", 3: "2. Mahnung"}


def verzugszinsen(betrag: float, faellig_iso: str, satz: float) -> float:
    """Einfache Zinsberechnung ab dem Tag nach Faelligkeit."""
    try:
        f = datetime.strptime((faellig_iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return 0.0
    tage = (date.today() - f).days
    if tage <= 0 or not satz:
        return 0.0
    return round(float(betrag) * float(satz) / 100.0 * tage / 365.0, 2)


def mahnung_seite(rechnung: dict, kunde: dict, e: dict, stufe: int) -> str:
    q = html.escape
    stufe = max(1, min(3, int(stufe or 1)))
    titel = _MAHNTITEL[stufe]
    text = e.get("mahntext_%d" % stufe, "")
    zinsen = 0.0
    if stufe >= 2:
        zinsen = verzugszinsen(rechnung.get("brutto", 0), rechnung.get("faellig_am"),
                               float(e.get("verzugszins") or 0))
    gesamt = round(float(rechnung.get("brutto") or 0) + zinsen, 2)
    tage_offen = 0
    try:
        f = datetime.strptime((rechnung.get("faellig_am") or "")[:10], "%Y-%m-%d").date()
        tage_offen = max(0, (date.today() - f).days)
    except ValueError:
        pass

    zeilen = ['<tr><td class="pos-nr">1</td><td class="pos-bez"><b>Rechnung %s vom %s</b>'
              '<small>fällig am %s · seit %d Tagen offen</small></td>'
              '<td class="r">%s €</td></tr>'
              % (q(rechnung.get("nummer", "")), datum_text(rechnung.get("datum")),
                 datum_text(rechnung.get("faellig_am")), tage_offen,
                 geld(rechnung.get("brutto")))]
    if zinsen:
        zeilen.append('<tr><td class="pos-nr">2</td><td class="pos-bez"><b>Verzugszinsen</b>'
                      '<small>%s %% p. a. für %d Tage</small></td><td class="r">%s €</td></tr>'
                      % (menge_text(e.get("verzugszins")), tage_offen, geld(zinsen)))

    qr_html = ""
    if e.get("bank_iban"):
        try:
            inhalt = qr.girocode(e.get("bank_inhaber") or e.get("firma_name", ""),
                                 e["bank_iban"], gesamt,
                                 "Rechnung %s" % rechnung.get("nummer", ""), e.get("bank_bic", ""))
            if inhalt:
                qr_html = '<div class="qr">%s Mit der Bank-App scannen</div>' % qr.svg(inhalt, 108, 3)
        except Exception:
            qr_html = ""

    firmenzeilen = [x for x in [e.get("firma_strasse", ""),
                                " ".join(y for y in [e.get("firma_plz", ""), e.get("firma_ort", "")] if y).strip(),
                                e.get("firma_telefon", ""), e.get("firma_email", "")] if x]
    frist = (date.today() + timedelta(days=7 if stufe == 1 else 5)).isoformat()

    return """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>%(titel)s %(nummer)s</title>
<style>%(stil)s</style></head><body>
<div class="werkzeugleiste"><b>%(titel)s zu %(nummer)s</b>
<button class="haupt" onclick="window.print()">Drucken oder als PDF sichern</button>
<button onclick="window.close()">Schließen</button></div>
<div class="blatt">
  <div class="kopf"><div></div><div class="firma-block"><b>%(firma)s</b>%(firmenzeilen)s</div></div>
  <div class="anschrift"><div style="margin-top:3mm">%(anschrift)s</div></div>
  <div class="metablock"><div><span>Datum</span>%(heute)s</div>
    <div><span>Kundennummer</span>%(kdnr)s</div>
    <div><span>Rechnung</span>%(nummer)s</div></div>
  <h1>%(titel)s</h1>
  <div class="kopftext">%(text)s</div>
  <table class="posten"><thead><tr><th class="pos-nr">Pos</th><th>Vorgang</th>
    <th class="r">Betrag</th></tr></thead><tbody>%(zeilen)s</tbody></table>
  <div class="summen"><div class="gesamt"><span>Offener Gesamtbetrag</span>
    <span>%(gesamt)s €</span></div></div>
  <div class="zahlung"><div class="text">Bitte überweisen Sie den Betrag bis zum
    <b>%(frist)s</b> auf das unten genannte Konto.
    <dl><dt>Empfänger</dt><dd>%(empf)s</dd><dt>IBAN</dt><dd>%(iban)s</dd></dl>
    </div>%(qr)s</div>
  <div class="fusstext">Sollte sich die Zahlung mit diesem Schreiben überschnitten haben,
    betrachten Sie es bitte als gegenstandslos.</div>
</div></body></html>""" % {
        "titel": q(titel), "nummer": q(rechnung.get("nummer", "")),
        "stil": _stil(e.get("vorlage") or "klar", e.get("akzentfarbe") or "#2563eb"),
        "firma": q(e.get("firma_name") or e.get("firma_inhaber", "")),
        "firmenzeilen": q("\n".join(firmenzeilen)),
        "anschrift": "".join('<span class="zeile">%s</span>' % q(z) for z in anschrift_zeilen(kunde)),
        "heute": datum_text(date.today().isoformat()), "kdnr": q(kunde.get("nummer", "")),
        "text": q(text), "zeilen": "".join(zeilen), "gesamt": geld(gesamt),
        "frist": datum_text(frist), "empf": q(e.get("bank_inhaber") or e.get("firma_name", "")),
        "iban": q(e.get("bank_iban", "")), "qr": qr_html,
    }


# --------------------------------------------------------------------------
# E-Rechnung (XRechnung / UBL 2.1)
# --------------------------------------------------------------------------

def _x(text) -> str:
    return html.escape(str(text or ""), quote=False)


def xrechnung(rechnung: dict, posten: list, kunde: dict, e: dict) -> str:
    """Erzeugt die E-Rechnung als XML im Format UBL 2.1 (XRechnung 3.0)."""
    s = summen(posten)
    steuerpflichtig = bool(s["steuerzeilen"])
    typcode = "381" if rechnung.get("typ") == "storno" else "380"

    zeilen_xml = []
    for i, p in enumerate(posten, 1):
        menge = float(p.get("menge") or 0)
        preis = float(p.get("einzelpreis") or 0)
        satz = float(p.get("steuersatz") or 0)
        betrag = round(menge * preis, 2)
        kategorie = "S" if satz > 0 else ("E" if e.get("kleinunternehmer") == "ja" else "Z")
        zeilen_xml.append("""  <cac:InvoiceLine>
    <cbc:ID>%d</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">%s</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">%.2f</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>%s</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>%s</cbc:ID>
        <cbc:Percent>%.2f</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">%.4f</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>""" % (i, ("%.3f" % menge), betrag,
                           _x(p.get("bezeichnung") or "Leistung"), kategorie, satz, preis))

    if steuerpflichtig:
        teil_xml = "".join("""    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">%.2f</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">%.2f</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>%.2f</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>""" % (z["grundlage"], z["betrag"], z["satz"]) for z in s["steuerzeilen"])
    else:
        grund = e.get("hinweis_19") or "Kleinunternehmer nach § 19 UStG"
        teil_xml = """    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">%.2f</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0.00</cbc:Percent>
        <cbc:TaxExemptionReason>%s</cbc:TaxExemptionReason>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>""" % (s["netto"], _x(grund))

    zahlung_xml = ""
    if e.get("bank_iban"):
        zahlung_xml = """  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cbc:PaymentID>%s</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>%s</cbc:ID>
      <cbc:Name>%s</cbc:Name>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>""" % (_x(rechnung.get("nummer")),
                            _x((e.get("bank_iban") or "").replace(" ", "")),
                            _x(e.get("bank_inhaber") or e.get("firma_name")))

    steuer_id_xml = ""
    if e.get("firma_ust_id"):
        steuer_id_xml = ("""      <cac:PartyTaxScheme><cbc:CompanyID>%s</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>"""
                         % _x(e["firma_ust_id"]))
    elif e.get("firma_steuernummer"):
        steuer_id_xml = ("""      <cac:PartyTaxScheme><cbc:CompanyID>%s</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>"""
                         % _x(e["firma_steuernummer"]))

    return """<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>%(nummer)s</cbc:ID>
  <cbc:IssueDate>%(datum)s</cbc:IssueDate>
  <cbc:DueDate>%(faellig)s</cbc:DueDate>
  <cbc:InvoiceTypeCode>%(typcode)s</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>%(leitweg)s</cbc:BuyerReference>
  <cac:AccountingSupplierParty><cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>%(a_strasse)s</cbc:StreetName>
        <cbc:CityName>%(a_ort)s</cbc:CityName>
        <cbc:PostalZone>%(a_plz)s</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
%(steuer_id)s
      <cac:PartyLegalEntity><cbc:RegistrationName>%(a_name)s</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:Contact><cbc:Name>%(a_inhaber)s</cbc:Name>
        <cbc:Telephone>%(a_tel)s</cbc:Telephone>
        <cbc:ElectronicMail>%(a_mail)s</cbc:ElectronicMail></cac:Contact>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>%(k_strasse)s</cbc:StreetName>
        <cbc:CityName>%(k_ort)s</cbc:CityName>
        <cbc:PostalZone>%(k_plz)s</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity><cbc:RegistrationName>%(k_name)s</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
%(zahlung)s
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">%(steuer).2f</cbc:TaxAmount>
%(teil)s
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">%(netto).2f</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">%(netto).2f</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">%(brutto).2f</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">%(brutto).2f</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
%(zeilen)s
</Invoice>
""" % {
        "nummer": _x(rechnung.get("nummer")), "datum": _x((rechnung.get("datum") or "")[:10]),
        "faellig": _x((rechnung.get("faellig_am") or rechnung.get("datum") or "")[:10]),
        "typcode": typcode, "leitweg": _x(kunde.get("leitweg_id") or kunde.get("nummer") or ""),
        "a_strasse": _x(e.get("firma_strasse")), "a_ort": _x(e.get("firma_ort")),
        "a_plz": _x(e.get("firma_plz")), "a_name": _x(e.get("firma_name") or e.get("firma_inhaber")),
        "a_inhaber": _x(e.get("firma_inhaber")), "a_tel": _x(e.get("firma_telefon")),
        "a_mail": _x(e.get("firma_email")), "steuer_id": steuer_id_xml,
        "k_strasse": _x(kunde.get("strasse")), "k_ort": _x(kunde.get("ort")),
        "k_plz": _x(kunde.get("plz")), "k_name": _x(kundenname(kunde)),
        "zahlung": zahlung_xml, "steuer": s["steuer"], "teil": teil_xml,
        "netto": s["netto"], "brutto": s["brutto"], "zeilen": "\n".join(zeilen_xml),
    }
