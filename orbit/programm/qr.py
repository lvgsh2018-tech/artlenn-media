#!/usr/bin/env python3
"""Erzeugt QR-Codes ohne Zusatzpakete - gebraucht fuer den GiroCode.

Nur was gebraucht wird: Byte-Modus, Fehlerkorrektur M, Version 1 bis 20.
Ausgabe ist ein SVG, das direkt in die Rechnung eingebettet wird.
"""

from __future__ import annotations

# Fehlerkorrektur-Bytes je Block, Blockaufteilung - Stufe M
# Version: (EC je Block, Bloecke Gruppe 1, Daten je Block, Bloecke Gruppe 2, Daten je Block)
_M = {
    1: (10, 1, 16, 0, 0),    2: (16, 1, 28, 0, 0),    3: (26, 1, 44, 0, 0),
    4: (18, 2, 32, 0, 0),    5: (24, 2, 43, 0, 0),    6: (16, 4, 27, 0, 0),
    7: (18, 4, 31, 0, 0),    8: (22, 2, 38, 2, 39),   9: (22, 3, 36, 2, 37),
    10: (26, 4, 43, 1, 44), 11: (30, 1, 50, 4, 51),  12: (22, 6, 36, 2, 37),
    13: (22, 8, 37, 1, 38), 14: (24, 4, 40, 5, 41),  15: (24, 5, 41, 5, 42),
    16: (28, 7, 45, 3, 46), 17: (28, 10, 46, 1, 47), 18: (26, 9, 43, 4, 44),
    19: (26, 3, 44, 11, 45), 20: (26, 3, 41, 13, 42),
}

_AUSRICHTUNG = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
    18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
}

# --------------------------------------------------------------------------
# Rechnen im Galois-Feld (fuer die Fehlerkorrektur)
# --------------------------------------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256


def _feld_aufbauen() -> None:
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_feld_aufbauen()


