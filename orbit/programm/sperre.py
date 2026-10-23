#!/usr/bin/env python3
"""Passwortschutz fuer MeinOrbit.

Freiwillig: ohne eingerichtetes Passwort verhaelt sich das Programm wie bisher.
Ist eines gesetzt, gibt der Server ohne Anmeldung keine Daten heraus - weder an
die Oberflaeche noch an einen direkten Aufruf.

Das Passwort wird nie im Klartext abgelegt. Gespeichert wird nur ein Pruefwert
(PBKDF2-HMAC-SHA256 mit Zufallssalz), aus dem sich das Passwort nicht
zurueckrechnen laesst. Er liegt in `daten/sperre.json`.

Passwort vergessen? Diese eine Datei loeschen - dann ist die Sperre weg und alle
anderen Daten bleiben unangetastet. Das ist Absicht: die Sperre ist ein
verschlossener Vorhang vor der Oberflaeche, kein Tresor. Wer vollen Zugriff auf
den Rechner hat, kommt auch an den Datenordner. Wirklichen Schutz gibt erst die
Festplattenverschluesselung des Rechners (FileVault auf dem Mac, BitLocker
unter Windows) - darauf weist die Oberflaeche auch hin.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time

import datenbank as db


class Fehler(Exception):
    """Etwas stimmt nicht - die Meldung geht an die Oberflaeche."""


DATEI = os.path.join(db.DATEN, "sperre.json")

RUNDEN = 240000          # Rechenaufwand je Versuch, bremst Durchprobieren aus
VERSUCHE_BIS_PAUSE = 5   # so viele Fehlversuche sind frei
PAUSE = 60               # danach so viele Sekunden Zwangspause
STANDARD_MINUTEN = 30    # Ruhezeit, nach der von selbst wieder zugeht
SCHONFRIST = 120         # so lange gilt ein neu aufgezogenes Fenster als "war gerade dran"
MINDESTLAENGE = 4

# Offene Sitzungen leben nur im Arbeitsspeicher. Startet das Programm neu,
# sind sie weg - dann wird wieder gefragt.
_sitzungen: dict[str, float] = {}
_fehl = {"anzahl": 0, "pause_bis": 0.0}


# --------------------------------------------------------------------------
# Die Datei
# --------------------------------------------------------------------------

def _lesen() -> dict | None:
    try:
        with open(DATEI, "r", encoding="utf-8") as f:
            daten = json.load(f)
        if daten.get("pruefwert") and daten.get("salz"):
            return daten
    except (OSError, ValueError):
        pass
    return None


def _schreiben(daten: dict) -> None:
    os.makedirs(db.DATEN, exist_ok=True)
    vorlaeufig = DATEI + ".neu"
    with open(vorlaeufig, "w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, indent=1)
    os.replace(vorlaeufig, DATEI)
    try:
        os.chmod(DATEI, 0o600)
    except OSError:
        pass


def _pruefwert(passwort: str, salz: str, runden: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", passwort.encode("utf-8"),
                               bytes.fromhex(salz), runden).hex()


# --------------------------------------------------------------------------
# Zustand
# --------------------------------------------------------------------------

def eingerichtet() -> bool:
    return _lesen() is not None


def regeln() -> dict:
    daten = _lesen() or {}
    return {
        "aktiv": bool(daten),
        "minuten": int(daten.get("minuten", STANDARD_MINUTEN) or 0),
        "beim_oeffnen": daten.get("beim_oeffnen", "ja") == "ja",
        "seit": daten.get("erstellt", ""),
    }


def regeln_aendern(minuten, beim_oeffnen) -> None:
    daten = _lesen()
    if not daten:
        raise Fehler("Es ist noch kein Passwort eingerichtet.")
    try:
        minuten = max(0, min(600, int(minuten)))
    except (TypeError, ValueError):
        minuten = STANDARD_MINUTEN
    daten["minuten"] = minuten
    daten["beim_oeffnen"] = "ja" if beim_oeffnen in (True, "ja", 1, "1") else "nein"
    _schreiben(daten)


# --------------------------------------------------------------------------
# Einrichten, aendern, abschalten
# --------------------------------------------------------------------------

def setzen(neu: str, alt: str = "") -> None:
    neu = (neu or "").strip()
    if len(neu) < MINDESTLAENGE:
        raise Fehler("Das Passwort braucht mindestens %d Zeichen." % MINDESTLAENGE)

    vorhanden = _lesen()
    if vorhanden and not _stimmt(vorhanden, alt):
        raise Fehler("Das bisherige Passwort stimmt nicht.")

    salz = secrets.token_bytes(16).hex()
    _schreiben({
        "verfahren": "pbkdf2_sha256",
        "runden": RUNDEN,
        "salz": salz,
        "pruefwert": _pruefwert(neu, salz, RUNDEN),
        "minuten": (vorhanden or {}).get("minuten", STANDARD_MINUTEN),
        "beim_oeffnen": (vorhanden or {}).get("beim_oeffnen", "ja"),
        "erstellt": (vorhanden or {}).get("erstellt") or time.strftime("%Y-%m-%d"),
        "geaendert": time.strftime("%Y-%m-%d"),
    })
    # Wer das Passwort aendert, wirft alle offenen Fenster hinaus - ausser sich
    # selbst; darum ruft die Oberflaeche danach gleich wieder "oeffnen" auf.
    _sitzungen.clear()


def entfernen(passwort: str) -> None:
    vorhanden = _lesen()
    if not vorhanden:
        return
    if not _stimmt(vorhanden, passwort):
        raise Fehler("Das Passwort stimmt nicht.")
    try:
        os.remove(DATEI)
    except OSError as f:
        raise Fehler("Die Sperre liess sich nicht abschalten: %s" % f)
    _sitzungen.clear()


def _stimmt(daten: dict, passwort: str) -> bool:
    versuch = _pruefwert(passwort or "", daten["salz"], int(daten.get("runden", RUNDEN)))
    return hmac.compare_digest(versuch, daten["pruefwert"])


# --------------------------------------------------------------------------
# Auf- und zuschliessen
# --------------------------------------------------------------------------

def oeffnen(passwort: str) -> str:
    """Prueft das Passwort und gibt bei Erfolg einen Sitzungsschluessel zurueck."""
    daten = _lesen()
    if not daten:
        return ""

    wartet = _fehl["pause_bis"] - time.time()
    if wartet > 0:
        raise Fehler("Zu viele Fehlversuche. Bitte %d Sekunden warten."
                     % int(wartet + 0.5))

    if not _stimmt(daten, passwort):
        _fehl["anzahl"] += 1
        if _fehl["anzahl"] >= VERSUCHE_BIS_PAUSE:
            _fehl["anzahl"] = 0
            _fehl["pause_bis"] = time.time() + PAUSE
            raise Fehler("Zu viele Fehlversuche. Bitte %d Sekunden warten." % PAUSE)
        raise Fehler("Das Passwort stimmt nicht.")

    _fehl["anzahl"] = 0
    _aufraeumen()
    schluessel = secrets.token_urlsafe(32)
    _sitzungen[schluessel] = time.time()
    return schluessel


def fenster_geoeffnet(schluessel: str) -> None:
    """Das Fenster wurde frisch aufgezogen.

    Mit "bei jedem Oeffnen fragen" geht dabei zu. Ausgenommen ist der Fall, in
    dem der Nutzer gerade eben noch dran war: minimiert und gleich zurueck, oder
    die Seite hat sich neu aufgebaut, waehrend er davorsass. Sonst stuende er
    fuer ein weggeklicktes Fenster jedes Mal vor dem Passwort. Ist er laenger
    weg, greift wie gewohnt die Ruhezeit.
    """
    daten = _lesen()
    if not daten or daten.get("beim_oeffnen", "ja") != "ja":
        return
    letzte = _sitzungen.get(schluessel or "")
    if letzte is not None and time.time() - letzte <= SCHONFRIST:
        return
    schliessen(schluessel)


def schliessen(schluessel: str) -> None:
    _sitzungen.pop(schluessel or "", None)


def alle_schliessen() -> None:
    _sitzungen.clear()


def offen(schluessel: str) -> bool:
    """Wahr, wenn der Schluessel gilt. Nebenbei wird die Ruhezeit zurueckgesetzt."""
    if not eingerichtet():
        return True
    jetzt = time.time()
    letzte = _sitzungen.get(schluessel or "")
    if letzte is None:
        return False
    minuten = regeln()["minuten"]
    if minuten and jetzt - letzte > minuten * 60:
        _sitzungen.pop(schluessel, None)
        return False
    _sitzungen[schluessel] = jetzt
    return True


def _aufraeumen() -> None:
    minuten = regeln()["minuten"] or 720
    grenze = time.time() - minuten * 60
    for schluessel in [s for s, zeit in _sitzungen.items() if zeit < grenze]:
        _sitzungen.pop(schluessel, None)