def _mal(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _generator(anzahl: int) -> list:
    poly = [1]
    for i in range(anzahl):
        neu = [0] * (len(poly) + 1)
        for j, wert in enumerate(poly):
            neu[j] ^= _mal(wert, 1)
            neu[j + 1] ^= _mal(wert, _EXP[i])
        poly = neu
    return poly


def _fehlerkorrektur(daten: list, anzahl: int) -> list:
    gen = _generator(anzahl)
    rest = list(daten) + [0] * anzahl
    for i in range(len(daten)):
        faktor = rest[i]
        if faktor == 0:
            continue
        for j, g in enumerate(gen):
            rest[i + j] ^= _mal(g, faktor)
    return rest[len(daten):]


# --------------------------------------------------------------------------
# Bitfolge bauen
# --------------------------------------------------------------------------

class _Bits:
    def __init__(self) -> None:
        self.werte = []

    def dazu(self, wert: int, laenge: int) -> None:
        for i in range(laenge - 1, -1, -1):
            self.werte.append((wert >> i) & 1)

    def __len__(self) -> int:
        return len(self.werte)


def _version_waehlen(laenge: int) -> int:
    for version in range(1, 21):
        ec, b1, d1, b2, d2 = _M[version]
        datenbytes = b1 * d1 + b2 * d2
        zaehlbits = 8 if version <= 9 else 16
        if 4 + zaehlbits + laenge * 8 <= datenbytes * 8:
            return version
    raise ValueError("Text ist zu lang für einen QR-Code dieser Größe")


def _daten_codieren(text: bytes, version: int) -> list:
    ec, b1, d1, b2, d2 = _M[version]
    datenbytes = b1 * d1 + b2 * d2
    bits = _Bits()
    bits.dazu(0b0100, 4)                                  # Byte-Modus
    bits.dazu(len(text), 8 if version <= 9 else 16)
    for byte in text:
        bits.dazu(byte, 8)
    # Abschluss
    rest = datenbytes * 8 - len(bits)
    bits.dazu(0, min(4, rest))
    while len(bits) % 8:
        bits.werte.append(0)
    woerter = []
    for i in range(0, len(bits), 8):
        wert = 0
        for b in bits.werte[i:i + 8]:
            wert = (wert << 1) | b
        woerter.append(wert)
    fueller = (0xEC, 0x11)
    i = 0
    while len(woerter) < datenbytes:
        woerter.append(fueller[i % 2])
        i += 1
    return woerter


def _bloecke_mischen(woerter: list, version: int) -> list:
    ec, b1, d1, b2, d2 = _M[version]
    bloecke, ec_bloecke = [], []
    pos = 0
    for _ in range(b1):
        bloecke.append(woerter[pos:pos + d1])
        pos += d1
    for _ in range(b2):
        bloecke.append(woerter[pos:pos + d2])
        pos += d2
    for block in bloecke:
        ec_bloecke.append(_fehlerkorrektur(block, ec))
    ergebnis = []
    for i in range(max(len(b) for b in bloecke)):
        for block in bloecke:
            if i < len(block):
                ergebnis.append(block[i])
    for i in range(ec):
        for block in ec_bloecke:
            ergebnis.append(block[i])
    return ergebnis


# --------------------------------------------------------------------------
# Matrix zeichnen
# --------------------------------------------------------------------------

def _grundmuster(version: int):
    groesse = version * 4 + 17
    feld = [[None] * groesse for _ in range(groesse)]
    fest = [[False] * groesse for _ in range(groesse)]

    def suchmuster(zx, zy):
        for y in range(-1, 8):
            for x in range(-1, 8):
                px, py = zx + x, zy + y
                if 0 <= px < groesse and 0 <= py < groesse:
                    rand = (0 <= x <= 6 and y in (0, 6)) or (0 <= y <= 6 and x in (0, 6))
                    kern = 2 <= x <= 4 and 2 <= y <= 4
                    feld[py][px] = 1 if (rand or kern) else 0
                    fest[py][px] = True

    suchmuster(0, 0)
    suchmuster(groesse - 7, 0)
    suchmuster(0, groesse - 7)

    for i in range(8, groesse - 8):
        wert = 1 if i % 2 == 0 else 0
        feld[6][i] = wert
        fest[6][i] = True
        feld[i][6] = wert
        fest[i][6] = True

    orte = _AUSRICHTUNG[version]
    for oy in orte:
        for ox in orte:
            if (ox < 8 and oy < 8) or (ox < 8 and oy > groesse - 9) or (ox > groesse - 9 and oy < 8):
                continue
            for y in range(-2, 3):
                for x in range(-2, 3):
                    kern = x == 0 and y == 0
                    rand = abs(x) == 2 or abs(y) == 2
                    feld[oy + y][ox + x] = 1 if (kern or rand) else 0
                    fest[oy + y][ox + x] = True

    feld[groesse - 8][8] = 1          # immer dunkel
    fest[groesse - 8][8] = True

    for i in range(9):                # Platz fuer die Formatangabe
        for px, py in ((i, 8), (8, i)):
            if not fest[py][px]:
                feld[py][px] = 0
                fest[py][px] = True
    for i in range(8):
        for px, py in ((groesse - 1 - i, 8), (8, groesse - 1 - i)):
            if not fest[py][px]:
                feld[py][px] = 0
                fest[py][px] = True

    if version >= 7:                  # Platz fuer die Versionsangabe
        for y in range(6):
            for x in range(3):
                fest[y][groesse - 11 + x] = True
                feld[y][groesse - 11 + x] = 0
                fest[groesse - 11 + x][y] = True
                feld[groesse - 11 + x][y] = 0

    return feld, fest, groesse


def _daten_einfuellen(feld, fest, groesse, woerter):
    bits = []
    for wert in woerter:
        for i in range(7, -1, -1):
            bits.append((wert >> i) & 1)
    stelle = 0
    spalte = groesse - 1
    aufwaerts = True
    while spalte > 0:
        if spalte == 6:
            spalte -= 1
        zeilen = range(groesse - 1, -1, -1) if aufwaerts else range(groesse)
        for y in zeilen:
            for x in (spalte, spalte - 1):
                if not fest[y][x]:
                    feld[y][x] = bits[stelle] if stelle < len(bits) else 0
                    stelle += 1
        aufwaerts = not aufwaerts
        spalte -= 2


def _maske(nummer: int, x: int, y: int) -> bool:
    if nummer == 0:
        return (x + y) % 2 == 0
    if nummer == 1:
        return y % 2 == 0
    if nummer == 2:
        return x % 3 == 0
    if nummer == 3:
        return (x + y) % 3 == 0
    if nummer == 4:
        return (y // 2 + x // 3) % 2 == 0
    if nummer == 5:
        return (x * y) % 2 + (x * y) % 3 == 0
    if nummer == 6:
        return ((x * y) % 2 + (x * y) % 3) % 2 == 0
    return ((x + y) % 2 + (x * y) % 3) % 2 == 0


def _formatbits(maske: int) -> int:
    # Fehlerkorrektur M entspricht 0b00
    wert = (0b00 << 3) | maske
    rest = wert << 10
    for i in range(4, -1, -1):
        if rest & (1 << (i + 10)):
            rest ^= 0b10100110111 << i
    return ((wert << 10) | rest) ^ 0b101010000010010


def _versionsbits(version: int) -> int:
    rest = version << 12
    for i in range(5, -1, -1):
        if rest & (1 << (i + 12)):
            rest ^= 0b1111100100101 << i
    return (version << 12) | rest


def _strafe(feld, groesse) -> int:
    punkte = 0
    for reihe in list(feld) + [list(s) for s in zip(*feld)]:
        lauf, letzter = 1, reihe[0]
        for wert in reihe[1:]:
            if wert == letzter:
                lauf += 1
            else:
                if lauf >= 5:
                    punkte += 3 + (lauf - 5)
                lauf, letzter = 1, wert
        if lauf >= 5:
            punkte += 3 + (lauf - 5)
        for i in range(len(reihe) - 10):
            teil = reihe[i:i + 11]
            if teil == [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0] or teil == [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]:
                punkte += 40
    for y in range(groesse - 1):
        for x in range(groesse - 1):
            block = feld[y][x] + feld[y][x + 1] + feld[y + 1][x] + feld[y + 1][x + 1]
            if block in (0, 4):
                punkte += 3
    dunkel = sum(sum(z) for z in feld)
    anteil = dunkel * 100.0 / (groesse * groesse)
    punkte += 10 * int(abs(anteil - 50) // 5)
    return punkte


def matrix(text: str) -> list:
    """Liefert den QR-Code als Liste von Zeilen mit 0/1."""
    roh = text.encode("utf-8")
    version = _version_waehlen(len(roh))
    woerter = _bloecke_mischen(_daten_codieren(roh, version), version)

    beste, beste_punkte = None, None
    for nummer in range(8):
        feld, fest, groesse = _grundmuster(version)
        _daten_einfuellen(feld, fest, groesse, woerter)
        for y in range(groesse):
            for x in range(groesse):
                if not fest[y][x] and _maske(nummer, x, y):
                    feld[y][x] ^= 1
        _format_schreiben(feld, groesse, nummer)
        if version >= 7:
            _version_schreiben(feld, groesse, version)
        punkte = _strafe(feld, groesse)
        if beste_punkte is None or punkte < beste_punkte:
            beste, beste_punkte = feld, punkte
    return beste


def _format_schreiben(feld, groesse, maske) -> None:
    bits = _formatbits(maske)
    for i in range(15):
        wert = (bits >> i) & 1
        # erste Kopie rund um das linke obere Suchmuster
        if i < 6:
            feld[i][8] = wert
        elif i == 6:
            feld[7][8] = wert
        elif i == 7:
            feld[8][8] = wert
        elif i == 8:
            feld[8][7] = wert
        else:
            feld[8][14 - i] = wert
        # zweite Kopie am rechten und unteren Rand
        if i < 8:
            feld[8][groesse - 1 - i] = wert
        else:
            feld[groesse - 15 + i][8] = wert


def _version_schreiben(feld, groesse, version) -> None:
    bits = _versionsbits(version)
    for i in range(18):
        wert = (bits >> i) & 1
        feld[i // 3][groesse - 11 + i % 3] = wert
        feld[groesse - 11 + i % 3][i // 3] = wert


def svg(text: str, groesse_px: int = 150, rand: int = 4, farbe: str = "#0d253d") -> str:
    """QR-Code als SVG-Zeichenkette - laesst sich direkt einbetten."""
    feld = matrix(text)
    n = len(feld)
    gesamt = n + 2 * rand
    teile = []
    for y, zeile in enumerate(feld):
        x = 0
        while x < n:
            if zeile[x]:
                start = x
                while x < n and zeile[x]:
                    x += 1
                teile.append("M%d %dh%dv1h-%dz" % (start + rand, y + rand, x - start, x - start))
            else:
                x += 1
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
        'shape-rendering="crispEdges" role="img" aria-label="QR-Code für die Überweisung">'
        '<rect width="%d" height="%d" fill="#ffffff"/><path d="%s" fill="%s"/></svg>'
        % (groesse_px, groesse_px, gesamt, gesamt, gesamt, gesamt, "".join(teile), farbe)
    )


def girocode(empfaenger: str, iban: str, betrag: float, verwendungszweck: str,
             bic: str = "") -> str:
    """Text nach EPC-069-12 - Bankprogramme lesen daraus die Ueberweisung."""
    iban = (iban or "").replace(" ", "").upper()
    if not iban:
        return ""
    felder = [
        "BCD", "002", "1", "SCT", (bic or "").replace(" ", "").upper(),
        (empfaenger or "")[:70], iban,
        "EUR%.2f" % max(0.0, float(betrag or 0)), "", "",
        (verwendungszweck or "")[:140], "",
    ]
    return "\n".join(felder)
