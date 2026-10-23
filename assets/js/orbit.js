/* MeinOrbit im geschützten Bereich der ARTLENN-MEDIA-Webseite.
   Der rote Faden wie am Mac: Kunde → Auftrag → Angebot → Rechnung → Finanzen.
   Zwei Regeln, die nicht aufgeweicht werden dürfen:
   - Festschreiben statt Ändern (GoBD): Ein Entwurf ist frei änderbar. Danach
     bekommt der Beleg seine Nummer und bleibt so stehen; Korrektur nur per Storno
     mit eigener Nummer, das Original bleibt erhalten.
   - Zufluss-Abfluss-Prinzip: In den Finanzen zählt bezahlt_am, nicht das
     Rechnungsdatum. Eine erstattete Rechnung zählt am Erstattungstag negativ. */
(function () {
  'use strict';

  var S = { kunden: [], leistungen: [], auftraege: [], rechnungen: [], ausgaben: [], einnahmen: [], zeiten: [], kundenpreise: [], e: {} };
  var inhalt = document.getElementById('inhalt');
  var MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  var AUFTRAG_STAND = { anfrage: 'Anfrage', angebot: 'Angebot raus', bearbeitung: 'In Arbeit', fertig: 'Fertig', abgerechnet: 'Abgerechnet', abgelehnt: 'Abgelehnt' };
  var AUSGABE_ART = ['Technik', 'Software', 'Fahrtkosten', 'Druck', 'Werbung', 'Telefon und Internet', 'Büro', 'Fortbildung', 'Sonstiges'];

  /* ---------- Kleine Helfer ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function zahl(x) { var n = typeof x === 'number' ? x : parseFloat(String(x == null ? '' : x).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : 0; }
  function rund(n) { return Math.round(n * 100) / 100; }
  function eur(n) { return zahl(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }); }
  function komma(n) { return zahl(n).toLocaleString('de-DE', { maximumFractionDigits: 2 }); }
  function heute() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function datum(s) { return s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : ''; }
  function plusTage(s, n) { var d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function per(liste, id) { return liste.find(function (x) { return x.id === Number(id); }) || null; }
  function kundeName(k) { return k ? (k.firma || ((k.vorname || '') + ' ' + (k.nachname || '')).trim() || 'Ohne Namen') : 'Ohne Kunde'; }
  function kundeVon(x) { return per(S.kunden, x.kunde_id); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function jahr(s) { return String(s || '').slice(0, 4); }
  function istKlein() { return S.e.kleinunternehmer === 'ja'; }
  function tageZwischen(von, bis) { return Math.round((new Date(bis + 'T12:00') - new Date(von + 'T12:00')) / 86400000); }
  var MAHNTITEL = { 1: 'Zahlungserinnerung', 2: '1. Mahnung', 3: '2. Mahnung' };

  function hinweis(text, fehler) {
    var h = document.getElementById('hinweis');
    h.textContent = text; h.className = 'hinweis-leiste da' + (fehler ? ' fehler' : '');
    clearTimeout(hinweis.t); hinweis.t = setTimeout(function () { h.className = 'hinweis-leiste'; }, fehler ? 5000 : 2600);
  }
  function fehler(err) { console.error(err); hinweis(err && err.message ? err.message : 'Das hat nicht geklappt.', true); }

  /* Speichern immer über diese Stelle, damit Fehler sauber ankommen und die Liste aktuell bleibt. */
  function speichern(tabelle, obj) {
    return Promise.resolve().then(function () { return AMD.speichern(tabelle, obj); }).then(function (neu) {
      var liste = S[tabelle], i = liste.findIndex(function (x) { return x.id === neu.id; });
      if (i < 0) liste.push(neu); else liste[i] = neu;
      return neu;
    });
  }
  function loeschen(tabelle, id) {
    return Promise.resolve().then(function () { return AMD.loeschen(tabelle, id); }).then(function () {
      S[tabelle] = S[tabelle].filter(function (x) { return x.id !== id; });
    });
  }

  /* ---------- Nummern ---------- */
  function naechste(liste, praefix, stellen) {
    var max = 0;
    liste.forEach(function (x) {
      if (x.nummer && x.nummer.indexOf(praefix) === 0) { var n = parseInt(x.nummer.slice(praefix.length), 10); if (n > max) max = n; }
    });
    return praefix + String(max + 1).padStart(stellen, '0');
  }
  function kundenNummer() { return naechste(S.kunden, 'K-', 4); }
  function auftragsNummer() { return naechste(S.auftraege, 'A-' + new Date().getFullYear() + '-', 3); }
  function belegNummer(typ, d) {
    var j = jahr(d || heute());
    if (typ === 'angebot') return naechste(S.rechnungen.filter(function (r) { return r.typ === 'angebot'; }), 'AN-' + j + '-', 3);
    // Rechnungen und Stornos teilen sich einen lückenlosen Nummernkreis
    return naechste(S.rechnungen.filter(function (r) { return r.typ !== 'angebot'; }), j + '-', 4);
  }

  /* ---------- Beträge ---------- */
  function postenSumme(p) { return rund(zahl(p.menge) * zahl(p.einzelpreis)); }
  function summen(posten) {
    var netto = rund((posten || []).reduce(function (s, p) { return s + postenSumme(p); }, 0));
    var satz = istKlein() ? 0 : zahl(S.e.steuersatz);
    var steuer = rund(netto * satz / 100);
    return { netto: netto, steuer: steuer, brutto: rund(netto + steuer), satz: satz };
  }
  function standVon(r) {
    if (r.typ === 'storno') return { k: 'storniert', t: 'Storno' };
    if (r.status === 'offen' && r.typ === 'rechnung' && r.faellig_am && r.faellig_am < heute()) return { k: 'ueberfaellig', t: 'Überfällig' };
    var t = { entwurf: 'Entwurf', offen: r.typ === 'angebot' ? 'Verschickt' : 'Offen', bezahlt: 'Bezahlt', storniert: 'Storniert', angenommen: 'Angenommen', abgelehnt: 'Abgelehnt' }[r.status] || r.status;
    return { k: r.status, t: t };
  }
  function standHtml(r) { var s = standVon(r); return '<span class="stand ' + s.k + '">' + esc(s.t) + '</span>'; }
  function auftragStand(a) {
    var k = { anfrage: 'offen', angebot: 'offen', bearbeitung: 'arbeit', fertig: 'fertig', abgerechnet: 'bezahlt', abgelehnt: 'abgelehnt' }[a.status] || 'entwurf';
    return '<span class="stand ' + k + '">' + esc(AUFTRAG_STAND[a.status] || a.status) + '</span>';
  }

  /* ---------- Dialog ---------- */
  function dialog(o) {
    var d = document.getElementById('dialog');
    d.innerHTML = '<form method="dialog"><div class="d-kopf"><h2>' + esc(o.titel) + '</h2>' + (o.unter ? '<p style="margin:0;color:var(--schrift-3)">' + esc(o.unter) + '</p>' : '') + '</div>' +
      '<div class="d-inhalt">' + (o.html || '') + '</div><div class="d-fuss">' +
      (o.knoepfe || [{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Speichern', w: 'ok' }]).map(function (k) {
        return '<button class="knopf klein ' + (k.art || '') + '" value="' + esc(k.w) + '"' + (k.w === '' ? ' formnovalidate' : '') + '>' + esc(k.t) + '</button>';
      }).join('') + '</div></form>';
    return new Promise(function (fertig) {
      var form = d.querySelector('form');
      if (o.nachher) o.nachher(d, function (w) { d.close(w); });
      d.onclose = function () {
        var werte = {};
        Array.prototype.forEach.call(form.elements, function (el) {
          if (!el.name) return;
          werte[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        });
        fertig({ wahl: d.returnValue, werte: werte });
      };
      d.returnValue = '';
      d.showModal();
      var erstes = d.querySelector('.d-inhalt input, .d-inhalt select, .d-inhalt textarea');
      if (erstes) erstes.focus();
    });
  }
  function frage(titel, text, ja, gefahr) {
    return dialog({ titel: titel, html: '<p style="margin:0">' + esc(text) + '</p>', knoepfe: [{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: ja, w: 'ok', art: gefahr ? 'gefahr' : '' }] })
      .then(function (r) { return r.wahl === 'ok'; });
  }

  /* ---------- Formularbausteine ---------- */
  function feld(name, label, wert, o) {
    o = o || {};
    var id = 'f-' + name, art = o.art || 'text', breite = o.breite ? ' ' + o.breite : '';
    var ein;
    if (art === 'textarea') ein = '<textarea class="ein" id="' + id + '" name="' + name + '"' + (o.zeilen ? ' rows="' + o.zeilen + '"' : '') + '>' + esc(wert) + '</textarea>';
    else if (art === 'select') ein = '<select class="ein" id="' + id + '" name="' + name + '">' + o.optionen.map(function (op) {
      var w = Array.isArray(op) ? op[0] : op, t = Array.isArray(op) ? op[1] : op;
      return '<option value="' + esc(w) + '"' + (String(w) === String(wert) ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('') + '</select>';
    else ein = '<input class="ein" id="' + id + '" name="' + name + '" type="' + art + '" value="' + esc(wert) + '"' +
      (o.pflicht ? ' required' : '') + (o.nurLesen ? ' readonly' : '') + (o.schritt ? ' step="' + o.schritt + '"' : '') +
      (o.modus ? ' inputmode="' + o.modus + '"' : '') + (o.auto ? ' autocomplete="' + o.auto + '"' : '') + '>';
    return '<div class="feld' + breite + '"><label for="' + id + '">' + esc(label) + '</label>' + ein + (o.hilfe ? '<small>' + esc(o.hilfe) + '</small>' : '') + '</div>';
  }
  function werteAus(form) {
    var w = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.dataset.posten) return;
      w[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return w;
  }
  function kundenOptionen(leer) {
    var l = S.kunden.filter(function (k) { return !k.archiviert; }).sort(function (a, b) { return kundeName(a).localeCompare(kundeName(b), 'de'); })
      .map(function (k) { return [k.id, kundeName(k) + (k.nummer ? ' (' + k.nummer + ')' : '')]; });
    return leer ? [['', leer]].concat(l) : l;
  }

  /* ---------- Positionen bearbeiten ---------- */
  function postenEditor(posten, nurLesen) {
    var zeilen = posten.map(function (p, i) {
      if (nurLesen || p.rechnung_id) {
        return '<tr><td>' + esc(p.bezeichnung) + (p.rechnung_id && !nurLesen ? '<span class="neben" style="color:var(--schrift-3);font-size:13px">abgerechnet</span>' : '') + '</td>' +
          '<td class="r">' + komma(p.menge) + ' ' + esc(p.einheit) + '</td><td class="r">' + eur(p.einzelpreis) + '</td><td class="betrag">' + eur(postenSumme(p)) + '</td><td></td></tr>';
      }
      return '<tr data-i="' + i + '">' +
        '<td><input class="ein" data-posten="bezeichnung" value="' + esc(p.bezeichnung) + '" aria-label="Bezeichnung" placeholder="Bezeichnung"></td>' +
        '<td style="width:96px"><input class="ein" data-posten="menge" value="' + esc(komma(p.menge)) + '" inputmode="decimal" aria-label="Menge"></td>' +
        '<td style="width:110px"><input class="ein" data-posten="einheit" value="' + esc(p.einheit) + '" aria-label="Einheit"></td>' +
        '<td style="width:120px"><input class="ein" data-posten="einzelpreis" value="' + esc(komma(p.einzelpreis)) + '" inputmode="decimal" aria-label="Einzelpreis in Euro"></td>' +
        '<td class="betrag" style="width:110px">' + eur(postenSumme(p)) + '</td>' +
        '<td style="width:44px"><button type="button" class="x" data-weg="' + i + '" aria-label="Position entfernen">×</button></td></tr>';
    }).join('');
    var s = summen(posten);
    return '<div class="rolle"><table class="posten"><thead><tr><th>Bezeichnung</th><th>Menge</th><th>Einheit</th><th>Einzelpreis</th><th style="text-align:right">Betrag</th><th></th></tr></thead><tbody>' +
      (zeilen || '<tr><td colspan="6" class="leer">Noch keine Positionen.</td></tr>') + '</tbody></table></div>' +
      (nurLesen ? '' : '<div class="formfuss" style="margin-top:12px"><button type="button" class="knopf zweit klein" data-neu-posten>+ Position</button><button type="button" class="knopf zweit klein" data-aus-leistung>+ Aus Leistungen</button></div>') +
      '<div class="summe" data-summe>' + summenText(s) + '</div>';
  }
  function summenText(s) {
    return istKlein() ? '<span>Gesamt</span><span>' + eur(s.brutto) + '</span>'
      : '<span style="font-weight:500">Netto ' + eur(s.netto) + ' · USt ' + komma(s.satz) + ' % ' + eur(s.steuer) + '</span><span>Gesamt ' + eur(s.brutto) + '</span>';
  }
  /* Bindet einen Positions-Editor an eine Liste; neuZeichnen() malt ihn neu. */
  function postenBinden(box, posten, neuZeichnen, kundeHolen) {
    function lesen() {
      box.querySelectorAll('tr[data-i]').forEach(function (tr) {
        var p = posten[Number(tr.dataset.i)];
        tr.querySelectorAll('[data-posten]').forEach(function (el) {
          var k = el.dataset.posten;
          // Ein Eingabefeld verschluckt Zeilenumbrüche: unveränderte Bezeichnung mit Beschreibung behalten
          if (k === 'bezeichnung' && el.value === String(p[k] || '').replace(/[\r\n]/g, '')) return;
          p[k] = (k === 'menge' || k === 'einzelpreis') ? zahl(el.value) : el.value;
        });
      });
    }
    box.addEventListener('input', function (e) {
      if (!e.target.dataset.posten) return;
      lesen();
      var tr = e.target.closest('tr'), p = posten[Number(tr.dataset.i)];
      tr.querySelector('.betrag').textContent = eur(postenSumme(p));
      box.querySelector('[data-summe]').innerHTML = summenText(summen(posten));
    });
    box.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.dataset.weg != null) { lesen(); posten.splice(Number(t.dataset.weg), 1); neuZeichnen(); }
      if (t.hasAttribute('data-neu-posten')) { lesen(); posten.push({ id: uid(), bezeichnung: '', menge: 1, einheit: 'Stück', einzelpreis: 0 }); neuZeichnen(); var l = box.querySelectorAll('tr[data-i] input'); if (l.length) l[l.length - 4].focus(); }
      if (t.hasAttribute('data-aus-leistung')) { lesen(); leistungWaehlen(kundeHolen ? kundeHolen() : null).then(function (l) { if (!l) return; posten.push({ id: uid(), bezeichnung: l.name + (l.beschreibung ? '\n' + l.beschreibung : ''), menge: 1, einheit: l.einheit || 'Stück', einzelpreis: preisFuer(kundeHolen ? kundeHolen() : null, l) }); neuZeichnen(); }); }
    });
    return lesen;
  }
  /* Eigener Preis des Kunden geht vor dem Listenpreis der Leistung. */
  function kundenpreis(kundeId, leistung) {
    if (!kundeId || !leistung) return null;
    return S.kundenpreise.find(function (p) { return p.kunde_id === Number(kundeId) && p.leistung_id === leistung.id; }) || null;
  }
  function preisFuer(kundeId, leistung) { var kp = kundenpreis(kundeId, leistung); return zahl(kp ? kp.preis : leistung.preis); }
  function leistungWaehlen(kundeId) {
    var aktiv = S.leistungen.filter(function (l) { return l.aktiv !== false; }).sort(function (a, b) {
      return (!!kundenpreis(kundeId, b) - !!kundenpreis(kundeId, a)) || a.name.localeCompare(b.name, 'de');
    });
    var k = kundeId ? per(S.kunden, kundeId) : null;
    return dialog({
      titel: 'Leistung wählen', unter: k && S.kundenpreise.some(function (p) { return p.kunde_id === k.id; }) ? 'Eigene Preise von ' + kundeName(k) + ' stehen oben.' : '',
      html: aktiv.length ? '<ul class="wahl-liste">' + aktiv.map(function (l) {
        var kp = kundenpreis(kundeId, l);
        return '<li><button type="button" data-l="' + l.id + '"><span>' + esc(l.name) + '<small>' + esc(l.beschreibung) + '</small></span><b style="white-space:nowrap;text-align:right">' +
          (kp ? eur(kp.preis) + '<small style="font-weight:500">Kundenpreis, sonst ' + eur(l.preis) + '</small>' : eur(l.preis)) + '</b></button></li>';
      }).join('') + '</ul>' : '<p class="leer">Noch keine Leistungen angelegt.</p>',
      knoepfe: [{ t: 'Abbrechen', w: '', art: 'zweit' }],
      nachher: function (d, zu) { d.querySelectorAll('[data-l]').forEach(function (b) { b.addEventListener('click', function () { zu('l' + b.dataset.l); }); }); }
    }).then(function (r) { return r.wahl && r.wahl[0] === 'l' ? per(S.leistungen, r.wahl.slice(1)) : null; });
  }

  /* ---------- Gerüst ---------- */
  function seite(titel, unter, aktionen, rumpf) {
    inhalt.innerHTML = (AMD.modus === 'beispiel' ? '<div class="beispiel-band">Beispielmodus: Noch keine Datenbank verbunden. Alles bleibt nur in diesem Browser.</div>' : '') +
      '<div class="kopfzeile"><div><h1>' + esc(titel) + '</h1>' + (unter ? '<p class="unter">' + unter + '</p>' : '') + '</div>' +
      (aktionen ? '<div class="aktionen">' + aktionen + '</div>' : '') + '</div>' + rumpf;
  }
  function zeilenKlick() {
    inhalt.querySelectorAll('tr[data-href]').forEach(function (tr) {
      tr.addEventListener('click', function (e) { if (!e.target.closest('a,button')) location.hash = tr.dataset.href; });
    });
  }
  function tabelle(kopf, zeilen, leerText, karten) {
    if (!zeilen.length) return '<p class="leer">' + esc(leerText) + '</p>';
    return '<div class="rolle"><table class="tabelle' + (karten ? ' karten' : '') + '"><thead><tr>' + kopf.map(function (k) {
      return '<th' + (k[1] ? ' class="' + k[1] + '"' : '') + '>' + esc(k[0]) + '</th>';
    }).join('') + '</tr></thead><tbody>' + zeilen.join('') + '</tbody></table></div>';
  }
  function belegZeile(r, mitKunde) {
    var k = kundeVon(r);
    return '<tr data-href="beleg/' + r.id + '"><td><a href="#beleg/' + r.id + '">' + esc(r.nummer || 'Entwurf') + '</a>' +
      (r.typ === 'storno' ? '<span class="neben">Storno</span>' : '') + (r.mahnstufe && r.status === 'offen' ? '<span class="neben">' + MAHNTITEL[r.mahnstufe] + ' am ' + datum(r.mahnung_am) + '</span>' : '') + '</td>' +
      (mitKunde ? '<td>' + esc(kundeName(k)) + '</td>' : '') +
      '<td class="weg">' + datum(r.datum) + '</td><td class="r">' + eur(r.brutto) + '</td><td>' + standHtml(r) + '</td></tr>';
  }

  /* ---------- Übersicht ---------- */
  function zufluss(von, bis) {
    var ein = 0;
    S.rechnungen.forEach(function (r) { if (r.typ !== 'angebot' && r.bezahlt_am && r.bezahlt_am >= von && r.bezahlt_am <= bis) ein += zahl(r.bezahlt_betrag); });
    S.einnahmen.forEach(function (x) { if (x.datum >= von && x.datum <= bis) ein += zahl(x.betrag); });
    return rund(ein);
  }
  function abfluss(von, bis) {
    return rund(S.ausgaben.reduce(function (s, x) { return x.datum >= von && x.datum <= bis ? s + zahl(x.betrag) : s; }, 0));
  }
  function ansichtStart() {
    var j = String(new Date().getFullYear());
    var offen = S.rechnungen.filter(function (r) { return r.typ === 'rechnung' && r.status === 'offen'; });
    var ueber = offen.filter(function (r) { return r.faellig_am && r.faellig_am < heute(); });
    var laufend = S.auftraege.filter(function (a) { return ['anfrage', 'angebot', 'bearbeitung', 'fertig'].indexOf(a.status) >= 0; });
    var summeOffen = offen.reduce(function (s, r) { return s + zahl(r.brutto); }, 0);
    var summeUeber = ueber.reduce(function (s, r) { return s + zahl(r.brutto); }, 0);
    seite('Übersicht', 'Stand ' + datum(heute()), '<a class="knopf klein" href="#beleg/neu-rechnung">Neue Rechnung</a><a class="knopf zweit klein" href="#auftrag/neu">Neuer Auftrag</a>',
      '<div class="zahlen">' +
      '<div class="zahl" style="--farbe:var(--gelb)"><span>Offene Rechnungen</span><b>' + eur(summeOffen) + '</b><small>' + offen.length + ' Stück</small></div>' +
      '<div class="zahl" style="--farbe:var(--pink)"><span>Davon überfällig</span><b>' + eur(summeUeber) + '</b><small>' + ueber.length + ' Stück</small></div>' +
      '<div class="zahl" style="--farbe:var(--petrol)"><span>Laufende Aufträge</span><b>' + laufend.length + '</b><small>Anfrage bis fertig</small></div>' +
      '<div class="zahl" style="--farbe:var(--gruen)"><span>Eingenommen ' + j + '</span><b>' + eur(zufluss(j + '-01-01', j + '-12-31')) + '</b><small>nach Zahlungseingang</small></div>' +
      '</div><div class="zwei">' +
      '<section class="block"><h2>Offene Rechnungen <a href="#rechnungen" style="font-size:14px">Alle</a></h2>' +
      tabelle([['Nummer'], ['Kunde'], ['Datum', 'weg'], ['Betrag', 'r'], ['Stand']], offen.sort(function (a, b) { return String(a.faellig_am).localeCompare(String(b.faellig_am)); }).slice(0, 8).map(function (r) { return belegZeile(r, true); }), 'Keine offenen Rechnungen.', true) + '</section>' +
      '<section class="block"><h2>Aufträge <a href="#auftraege" style="font-size:14px">Alle</a></h2>' +
      tabelle([['Auftrag'], ['Stand']], laufend.slice(-8).reverse().map(function (a) {
        return '<tr data-href="auftrag/' + a.id + '"><td><a href="#auftrag/' + a.id + '">' + esc(a.titel || a.nummer) + '</a><span class="neben">' + esc(kundeName(kundeVon(a))) + '</span></td><td>' + auftragStand(a) + '</td></tr>';
      }), 'Keine laufenden Aufträge.', true) + '</section></div>');
    zeilenKlick();
  }

  /* ---------- Kunden ---------- */
  function offenBei(k) { return S.rechnungen.filter(function (r) { return r.kunde_id === k.id && r.typ === 'rechnung' && r.status === 'offen'; }).reduce(function (s, r) { return s + zahl(r.brutto); }, 0); }
  function ansichtKunden() {
    seite('Kunden', S.kunden.length + ' Kunden', '<a class="knopf klein" href="#kunde/neu">Neuer Kunde</a>',
      '<div class="filter"><input class="ein suche" type="search" id="suche" placeholder="Suchen nach Name, Ort, Nummer" aria-label="Kunden suchen"></div><section class="block" id="liste"></section>');
    var box = document.getElementById('liste');
    function malen(q) {
      q = (q || '').toLowerCase();
      var l = S.kunden.filter(function (k) { return !q || [kundeName(k), k.ort, k.nummer, k.email].join(' ').toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return kundeName(a).localeCompare(kundeName(b), 'de'); });
      box.innerHTML = tabelle([['Name'], ['Ort', 'weg'], ['Nummer', 'weg'], ['Offen', 'r']], l.map(function (k) {
        var o = offenBei(k);
        return '<tr data-href="kunde/' + k.id + '"><td><a href="#kunde/' + k.id + '">' + esc(kundeName(k)) + '</a>' + (k.firma && k.nachname ? '<span class="neben">' + esc(k.vorname + ' ' + k.nachname) + '</span>' : '') + '</td>' +
          '<td class="weg">' + esc(k.ort) + '</td><td class="weg">' + esc(k.nummer) + '</td><td class="r">' + (o ? eur(o) : '') + '</td></tr>';
      }), q ? 'Nichts gefunden.' : 'Noch keine Kunden. Leg den ersten mit „Neuer Kunde“ an.', true);
      zeilenKlick();
    }
    document.getElementById('suche').addEventListener('input', function (e) { malen(e.target.value); });
    malen('');
  }
  function ansichtKunde(id) {
    var neu = id === 'neu', k = neu ? { art: 'firma', land: 'Deutschland' } : per(S.kunden, id);
    if (!k) return nichtGefunden();
    var auftr = neu ? [] : S.auftraege.filter(function (a) { return a.kunde_id === k.id; });
    var bel = neu ? [] : S.rechnungen.filter(function (r) { return r.kunde_id === k.id; }).sort(function (a, b) { return String(b.datum).localeCompare(String(a.datum)); });
    var preise = neu ? [] : S.kundenpreise.filter(function (p) { return p.kunde_id === k.id; });
    seite(neu ? 'Neuer Kunde' : kundeName(k), neu ? '' : esc(k.nummer), neu ? '' :
      '<a class="knopf klein" href="#auftrag/neu?kunde=' + k.id + '">Neuer Auftrag</a><a class="knopf zweit klein" href="#beleg/neu-rechnung?kunde=' + k.id + '">Neue Rechnung</a>',
      '<a class="zurueck-link" href="#kunden">← Kunden</a>' +
      '<form class="block" id="form"><h2>Angaben</h2><div class="innen"><div class="felder">' +
      feld('art', 'Art', k.art, { art: 'select', optionen: [['firma', 'Firma'], ['verein', 'Verein'], ['privat', 'Privat']], breite: 'zwei-d' }) +
      feld('firma', 'Firma oder Verein', k.firma, { breite: 'ganz', auto: 'organization' }) +
      feld('vorname', 'Vorname', k.vorname, { auto: 'given-name' }) + feld('nachname', 'Nachname', k.nachname, { auto: 'family-name' }) +
      feld('strasse', 'Straße und Hausnummer', k.strasse, { breite: 'ganz', auto: 'street-address' }) +
      feld('plz', 'PLZ', k.plz, { breite: 'eins', modus: 'numeric', auto: 'postal-code' }) + feld('ort', 'Ort', k.ort, { breite: 'zwei-d', auto: 'address-level2' }) +
      feld('email', 'E-Mail', k.email, { art: 'email', auto: 'email' }) + feld('telefon', 'Telefon', k.telefon, { art: 'tel', auto: 'tel' }) +
      feld('notizen', 'Notizen', k.notizen, { art: 'textarea', breite: 'ganz' }) +
      '</div><div class="formfuss"><button class="knopf klein" type="submit">Speichern</button>' +
      (neu ? '' : '<button class="knopf gefahr klein" type="button" id="weg">Kunde löschen</button>') + '</div></div></form>' +
      (neu ? '' : '<div class="zwei"><section class="block"><h2>Aufträge</h2>' + tabelle([['Auftrag'], ['Stand']], auftr.map(function (a) {
        return '<tr data-href="auftrag/' + a.id + '"><td><a href="#auftrag/' + a.id + '">' + esc(a.titel || a.nummer) + '</a><span class="neben">' + esc(a.nummer) + '</span></td><td>' + auftragStand(a) + '</td></tr>';
      }), 'Noch keine Aufträge.', true) + '</section><section class="block"><h2>Rechnungen und Angebote</h2>' +
        tabelle([['Nummer'], ['Datum', 'weg'], ['Betrag', 'r'], ['Stand']], bel.map(function (r) { return belegZeile(r, false); }), 'Noch keine Belege.', true) + '</section></div>' +
        '<section class="block"><h2>Eigene Preise <button class="link-knopf" type="button" id="preis-neu">Preis festlegen</button></h2>' +
        (preise.length ? '<p class="block-zeile">Diese Preise gelten statt des Listenpreises, wenn du für ' + esc(kundeName(k)) + ' eine Leistung einfügst.</p>' : '') +
        tabelle([['Leistung'], ['Listenpreis', 'r weg'], ['Kundenpreis', 'r']], preise.map(function (p) {
          var l = per(S.leistungen, p.leistung_id);
          return '<tr data-preis="' + p.id + '" style="cursor:pointer"><td>' + esc(l ? l.name : 'Leistung gelöscht') + (p.bemerkung ? '<span class="neben">' + esc(p.bemerkung) + '</span>' : '') + '</td>' +
            '<td class="r weg">' + (l ? eur(l.preis) : '') + '</td><td class="r"><b>' + eur(p.preis) + '</b></td></tr>';
        }), 'Keine eigenen Preise. Es gelten die Listenpreise aus „Leistungen“.') + '</section>'));
    zeilenKlick();
    if (!neu) {
      document.getElementById('preis-neu').addEventListener('click', function () { kundenpreisBearbeiten(k, null); });
      inhalt.querySelectorAll('[data-preis]').forEach(function (tr) { tr.addEventListener('click', function () { kundenpreisBearbeiten(k, per(S.kundenpreise, tr.dataset.preis)); }); });
    }
    var form = document.getElementById('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var w = werteAus(form);
      if (!w.firma.trim() && !w.nachname.trim()) { hinweis('Bitte Firma oder Nachnamen eintragen.', true); return; }
      var obj = Object.assign({}, k, w);
      if (neu) obj.nummer = kundenNummer();
      speichern('kunden', obj).then(function (gesp) { hinweis('Gespeichert'); if (neu) location.hash = 'kunde/' + gesp.id; }).catch(fehler);
    });
    var weg = document.getElementById('weg');
    if (weg) weg.addEventListener('click', function () {
      if (bel.some(function (r) { return r.festgeschrieben; })) { hinweis('Dieser Kunde hat festgeschriebene Rechnungen und bleibt deshalb stehen.', true); return; }
      if (auftr.length) { hinweis('Bitte zuerst die Aufträge dieses Kunden löschen.', true); return; }
      frage('Kunde löschen?', kundeName(k) + ' wird entfernt.', 'Löschen', true).then(function (ok) {
        if (!ok) return;
        Promise.all(bel.map(function (r) { return loeschen('rechnungen', r.id); }).concat(preise.map(function (p) { return loeschen('kundenpreise', p.id); })))
          .then(function () { return Promise.all(S.ausgaben.filter(function (x) { return x.kunde_id === k.id; }).map(function (x) { return speichern('ausgaben', { id: x.id, kunde_id: null }); })); })
          .then(function () { return loeschen('kunden', k.id); })
          .then(function () { hinweis('Gelöscht'); location.hash = 'kunden'; }).catch(fehler);
      });
    });
  }

  function kundenpreisBearbeiten(k, p) {
    var neu = !p; p = p || { preis: '' };
    var vergeben = S.kundenpreise.filter(function (x) { return x.kunde_id === k.id && x !== p; }).map(function (x) { return x.leistung_id; });
    var wahl = S.leistungen.filter(function (l) { return (l.aktiv !== false && vergeben.indexOf(l.id) < 0) || l.id === p.leistung_id; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'de'); }).map(function (l) { return [l.id, l.name + ' (' + eur(l.preis) + ')']; });
    if (!wahl.length) { hinweis('Für alle Leistungen gibt es schon einen eigenen Preis.', true); return; }
    dialog({ titel: neu ? 'Eigenen Preis festlegen' : 'Eigenen Preis ändern', unter: kundeName(k),
      html: '<div class="felder">' + feld('leistung_id', 'Leistung', p.leistung_id || wahl[0][0], { art: 'select', optionen: wahl, breite: 'ganz' }) +
        feld('preis', 'Preis für diesen Kunden in Euro', p.preis === '' ? '' : komma(p.preis), { modus: 'decimal', pflicht: true }) +
        feld('bemerkung', 'Bemerkung', p.bemerkung, { hilfe: 'z. B. Rahmenvertrag 2027' }) + '</div>',
      knoepfe: (neu ? [] : [{ t: 'Löschen', w: 'weg', art: 'gefahr' }]).concat([{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Speichern', w: 'ok' }]) })
      .then(function (d) {
        if (d.wahl === 'weg') return loeschen('kundenpreise', p.id).then(function () { hinweis('Gelöscht'); route(); });
        if (d.wahl !== 'ok') return;
        if (String(d.werte.preis).trim() === '') throw new Error('Bitte einen Preis eintragen.');
        return speichern('kundenpreise', Object.assign({}, p, { kunde_id: k.id, leistung_id: Number(d.werte.leistung_id), preis: zahl(d.werte.preis), bemerkung: d.werte.bemerkung }))
          .then(function () { hinweis('Gespeichert'); route(); });
      }).catch(fehler);
  }

  /* ---------- Aufträge ---------- */
  var auftragFilter = 'laufend';
  function ansichtAuftraege() {
    seite('Aufträge', '', '<a class="knopf klein" href="#auftrag/neu">Neuer Auftrag</a>',
      '<div class="filter" id="filter">' + [['laufend', 'Laufend'], ['alle', 'Alle'], ['abgerechnet', 'Abgerechnet'], ['abgelehnt', 'Abgelehnt']].map(function (f) {
        return '<button type="button" data-f="' + f[0] + '" aria-pressed="' + (auftragFilter === f[0]) + '">' + f[1] + '</button>';
      }).join('') + '</div><section class="block" id="liste"></section>');
    function malen() {
      var l = S.auftraege.filter(function (a) {
        if (auftragFilter === 'alle') return true;
        if (auftragFilter === 'laufend') return ['anfrage', 'angebot', 'bearbeitung', 'fertig'].indexOf(a.status) >= 0;
        return a.status === auftragFilter;
      }).sort(function (a, b) { return b.id - a.id; });
      document.getElementById('liste').innerHTML = tabelle([['Auftrag'], ['Kunde', 'weg'], ['Summe', 'r'], ['Stand']], l.map(function (a) {
        return '<tr data-href="auftrag/' + a.id + '"><td><a href="#auftrag/' + a.id + '">' + esc(a.titel || 'Ohne Titel') + '</a><span class="neben">' + esc(a.nummer) + '</span></td>' +
          '<td class="weg">' + esc(kundeName(kundeVon(a))) + '</td><td class="r">' + eur(summen(a.posten).netto) + '</td><td>' + auftragStand(a) + '</td></tr>';
      }), 'Keine Aufträge in dieser Auswahl.', true);
      zeilenKlick();
    }
    document.getElementById('filter').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      auftragFilter = b.dataset.f;
      this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      malen();
    });
    malen();
  }
  function ansichtAuftrag(id, q) {
    var neu = id === 'neu';
    var a = neu ? { kunde_id: Number(q.kunde) || '', status: 'anfrage', posten: [], start: heute() } : per(S.auftraege, id);
    if (!a) return nichtGefunden();
    if (!S.kunden.length) {
      seite('Neuer Auftrag', '', '', '<div class="info warn">Ein Auftrag gehört immer zu einem Kunden. Leg zuerst einen Kunden an.</div><a class="knopf klein" href="#kunde/neu">Neuer Kunde</a>');
      return;
    }
    var posten = JSON.parse(JSON.stringify(a.posten || []));
    var belege = neu ? [] : S.rechnungen.filter(function (r) { return r.auftrag_id === a.id; });
    var offenePosten = function () { return posten.filter(function (p) { return !p.rechnung_id; }); };
    var zeiten = neu ? [] : zeitenVon(a);
    var auslagen = neu ? [] : auslagenVon(a);
    var std = zeiten.reduce(function (s, z) { return s + zahl(z.stunden); }, 0);
    var stdOffen = zeiten.reduce(function (s, z) { return z.rechnung_id ? s : s + zahl(z.stunden); }, 0);
    seite(neu ? 'Neuer Auftrag' : (a.titel || 'Auftrag'), neu ? '' : esc(a.nummer) + ' · ' + esc(kundeName(kundeVon(a))), '',
      '<a class="zurueck-link" href="#auftraege">← Aufträge</a>' +
      '<form class="block" id="form"><h2>Auftrag</h2><div class="innen"><div class="felder">' +
      feld('titel', 'Titel', a.titel, { breite: 'ganz', pflicht: true }) +
      feld('kunde_id', 'Kunde', a.kunde_id, { art: 'select', optionen: kundenOptionen('Bitte wählen') }) +
      feld('status', 'Stand', a.status, { art: 'select', optionen: Object.keys(AUFTRAG_STAND).map(function (s) { return [s, AUFTRAG_STAND[s]]; }) }) +
      feld('start', 'Beginn', a.start, { art: 'date', breite: 'zwei-d' }) + feld('ende', 'Ende oder Termin', a.ende, { art: 'date', breite: 'zwei-d' }) +
      feld('stundensatz', 'Stundensatz in Euro', a.stundensatz ? komma(a.stundensatz) : '', { breite: 'zwei-d', modus: 'decimal', hilfe: 'Für gebuchte Zeiten. Leer lassen, wenn nur Positionen zählen.' }) +
      feld('beschreibung', 'Beschreibung', a.beschreibung, { art: 'textarea', breite: 'ganz' }) +
      '</div></div></form>' +
      '<section class="block"><h2>Positionen</h2><div class="innen" id="posten"></div></section>' +
      '<div class="formfuss" style="margin:-4px 0 28px"><button class="knopf klein" type="button" id="sichern">Speichern</button>' +
      (neu ? '' : '<button class="knopf zweit klein" type="button" id="angebot">Angebot erstellen</button><button class="knopf zweit klein" type="button" id="rechnung">Rechnung erstellen</button><button class="knopf gefahr klein" type="button" id="weg">Auftrag löschen</button>') + '</div>' +
      (neu ? '' : '<div class="zwei"><section class="block"><h2>Zeiten <button class="link-knopf" type="button" id="zeit-neu">Zeit buchen</button></h2>' +
        (zeiten.length ? '<p class="block-zeile">' + komma(std) + ' Std. gebucht' + (stdOffen !== std ? ', davon ' + komma(stdOffen) + ' noch nicht abgerechnet' : '') +
          (zahl(a.stundensatz) ? ' · ' + eur(stdOffen * zahl(a.stundensatz)) + ' offen' : stdOffen ? ' · Ohne Stundensatz kommen sie nicht auf die Rechnung.' : '') + '</p>' : '') +
        tabelle([['Datum'], ['Was'], ['Std.', 'r']], zeiten.map(function (z) {
          return '<tr data-zeit="' + z.id + '" style="cursor:pointer"><td>' + datum(z.datum) + '</td><td>' + esc(z.beschreibung || 'Arbeitszeit') + (z.rechnung_id ? '<span class="neben">abgerechnet</span>' : '') + '</td><td class="r">' + komma(z.stunden) + '</td></tr>';
        }), 'Noch keine Zeiten gebucht.') + '</section>' +
        '<section class="block"><h2>Auslagen <button class="link-knopf" type="button" id="auslage-neu">Auslage erfassen</button></h2>' +
        tabelle([['Datum'], ['Was'], ['Betrag', 'r']], auslagen.map(function (x) {
          return '<tr data-auslage="' + x.id + '" style="cursor:pointer"><td>' + datum(x.datum) + '</td><td>' + esc(x.beschreibung || x.kategorie) +
            '<span class="neben">' + (x.weiterberechnen ? (x.rechnung_id ? 'weiterberechnet' : 'wird weiterberechnet') : 'nur Ausgabe') + (x.datei ? ' · mit Beleg' : '') + '</span></td><td class="r">' + eur(x.betrag) + '</td></tr>';
        }), 'Keine Auslagen.') + '</section></div>' +
        '<section class="block"><h2>Belege zu diesem Auftrag</h2>' + tabelle([['Nummer'], ['Datum', 'weg'], ['Betrag', 'r'], ['Stand']], belege.map(function (r) { return belegZeile(r, false); }), 'Noch keine Angebote oder Rechnungen.', true) + '</section>'));
    zeilenKlick();
    var box = document.getElementById('posten');
    function zeichnen() { box.innerHTML = postenEditor(posten, false); }
    var lesen = postenBinden(box, posten, zeichnen, function () { return document.getElementById('f-kunde_id').value; });
    zeichnen();
    var form = document.getElementById('form');
    function sichern() {
      lesen();
      var w = werteAus(form);
      if (!w.titel.trim()) return Promise.reject(new Error('Bitte einen Titel eintragen.'));
      if (!w.kunde_id) return Promise.reject(new Error('Bitte einen Kunden wählen.'));
      var obj = Object.assign({}, a, w, { kunde_id: Number(w.kunde_id), posten: posten, stundensatz: zahl(w.stundensatz) });
      if (neu) obj.nummer = auftragsNummer();
      return speichern('auftraege', obj).then(function (g) { a = g; return g; });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    document.getElementById('sichern').addEventListener('click', function () {
      sichern().then(function (g) { hinweis('Gespeichert'); if (neu) location.hash = 'auftrag/' + g.id; }).catch(fehler);
    });
    if (neu) return;
    document.getElementById('zeit-neu').addEventListener('click', function () { zeitBearbeiten(a, null); });
    inhalt.querySelectorAll('[data-zeit]').forEach(function (tr) { tr.addEventListener('click', function () { zeitBearbeiten(a, per(S.zeiten, tr.dataset.zeit)); }); });
    document.getElementById('auslage-neu').addEventListener('click', function () { bewegungBearbeiten('ausgaben', null, { auftrag_id: a.id, weiterberechnen: true }); });
    inhalt.querySelectorAll('[data-auslage]').forEach(function (tr) { tr.addEventListener('click', function () { bewegungBearbeiten('ausgaben', per(S.ausgaben, tr.dataset.auslage)); }); });
    document.getElementById('angebot').addEventListener('click', function () {
      sichern().then(function (g) {
        if (!g.posten.length) throw new Error('Für ein Angebot braucht der Auftrag Positionen.');
        return neuerBeleg('angebot', g.kunde_id, g.id, g.posten.map(function (p) { return { bezeichnung: p.bezeichnung, menge: p.menge, einheit: p.einheit, einzelpreis: p.einzelpreis }; }), g.titel);
      }).then(function (r) { if (a.status === 'anfrage') { a.status = 'angebot'; return speichern('auftraege', a).then(function () { return r; }); } return r; })
        .then(function (r) { location.hash = 'beleg/' + r.id; }).catch(fehler);
    });
    document.getElementById('rechnung').addEventListener('click', function () {
      sichern().then(function (g) {
        var offen = offenePosten();
        var p = offen.map(function (x) { return { bezeichnung: x.bezeichnung, menge: x.menge, einheit: x.einheit, einzelpreis: x.einzelpreis, ap: x.id }; });
        // Nicht abgerechnete Stunden mit dem Stundensatz des Auftrags, wie am Mac
        var zOffen = zahl(g.stundensatz) > 0 ? zeitenVon(g).filter(function (z) { return !z.rechnung_id; }) : [];
        var stunden = rund(zOffen.reduce(function (s, z) { return s + zahl(z.stunden); }, 0));
        if (stunden) p.push({ bezeichnung: 'Arbeitszeit ' + (g.titel || g.nummer), menge: stunden, einheit: 'Stunde', einzelpreis: zahl(g.stundensatz) });
        var aOffen = auslagenVon(g).filter(function (x) { return x.weiterberechnen && !x.rechnung_id; });
        aOffen.forEach(function (x) { p.push({ bezeichnung: 'Auslage: ' + (x.beschreibung || x.kategorie), menge: 1, einheit: 'Pauschale', einzelpreis: zahl(x.betrag) }); });
        if (!p.length) throw new Error(posten.length ? 'Aus diesem Auftrag ist schon alles abgerechnet. Trag neue Positionen ein oder buche Zeiten.' : 'Der Auftrag hat noch keine Positionen, Zeiten oder Auslagen.');
        return neuerBeleg('rechnung', g.kunde_id, g.id, p, g.titel)
          .then(function (r) {
            // Was auf einer Rechnung steht, gilt als abgerechnet und wird nicht noch einmal berechnet
            offen.forEach(function (x) { x.rechnung_id = r.id; });
            a.posten = posten;
            if (posten.every(function (x) { return x.rechnung_id; })) a.status = 'abgerechnet';
            return Promise.all(zOffen.map(function (z) { return speichern('zeiten', { id: z.id, rechnung_id: r.id }); })
              .concat(aOffen.map(function (x) { return speichern('ausgaben', { id: x.id, rechnung_id: r.id }); })))
              .then(function () { return speichern('auftraege', a); }).then(function () { return r; });
          });
      }).then(function (r) { location.hash = 'beleg/' + r.id; }).catch(fehler);
    });
    document.getElementById('weg').addEventListener('click', function () {
      if (belege.length) { hinweis('Zu diesem Auftrag gibt es Belege. Er bleibt stehen; setz ihn stattdessen auf „Abgelehnt“ oder „Abgerechnet“.', true); return; }
      frage('Auftrag löschen?', (a.titel || a.nummer) + ' wird entfernt.', 'Löschen', true).then(function (ok) {
        if (!ok) return;
        Promise.all(zeiten.map(function (z) { return loeschen('zeiten', z.id); }).concat(auslagen.map(function (x) { return speichern('ausgaben', { id: x.id, auftrag_id: null, weiterberechnen: false }); })))
          .then(function () { return loeschen('auftraege', a.id); }).then(function () { hinweis('Gelöscht'); location.hash = 'auftraege'; }).catch(fehler);
      });
    });
  }

  /* ---------- Zeiterfassung ---------- */
  function zeitenVon(a) { return S.zeiten.filter(function (z) { return z.auftrag_id === a.id; }).sort(function (x, y) { return String(y.datum).localeCompare(String(x.datum)) || y.id - x.id; }); }
  function auslagenVon(a) { return S.ausgaben.filter(function (x) { return x.auftrag_id === a.id; }).sort(function (x, y) { return String(y.datum).localeCompare(String(x.datum)); }); }
  function zeitBearbeiten(a, z) {
    var neu = !z; z = z || { datum: heute(), stunden: '' };
    if (z.rechnung_id) {
      var rg = per(S.rechnungen, z.rechnung_id);
      hinweis('Diese Zeit steht schon auf ' + (rg && rg.nummer ? 'Rechnung ' + rg.nummer : 'einem Rechnungsentwurf') + ' und bleibt deshalb, wie sie ist.', true);
      return;
    }
    dialog({ titel: neu ? 'Zeit buchen' : 'Zeit ändern', unter: a.titel || a.nummer,
      html: '<div class="felder">' + feld('datum', 'Datum', z.datum, { art: 'date' }) +
        feld('stunden', 'Stunden', z.stunden === '' ? '' : komma(z.stunden), { modus: 'decimal', pflicht: true, hilfe: 'z. B. 1,5 für anderthalb Stunden' }) +
        feld('beschreibung', 'Was wurde gemacht?', z.beschreibung, { breite: 'ganz' }) + '</div>',
      knoepfe: (neu ? [] : [{ t: 'Löschen', w: 'weg', art: 'gefahr' }]).concat([{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Speichern', w: 'ok' }]) })
      .then(function (d) {
        if (d.wahl === 'weg') return loeschen('zeiten', z.id).then(function () { hinweis('Gelöscht'); route(); });
        if (d.wahl !== 'ok') return;
        var std = zahl(d.werte.stunden);
        if (std <= 0) throw new Error('Bitte die Stunden eintragen.');
        return speichern('zeiten', Object.assign({}, z, d.werte, { auftrag_id: a.id, stunden: rund(std) })).then(function () { hinweis('Gebucht'); route(); });
      }).catch(fehler);
  }

  /* ---------- Rechnungen und Angebote ---------- */
  function neuerBeleg(typ, kundeId, auftragId, posten, titel) {
    var ziel = zahl(S.e.zahlungsziel) || 14;
    var r = {
      typ: typ, nummer: '', kunde_id: kundeId || null, auftrag_id: auftragId || null, datum: heute(), leistungsdatum: '',
      zahlungsziel: ziel, status: 'entwurf', festgeschrieben: false,
      posten: (posten || []).map(function (p) { return Object.assign({ id: uid() }, p); }),
      kopftext: typ === 'angebot'
        ? 'Vielen Dank für Ihre Anfrage' + (titel ? ' zu „' + titel + '“' : '') + '. Gerne biete ich Ihnen Folgendes an:'
        : 'Für meine Leistungen' + (titel ? ' im Auftrag „' + titel + '“' : '') + ' berechne ich Ihnen:',
      fusstext: typ === 'angebot' ? 'Das Angebot gilt 30 Tage ab Datum.' : (S.e.fusstext || '')
    };
    Object.assign(r, summen(r.posten));
    return speichern('rechnungen', r);
  }
  var belegFilter = { rechnung: 'alle', angebot: 'alle' };
  function ansichtBelege(typ) {
    var istR = typ === 'rechnung';
    var filter = istR ? [['alle', 'Alle'], ['entwurf', 'Entwürfe'], ['offen', 'Offen'], ['ueberfaellig', 'Überfällig'], ['bezahlt', 'Bezahlt'], ['storniert', 'Storniert']]
      : [['alle', 'Alle'], ['entwurf', 'Entwürfe'], ['offen', 'Verschickt'], ['angenommen', 'Angenommen'], ['abgelehnt', 'Abgelehnt']];
    seite(istR ? 'Rechnungen' : 'Angebote', '', '<a class="knopf klein" href="#beleg/neu-' + typ + '">' + (istR ? 'Neue Rechnung' : 'Neues Angebot') + '</a>',
      '<div class="filter" id="filter">' + filter.map(function (f) { return '<button type="button" data-f="' + f[0] + '" aria-pressed="' + (belegFilter[typ] === f[0]) + '">' + f[1] + '</button>'; }).join('') + '</div>' +
      '<section class="block" id="liste"></section>');
    function malen() {
      var f = belegFilter[typ];
      var l = S.rechnungen.filter(function (r) { return istR ? r.typ !== 'angebot' : r.typ === 'angebot'; }).filter(function (r) {
        if (f === 'alle') return true;
        var s = standVon(r).k;
        if (f === 'offen') return s === 'offen' || s === 'ueberfaellig';
        return s === f;
      }).sort(function (a, b) { return String(b.datum).localeCompare(String(a.datum)) || b.id - a.id; });
      document.getElementById('liste').innerHTML = tabelle([['Nummer'], ['Kunde'], ['Datum', 'weg'], ['Betrag', 'r'], ['Stand']], l.map(function (r) { return belegZeile(r, true); }),
        'Nichts in dieser Auswahl.', true);
      zeilenKlick();
    }
    document.getElementById('filter').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      belegFilter[typ] = b.dataset.f;
      this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      malen();
    });
    malen();
  }
  function ansichtBeleg(id, q) {
    if (id === 'neu-rechnung' || id === 'neu-angebot') {
      if (!S.kunden.length) { seite('Neuer Beleg', '', '', '<div class="info warn">Ein Beleg geht immer an einen Kunden. Leg zuerst einen Kunden an.</div><a class="knopf klein" href="#kunde/neu">Neuer Kunde</a>'); return; }
      neuerBeleg(id.slice(4), Number(q.kunde) || null, null, [{ bezeichnung: '', menge: 1, einheit: 'Stück', einzelpreis: 0 }])
        .then(function (r) { location.replace('#beleg/' + r.id); }).catch(fehler);
      return;
    }
    var r = per(S.rechnungen, id);
    if (!r) return nichtGefunden();
    var istA = r.typ === 'angebot', name = istA ? 'Angebot' : (r.typ === 'storno' ? 'Stornorechnung' : 'Rechnung');
    if (!r.festgeschrieben) return belegEntwurf(r, istA, name);
    var k = kundeVon(r), s = standVon(r);
    var storno = r.storniert_durch ? per(S.rechnungen, r.storniert_durch) : null, orig = r.storno_von ? per(S.rechnungen, r.storno_von) : null;
    var akt = '<button class="knopf klein" type="button" id="drucken">Drucken oder als PDF</button>';
    if (!istA && r.typ === 'rechnung' && r.status === 'offen') akt += '<button class="knopf zweit klein" type="button" id="bezahlt">Als bezahlt markieren</button>';
    var stufe = Number(r.mahnstufe) || 0;
    if (!istA && r.typ === 'rechnung' && r.status === 'offen' && stufe < 3) akt += '<button class="knopf zweit klein" type="button" id="mahnen">' + MAHNTITEL[stufe + 1] + ' erstellen</button>';
    if (!istA && r.typ === 'rechnung' && stufe > 0) akt += '<button class="knopf zweit klein" type="button" id="mahnung-druck">' + MAHNTITEL[stufe] + ' drucken</button>';
    if (!istA && r.typ === 'rechnung' && r.status === 'bezahlt') akt += '<button class="knopf zweit klein" type="button" id="unbezahlt">Zahlung zurücknehmen</button>';
    if (!istA && r.typ === 'rechnung' && r.status !== 'storniert') akt += '<button class="knopf gefahr klein" type="button" id="storno">Stornieren</button>';
    if (istA && r.status === 'offen') akt += '<button class="knopf zweit klein" type="button" id="an">Angenommen</button><button class="knopf zweit klein" type="button" id="ab">Abgelehnt</button>';
    if (istA && r.status !== 'abgelehnt') akt += '<button class="knopf zweit klein" type="button" id="zurechnung">In Rechnung umwandeln</button>';
    seite(name + ' ' + r.nummer, esc(kundeName(k)) + ' · ' + standHtml(r), '',
      '<a class="zurueck-link" href="#' + (istA ? 'angebote' : 'rechnungen') + '">← ' + (istA ? 'Angebote' : 'Rechnungen') + '</a>' +
      '<div class="info' + (s.k === 'bezahlt' ? ' gut' : s.k === 'ueberfaellig' ? ' warn' : '') + '">' +
      (istA ? 'Festgeschrieben am ' + datum(r.festgeschrieben_am) + '.' :
        'Festgeschrieben am ' + datum(r.festgeschrieben_am) + '. Änderungen sind nur noch über ein Storno mit eigener Nummer möglich.') +
      (r.bezahlt_am ? ' ' + (zahl(r.bezahlt_betrag) < 0 ? 'Erstattet' : 'Bezahlt') + ' am ' + datum(r.bezahlt_am) + ': ' + eur(r.bezahlt_betrag) + '.' : '') +
      (r.status === 'offen' && r.faellig_am && !istA ? ' Fällig am ' + datum(r.faellig_am) + '.' : '') +
      (stufe ? ' ' + MAHNTITEL[stufe] + ' verschickt am ' + datum(r.mahnung_am) + '.' : '') +
      (storno ? ' Storniert durch <a href="#beleg/' + storno.id + '">' + esc(storno.nummer) + '</a>.' : '') +
      (orig ? ' Storno zu <a href="#beleg/' + orig.id + '">' + esc(orig.nummer) + '</a>.' : '') +
      (r.auftrag_id ? ' Auftrag: <a href="#auftrag/' + r.auftrag_id + '">' + esc((per(S.auftraege, r.auftrag_id) || {}).nummer || 'öffnen') + '</a>.' : '') +
      '</div><div class="formfuss" style="margin:0 0 20px">' + akt + '</div><div class="vorschau" id="vorschau">' + blatt(r) + '</div>');
    vorschauEinpassen();
    var $ = function (x) { return document.getElementById(x); };
    $('drucken').addEventListener('click', function () { drucken(r); });
    if ($('bezahlt')) $('bezahlt').addEventListener('click', function () {
      dialog({ titel: 'Zahlung eintragen', unter: name + ' ' + r.nummer + ' über ' + eur(r.brutto),
        html: '<div class="felder">' + feld('am', 'Eingegangen am', heute(), { art: 'date' }) + feld('betrag', 'Betrag', komma(r.brutto), { modus: 'decimal' }) + '</div>' })
        .then(function (d) {
          if (d.wahl !== 'ok') return;
          return speichern('rechnungen', { id: r.id, status: 'bezahlt', bezahlt_am: d.werte.am || heute(), bezahlt_betrag: zahl(d.werte.betrag) })
            .then(function () { hinweis('Als bezahlt eingetragen'); route(); });
        }).catch(fehler);
    });
    if ($('unbezahlt')) $('unbezahlt').addEventListener('click', function () {
      frage('Zahlung zurücknehmen?', 'Die Rechnung gilt danach wieder als offen.', 'Zurücknehmen').then(function (ok) {
        if (ok) speichern('rechnungen', { id: r.id, status: 'offen', bezahlt_am: null, bezahlt_betrag: 0 }).then(function () { hinweis('Wieder offen'); route(); }).catch(fehler);
      });
    });
    if ($('storno')) $('storno').addEventListener('click', function () { stornieren(r); });
    if ($('mahnung-druck')) $('mahnung-druck').addEventListener('click', function () { drucken(r, true); });
    if ($('mahnen')) $('mahnen').addEventListener('click', function () {
      var neu = stufe + 1, frueh = r.faellig_am && r.faellig_am >= heute();
      dialog({ titel: MAHNTITEL[neu] + ' zu ' + r.nummer + '?', html: '<p style="margin:0 0 10px">Die Rechnung bekommt den Vermerk „' + MAHNTITEL[neu] + '“ mit heutigem Datum. Danach öffnet sich das Schreiben zum Drucken oder als PDF.</p>' +
          (neu >= 2 ? '<p style="margin:0 0 10px">Ab dieser Stufe kommen Verzugszinsen von ' + komma(S.e.verzugszins) + ' % im Jahr dazu.</p>' : '') +
          (frueh ? '<div class="info warn" style="margin:0">Die Rechnung ist erst am ' + datum(r.faellig_am) + ' fällig.</div>' : ''),
        knoepfe: [{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Erstellen', w: 'ok' }] })
        .then(function (d) {
          if (d.wahl !== 'ok') return;
          return speichern('rechnungen', { id: r.id, mahnstufe: neu, mahnung_am: heute() }).then(function (g) {
            hinweis(MAHNTITEL[neu] + ' eingetragen'); route(); drucken(g, true);
          });
        }).catch(fehler);
    });
    if ($('an')) $('an').addEventListener('click', function () { speichern('rechnungen', { id: r.id, status: 'angenommen' }).then(function () { hinweis('Angebot angenommen'); route(); }).catch(fehler); });
    if ($('ab')) $('ab').addEventListener('click', function () { speichern('rechnungen', { id: r.id, status: 'abgelehnt' }).then(function () { hinweis('Angebot abgelehnt'); route(); }).catch(fehler); });
    if ($('zurechnung')) $('zurechnung').addEventListener('click', function () {
      var p = r.posten.map(function (x) { return { bezeichnung: x.bezeichnung, menge: x.menge, einheit: x.einheit, einzelpreis: x.einzelpreis }; });
      var schritt = r.status === 'offen' ? speichern('rechnungen', { id: r.id, status: 'angenommen' }) : Promise.resolve();
      schritt.then(function () { return neuerBeleg('rechnung', r.kunde_id, r.auftrag_id, p, null); })
        .then(function (neu) { hinweis('Rechnungsentwurf angelegt'); location.hash = 'beleg/' + neu.id; }).catch(fehler);
    });
  }
  function belegEntwurf(r, istA, name) {
    var posten = JSON.parse(JSON.stringify(r.posten || []));
    seite(name + ' (Entwurf)', 'Frei änderbar, bis du festschreibst.', '',
      '<a class="zurueck-link" href="#' + (istA ? 'angebote' : 'rechnungen') + '">← ' + (istA ? 'Angebote' : 'Rechnungen') + '</a>' +
      '<form class="block" id="form"><h2>Angaben</h2><div class="innen"><div class="felder">' +
      feld('kunde_id', 'Kunde', r.kunde_id || '', { art: 'select', optionen: kundenOptionen('Bitte wählen'), breite: 'ganz' }) +
      feld('datum', istA ? 'Angebotsdatum' : 'Rechnungsdatum', r.datum, { art: 'date', breite: 'zwei-d' }) +
      (istA ? '' : feld('leistungsdatum', 'Leistungsdatum oder Zeitraum', r.leistungsdatum, { breite: 'zwei-d', hilfe: 'z. B. 12.11.2026 oder November 2026' }) +
        feld('zahlungsziel', 'Zahlungsziel in Tagen', r.zahlungsziel, { art: 'number', breite: 'zwei-d', modus: 'numeric' })) +
      feld('kopftext', 'Text über den Positionen', r.kopftext, { art: 'textarea', breite: 'ganz', zeilen: 2 }) +
      '</div></div></form>' +
      '<section class="block"><h2>Positionen</h2><div class="innen" id="posten"></div></section>' +
      '<section class="block"><h2>Schluss</h2><div class="innen"><div class="felder">' + feld('fusstext', 'Text unter den Positionen', r.fusstext, { art: 'textarea', breite: 'ganz', zeilen: 2 }) + '</div></div></section>' +
      '<div class="formfuss" style="margin-top:-4px"><button class="knopf klein" type="button" id="sichern">Speichern</button>' +
      '<button class="knopf zweit klein" type="button" id="ansehen">Vorschau</button>' +
      '<button class="knopf zweit klein" type="button" id="fest">Festschreiben</button>' +
      '<button class="knopf gefahr klein" type="button" id="weg">Entwurf löschen</button></div>');
    var box = document.getElementById('posten');
    function zeichnen() { box.innerHTML = postenEditor(posten, false); }
    var lesen = postenBinden(box, posten, zeichnen, function () { return document.getElementById('f-kunde_id').value; });
    zeichnen();
    var form = document.getElementById('form');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    function stand() {
      lesen();
      var w = werteAus(form), fs = document.getElementById('f-fusstext');
      var o = Object.assign({}, r, w, { kunde_id: w.kunde_id ? Number(w.kunde_id) : null, posten: posten, fusstext: fs.value });
      if (!istA) { o.zahlungsziel = zahl(w.zahlungsziel); }
      return Object.assign(o, summen(posten));
    }
    function sichern() { return speichern('rechnungen', stand()).then(function (g) { r = g; return g; }); }
    document.getElementById('sichern').addEventListener('click', function () { sichern().then(function () { hinweis('Gespeichert'); }).catch(fehler); });
    document.getElementById('ansehen').addEventListener('click', function () {
      var vor = stand();
      dialog({ titel: 'Vorschau', html: '<div class="vorschau" id="vorschau">' + blatt(vor) + '</div>', knoepfe: [{ t: 'Schließen', w: '', art: 'zweit' }],
        nachher: function () { setTimeout(vorschauEinpassen, 0); } });
    });
    document.getElementById('fest').addEventListener('click', function () {
      var o = stand();
      if (!o.kunde_id) { hinweis('Bitte einen Kunden wählen.', true); return; }
      if (!o.posten.length || o.posten.some(function (p) { return !String(p.bezeichnung).trim(); })) { hinweis('Jede Position braucht eine Bezeichnung.', true); return; }
      if (!istA && !o.leistungsdatum) { hinweis('Bitte das Leistungsdatum eintragen. Es gehört auf jede Rechnung.', true); return; }
      if (!istA && !S.e.firma_steuernummer && !S.e.firma_ust_id) { hinweis('In den Einstellungen fehlt die Steuernummer. Sie muss auf jede Rechnung.', true); return; }
      frage(name + ' festschreiben?', 'Danach bekommt der Beleg seine Nummer und lässt sich nicht mehr ändern.' + (istA ? '' : ' Korrekturen gehen dann nur noch über ein Storno.'), 'Festschreiben').then(function (ok) {
        if (!ok) return;
        var k = per(S.kunden, o.kunde_id);
        Object.assign(o, {
          nummer: belegNummer(r.typ, o.datum), festgeschrieben: true, festgeschrieben_am: heute(), status: 'offen',
          faellig_am: istA ? null : plusTage(o.datum, zahl(o.zahlungsziel)),
          // Anschriften so festhalten, wie sie heute sind: spätere Änderungen am Kunden ändern den Beleg nicht
          empfaenger: anschrift(k), absender: absenderJetzt(), kleinunternehmer: istKlein()
        });
        speichern('rechnungen', o).then(function () { hinweis(name + ' ' + o.nummer + ' festgeschrieben'); route(); }).catch(fehler);
      });
    });
    document.getElementById('weg').addEventListener('click', function () {
      frage('Entwurf löschen?', 'Der Entwurf wird entfernt. Abgerechnete Positionen im Auftrag werden wieder freigegeben.', 'Löschen', true).then(function (ok) {
        if (!ok) return;
        auftragFreigeben(r).then(function () { return loeschen('rechnungen', r.id); })
          .then(function () { hinweis('Entwurf gelöscht'); location.hash = istA ? 'angebote' : 'rechnungen'; }).catch(fehler);
      });
    });
  }
  /* Positionen im Auftrag wieder auf „offen“ setzen, wenn ihre Rechnung wegfällt (Entwurf gelöscht oder storniert). */
  function auftragFreigeben(r) {
    if (r.typ === 'angebot') return Promise.resolve();
    var schritte = S.zeiten.filter(function (z) { return z.rechnung_id === r.id; }).map(function (z) { return speichern('zeiten', { id: z.id, rechnung_id: null }); })
      .concat(S.ausgaben.filter(function (x) { return x.rechnung_id === r.id; }).map(function (x) { return speichern('ausgaben', { id: x.id, rechnung_id: null }); }));
    var a = r.auftrag_id ? per(S.auftraege, r.auftrag_id) : null;
    var geaendert = false;
    if (a) (a.posten || []).forEach(function (p) { if (p.rechnung_id === r.id) { p.rechnung_id = null; geaendert = true; } });
    if (geaendert && a.status === 'abgerechnet') a.status = 'fertig';
    if (geaendert) schritte.push(speichern('auftraege', a));
    return Promise.all(schritte);
  }
  function stornieren(r) {
    var bezahlt = r.status === 'bezahlt';
    dialog({ titel: 'Rechnung ' + r.nummer + ' stornieren?',
      html: '<p style="margin:0 0 14px">Es entsteht eine Stornorechnung mit eigener Nummer und negativen Beträgen. Die Rechnung ' + esc(r.nummer) + ' bleibt unverändert erhalten.</p>' +
        (bezahlt ? '<div class="felder">' + feld('erstattet', 'Betrag erstattet am', heute(), { art: 'date', breite: 'ganz', hilfe: 'Die Rechnung war bezahlt. Die Erstattung zählt an diesem Tag als negative Einnahme.' }) + '</div>' : ''),
      knoepfe: [{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Stornieren', w: 'ok', art: 'gefahr' }] })
      .then(function (d) {
        if (d.wahl !== 'ok') return;
        var st = {
          typ: 'storno', kunde_id: r.kunde_id, auftrag_id: r.auftrag_id, datum: heute(), leistungsdatum: r.leistungsdatum,
          zahlungsziel: 0, status: 'storniert', festgeschrieben: true, festgeschrieben_am: heute(), storno_von: r.id,
          nummer: belegNummer('storno'), empfaenger: r.empfaenger, absender: absenderJetzt(), kleinunternehmer: r.kleinunternehmer,
          posten: r.posten.map(function (p) { return { id: uid(), bezeichnung: p.bezeichnung, menge: -zahl(p.menge), einheit: p.einheit, einzelpreis: p.einzelpreis }; }),
          kopftext: 'Hiermit stornieren wir die Rechnung ' + r.nummer + ' vom ' + datum(r.datum) + '.', fusstext: '',
          netto: -zahl(r.netto), steuer: -zahl(r.steuer), brutto: -zahl(r.brutto),
          bezahlt_am: bezahlt ? (d.werte.erstattet || heute()) : null, bezahlt_betrag: bezahlt ? -zahl(r.bezahlt_betrag) : 0
        };
        return speichern('rechnungen', st).then(function (neu) {
          return speichern('rechnungen', { id: r.id, status: 'storniert', storniert_durch: neu.id })
            .then(function () { return auftragFreigeben(r); })
            .then(function () { hinweis('Storniert mit ' + neu.nummer); location.hash = 'beleg/' + neu.id; });
        });
      }).catch(fehler);
  }

  /* ---------- Das A4-Blatt ---------- */
  function anschrift(k) {
    if (!k) return '';
    return [k.firma, ((k.vorname || '') + ' ' + (k.nachname || '')).trim(), k.strasse, ((k.plz || '') + ' ' + (k.ort || '')).trim(), k.land && k.land !== 'Deutschland' ? k.land : '']
      .filter(Boolean).join('\n');
  }
  function absenderJetzt() {
    var e = S.e;
    return { name: e.firma_name, inhaber: e.firma_inhaber, strasse: e.firma_strasse, plz: e.firma_plz, ort: e.firma_ort, email: e.firma_email, telefon: e.firma_telefon,
      web: e.firma_web, steuernummer: e.firma_steuernummer, ust_id: e.firma_ust_id, bank_name: e.bank_name, bank_inhaber: e.bank_inhaber, iban: e.bank_iban, bic: e.bank_bic, hinweis_19: e.hinweis_19 };
  }
  function girocode(a, betrag, zweck) {
    if (!window.qrcode || !a.iban || betrag <= 0) return '';
    var daten = ['BCD', '002', '1', 'SCT', (a.bic || '').replace(/\s/g, ''), (a.bank_inhaber || a.inhaber || a.name || '').slice(0, 70),
      (a.iban || '').replace(/\s/g, '').toUpperCase(), 'EUR' + betrag.toFixed(2), '', '', zweck.slice(0, 140)].join('\n');
    var q = window.qrcode(0, 'M'); q.addData(daten); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  function blatt(r) {
    var a = r.absender || absenderJetzt();
    var klein = r.kleinunternehmer != null ? r.kleinunternehmer : istKlein();
    var emp = r.empfaenger || anschrift(kundeVon(r));
    var istA = r.typ === 'angebot';
    var titel = istA ? 'Angebot' : r.typ === 'storno' ? 'Stornorechnung' : 'Rechnung';
    var zweck = (titel + ' ' + (r.nummer || '')).trim();
    var s = { netto: zahl(r.netto), steuer: zahl(r.steuer), brutto: zahl(r.brutto) };
    var zeilen = (r.posten || []).map(function (p, i) {
      var teile = String(p.bezeichnung || '').split('\n');
      return '<tr><td>' + (i + 1) + '</td><td><b style="font-weight:600">' + esc(teile[0]) + '</b>' + (teile.length > 1 ? '<br><span style="color:#6b737a">' + esc(teile.slice(1).join(' ')) + '</span>' : '') + '</td>' +
        '<td class="r">' + komma(p.menge) + ' ' + esc(p.einheit) + '</td><td class="r">' + eur(p.einzelpreis) + '</td><td class="r">' + eur(postenSumme(p)) + '</td></tr>';
    }).join('');
    var summe = klein ? '<tr class="b-summe"><td colspan="4" class="r">Gesamtbetrag</td><td class="r">' + eur(s.brutto) + '</td></tr>'
      : '<tr><td colspan="4" class="r">Nettobetrag</td><td class="r">' + eur(s.netto) + '</td></tr><tr><td colspan="4" class="r">Umsatzsteuer</td><td class="r">' + eur(s.steuer) + '</td></tr>' +
        '<tr class="b-summe"><td colspan="4" class="r">Gesamtbetrag</td><td class="r">' + eur(s.brutto) + '</td></tr>';
    var zahlung = '';
    if (!istA && r.typ !== 'storno' && s.brutto > 0) {
      var qr = r.nummer ? girocode(a, s.brutto, zweck) : '';
      zahlung = '<div class="b-zahlung">' + qr + '<div><b>Bitte überweisen Sie ' + eur(s.brutto) + (r.faellig_am ? ' bis zum ' + datum(r.faellig_am) : ' innerhalb von ' + (r.zahlungsziel || 14) + ' Tagen') + '.</b><br>' +
        'Kontoinhaber: ' + esc(a.bank_inhaber || a.inhaber) + '<br>IBAN: ' + esc(a.iban || 'in den Einstellungen eintragen') + (a.bic ? ' · BIC: ' + esc(a.bic) : '') + (a.bank_name ? '<br>' + esc(a.bank_name) : '') +
        '<br>Verwendungszweck: ' + esc(zweck || 'Rechnungsnummer folgt') + (qr ? '<br><span style="color:#6b737a">Mit der Banking-App scannen: alle Angaben sind schon ausgefüllt.</span>' : '') + '</div></div>';
    }
    return blattKopf(a, emp) + '<div class="b-meta"><h1>' + titel + (r.nummer ? ' ' + esc(r.nummer) : ' (Entwurf)') + '</h1><div class="b-daten">' +
      'Datum: ' + datum(r.datum) + (r.leistungsdatum ? '<br>Leistung: ' + esc(/^\d{4}-\d{2}-\d{2}$/.test(r.leistungsdatum) ? datum(r.leistungsdatum) : r.leistungsdatum) : '') +
      (kundeVon(r) && kundeVon(r).nummer ? '<br>Kundennummer: ' + esc(kundeVon(r).nummer) : '') + '</div></div>' +
      (r.kopftext ? '<div class="b-text">' + esc(r.kopftext) + '</div>' : '') +
      '<table><thead><tr><th style="width:8mm">Pos.</th><th>Bezeichnung</th><th class="r">Menge</th><th class="r">Einzelpreis</th><th class="r">Betrag</th></tr></thead><tbody>' + zeilen + summe + '</tbody></table>' +
      (klein ? '<div class="b-text" style="color:#4d565e">' + esc(a.hinweis_19 || 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.') + '</div>' : '') +
      zahlung + (r.fusstext ? '<div class="b-text">' + esc(r.fusstext) + '</div>' : '') + blattFuss(a);
  }
  function blattKopf(a, emp) {
    var streifen = ['--petrol', '--petrol-hell', '--pink', '--orange', '--gelb', '--gruen', '--himmel', '--petrol'].map(function (f) { return '<i style="background:var(' + f + ')"></i>'; }).join('');
    return '<div class="blatt"><div class="b-streifen">' + streifen + '</div>' +
      '<div class="b-kopf"><img src="assets/img/logo-voll.png" alt="ARTLENN MEDIA"><div class="b-absender">' +
      esc(a.name) + '<br>' + esc(a.inhaber) + '<br>' + esc(a.strasse) + '<br>' + esc(a.plz + ' ' + a.ort) + (a.email ? '<br>' + esc(a.email) : '') + (a.telefon ? '<br>' + esc(a.telefon) : '') + '</div></div>' +
      '<div class="b-zeile">' + esc([a.name, a.strasse, a.plz + ' ' + a.ort].join(' · ')) + '</div>' +
      '<div class="b-empf">' + esc(emp).replace(/\n/g, '<br>') + '</div>';
  }
  function blattFuss(a) {
    return '<div class="b-fuss"><div>' + esc(a.name) + '<br>Inhaber: ' + esc(a.inhaber) + '</div><div>' + (a.steuernummer ? 'Steuernummer: ' + esc(a.steuernummer) : '') + (a.ust_id ? '<br>USt-IdNr.: ' + esc(a.ust_id) : '') + '</div>' +
      '<div>' + (a.iban ? 'IBAN: ' + esc(a.iban) : '') + (a.bank_name ? '<br>' + esc(a.bank_name) : '') + '</div></div></div>';
  }

  /* Mahnung wie am Mac: Stufe 1 Zahlungserinnerung ohne Zinsen, ab Stufe 2 Verzugszinsen
     ab dem Tag nach Fälligkeit, Frist 7 bzw. 5 Tage. Die Rechnung selbst bleibt unverändert. */
  function verzugszinsen(betrag, faellig, am, satz) {
    var tage = faellig ? tageZwischen(faellig, am) : 0;
    return tage > 0 && satz ? rund(betrag * satz / 100 * tage / 365) : 0;
  }
  function mahnBlatt(r) {
    var stufe = Math.max(1, Math.min(3, Number(r.mahnstufe) || 1)), am = r.mahnung_am || heute();
    var a = absenderJetzt(), titel = MAHNTITEL[stufe], brutto = zahl(r.brutto);
    var tageOffen = r.faellig_am ? Math.max(0, tageZwischen(r.faellig_am, am)) : 0;
    var zinsen = stufe >= 2 ? verzugszinsen(brutto, r.faellig_am, am, zahl(S.e.verzugszins)) : 0;
    var gesamt = rund(brutto + zinsen), frist = plusTage(am, stufe === 1 ? 7 : 5), zweck = 'Rechnung ' + r.nummer;
    var kd = kundeVon(r), qr = girocode(a, gesamt, zweck);
    return blattKopf(a, r.empfaenger || anschrift(kd)) +
      '<div class="b-meta"><h1>' + titel + '</h1><div class="b-daten">Datum: ' + datum(am) + '<br>Rechnung: ' + esc(r.nummer) +
      (kd && kd.nummer ? '<br>Kundennummer: ' + esc(kd.nummer) : '') + '</div></div>' +
      '<div class="b-text">' + esc(S.e['mahntext_' + stufe] || '') + '</div>' +
      '<table><thead><tr><th style="width:8mm">Pos.</th><th>Bezeichnung</th><th class="r">Betrag</th></tr></thead><tbody>' +
      '<tr><td>1</td><td><b style="font-weight:600">Rechnung ' + esc(r.nummer) + ' vom ' + datum(r.datum) + '</b><br><span style="color:#6b737a">fällig am ' + datum(r.faellig_am) + ' · seit ' + tageOffen + ' Tagen offen</span></td><td class="r">' + eur(brutto) + '</td></tr>' +
      (zinsen ? '<tr><td>2</td><td><b style="font-weight:600">Verzugszinsen</b><br><span style="color:#6b737a">' + komma(S.e.verzugszins) + ' % im Jahr für ' + tageOffen + ' Tage</span></td><td class="r">' + eur(zinsen) + '</td></tr>' : '') +
      '<tr class="b-summe"><td colspan="2" class="r">Offener Betrag</td><td class="r">' + eur(gesamt) + '</td></tr></tbody></table>' +
      '<div class="b-zahlung">' + qr + '<div><b>Bitte überweisen Sie ' + eur(gesamt) + ' bis zum ' + datum(frist) + '.</b><br>' +
      'Kontoinhaber: ' + esc(a.bank_inhaber || a.inhaber) + '<br>IBAN: ' + esc(a.iban || 'in den Einstellungen eintragen') + (a.bic ? ' · BIC: ' + esc(a.bic) : '') + (a.bank_name ? '<br>' + esc(a.bank_name) : '') +
      '<br>Verwendungszweck: ' + esc(zweck) + (qr ? '<br><span style="color:#6b737a">Mit der Banking-App scannen: alle Angaben sind schon ausgefüllt.</span>' : '') + '</div></div>' +
      '<div class="b-text">Sollten Sie die Zahlung inzwischen veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.</div>' + blattFuss(a);
  }
  function vorschauEinpassen() {
    document.querySelectorAll('.vorschau').forEach(function (v) {
      var b = v.querySelector('.blatt'); if (!b) return;
      b.style.zoom = '';
      var faktor = Math.min(1, (v.clientWidth - 40) / b.offsetWidth);
      b.style.zoom = faktor;
    });
  }
  window.addEventListener('resize', vorschauEinpassen);
  function drucken(r, mahnung) {
    var d = document.getElementById('druck');
    d.innerHTML = mahnung ? mahnBlatt(r) : blatt(r);
    var alt = document.title;
    document.title = ((mahnung ? MAHNTITEL[r.mahnstufe] + ' zu ' : r.typ === 'angebot' ? 'Angebot ' : r.typ === 'storno' ? 'Storno ' : 'Rechnung ') + r.nummer + ' ' + kundeName(kundeVon(r))).trim();
    var img = d.querySelector('img');
    var los = function () { window.print(); document.title = alt; };
    if (img && !img.complete) img.onload = los; else los();
  }

  /* ---------- Finanzen ---------- */
  var finanzJahr = String(new Date().getFullYear());
  function ansichtFinanzen() {
    var j = finanzJahr, von = j + '-01-01', bis = j + '-12-31';
    var ein = zufluss(von, bis), aus = abfluss(von, bis), erg = rund(ein - aus);
    var ruecklage = Math.max(0, rund(erg * zahl(S.e.steuerruecklage) / 100));
    var jahre = {}; jahre[String(new Date().getFullYear())] = 1;
    S.rechnungen.forEach(function (r) { if (r.bezahlt_am) jahre[jahr(r.bezahlt_am)] = 1; });
    S.ausgaben.concat(S.einnahmen).forEach(function (x) { if (x.datum) jahre[jahr(x.datum)] = 1; });
    var monate = MONATE.map(function (m, i) {
      var mv = j + '-' + String(i + 1).padStart(2, '0') + '-01', mb = j + '-' + String(i + 1).padStart(2, '0') + '-31';
      var e = zufluss(mv, mb), a = abfluss(mv, mb);
      return '<tr><td>' + m + '</td><td class="r">' + (e ? eur(e) : '') + '</td><td class="r">' + (a ? eur(a) : '') + '</td><td class="r">' + (e || a ? eur(e - a) : '') + '</td></tr>';
    });
    var bewegungen = [];
    S.rechnungen.forEach(function (r) { if (r.bezahlt_am && jahr(r.bezahlt_am) === j) bewegungen.push({ d: r.bezahlt_am, t: (r.typ === 'storno' ? 'Erstattung ' : 'Rechnung ') + r.nummer + ' · ' + kundeName(kundeVon(r)), b: zahl(r.bezahlt_betrag), h: 'beleg/' + r.id }); });
    S.einnahmen.forEach(function (x) { if (jahr(x.datum) === j) bewegungen.push({ d: x.datum, t: x.beschreibung || 'Einnahme', b: zahl(x.betrag), tab: 'einnahmen', id: x.id, datei: x.datei }); });
    S.ausgaben.forEach(function (x) { if (jahr(x.datum) === j) bewegungen.push({ d: x.datum, t: (x.beschreibung || 'Ausgabe') + ' · ' + x.kategorie, b: -zahl(x.betrag), tab: 'ausgaben', id: x.id, datei: x.datei }); });
    bewegungen.sort(function (a, b) { return b.d.localeCompare(a.d); });
    seite('Finanzen', 'Gezählt wird der Tag, an dem das Geld fließt.',
      '<select class="ein" id="jahr" aria-label="Jahr" style="min-height:40px;width:auto">' + Object.keys(jahre).sort().reverse().map(function (x) { return '<option' + (x === j ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
      '<button class="knopf klein" type="button" id="neu-aus">Ausgabe</button><button class="knopf zweit klein" type="button" id="neu-ein">Einnahme ohne Rechnung</button>',
      '<div class="zahlen">' +
      '<div class="zahl" style="--farbe:var(--gruen)"><span>Einnahmen ' + j + '</span><b>' + eur(ein) + '</b></div>' +
      '<div class="zahl" style="--farbe:var(--orange)"><span>Ausgaben ' + j + '</span><b>' + eur(aus) + '</b></div>' +
      '<div class="zahl" style="--farbe:var(--petrol)"><span>Ergebnis</span><b>' + eur(erg) + '</b></div>' +
      '<div class="zahl" style="--farbe:var(--gelb)"><span>Rücklage für Steuern</span><b>' + eur(ruecklage) + '</b><small>' + komma(S.e.steuerruecklage) + ' % vom Ergebnis, nur ein Richtwert</small></div>' +
      '</div><div class="zwei"><section class="block"><h2>Monate</h2>' + tabelle([['Monat'], ['Einnahmen', 'r'], ['Ausgaben', 'r'], ['Ergebnis', 'r']], monate, '') + '</section>' +
      '<section class="block"><h2>Bewegungen <button class="link-knopf" type="button" id="csv">Als Tabelle laden</button></h2>' +
      tabelle([['Datum'], ['Was'], ['Betrag', 'r']], bewegungen.map(function (x) {
        var ziel = x.h ? ' data-href="' + x.h + '"' : '';
        return '<tr' + ziel + '><td>' + datum(x.d) + '</td><td>' + (x.h ? '<a href="#' + x.h + '">' + esc(x.t) + '</a>' : esc(x.t) +
          ' <button class="link-knopf" type="button" data-tab="' + x.tab + '" data-id="' + x.id + '" style="font-size:13px">ändern</button>' +
          (x.datei ? ' · <button class="link-knopf" type="button" data-datei="' + esc(x.datei) + '" style="font-size:13px">Beleg</button>' : (x.tab === 'ausgaben' ? '<span class="neben">ohne Beleg</span>' : ''))) + '</td><td class="r" style="color:' + (x.b < 0 ? 'var(--fehler)' : 'var(--gut)') + '">' + eur(x.b) + '</td></tr>';
      }), 'Keine Bewegungen in ' + j + '.') + '</section></div>');
    zeilenKlick();
    document.getElementById('jahr').addEventListener('change', function (e) { finanzJahr = e.target.value; ansichtFinanzen(); });
    document.getElementById('neu-aus').addEventListener('click', function () { bewegungBearbeiten('ausgaben', null); });
    document.getElementById('neu-ein').addEventListener('click', function () { bewegungBearbeiten('einnahmen', null); });
    inhalt.querySelectorAll('[data-datei]').forEach(function (b) { b.addEventListener('click', function () { dateiOeffnen(b.dataset.datei); }); });
    inhalt.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { bewegungBearbeiten(b.dataset.tab, per(S[b.dataset.tab], b.dataset.id)); }); });
    document.getElementById('csv').addEventListener('click', function () {
      var zeilen = [['Datum', 'Beschreibung', 'Betrag']].concat(bewegungen.slice().reverse().map(function (x) { return [datum(x.d), x.t, x.b.toFixed(2).replace('.', ',')]; }));
      var text = '﻿' + zeilen.map(function (z) { return z.map(function (f) { return '"' + String(f).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      a.download = 'ARTLENN-MEDIA-Finanzen-' + j + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  }
  /* Belegdatei öffnen. Das Fenster geht sofort auf, sonst blockt der Browser es nach dem Warten. */
  function dateiOeffnen(pfad) {
    var w = window.open('', '_blank');
    AMD.dateiAdresse(pfad).then(function (url) { if (w) w.location.href = url; else location.href = url; })
      .catch(function (err) { if (w) w.close(); fehler(err); });
  }
  function bewegungBearbeiten(tab, x, vorgabe) {
    var aus = tab === 'ausgaben', neu = !x; x = x || Object.assign({ datum: heute(), kategorie: 'Sonstiges', betrag: '' }, vorgabe || {});
    var dateiEl = null;
    var rg = x.rechnung_id ? per(S.rechnungen, x.rechnung_id) : null;
    var auftragsWahl = [['', 'Keinem Auftrag']].concat(S.auftraege.filter(function (a) { return a.status !== 'abgelehnt' || a.id === x.auftrag_id; })
      .sort(function (a, b) { return b.id - a.id; }).map(function (a) { return [a.id, (a.titel || a.nummer) + ' · ' + kundeName(kundeVon(a))]; }));
    dialog({ titel: (neu ? 'Neue ' : '') + (aus ? 'Ausgabe' : 'Einnahme ohne Rechnung'),
      html: '<div class="felder">' + feld('datum', aus ? 'Bezahlt am' : 'Eingegangen am', x.datum, { art: 'date' }) + feld('betrag', 'Betrag in Euro', x.betrag === '' ? '' : komma(x.betrag), { modus: 'decimal', pflicht: true }) +
        feld('beschreibung', 'Beschreibung', x.beschreibung, { breite: 'ganz' }) +
        (aus ? feld('kategorie', 'Art', x.kategorie, { art: 'select', optionen: AUSGABE_ART, breite: 'ganz' }) +
          feld('auftrag_id', 'Gehört zu Auftrag', x.auftrag_id || '', { art: 'select', optionen: auftragsWahl, breite: 'ganz' }) +
          '<label class="haken feld ganz"><input type="checkbox" name="weiterberechnen"' + (x.weiterberechnen ? ' checked' : '') + (rg ? ' disabled' : '') + '> Dem Kunden weiterberechnen (kommt auf die nächste Rechnung zum Auftrag)</label>' +
          (rg ? '<p class="feld ganz" style="margin:0;color:var(--schrift-3);font-size:14px">Steht schon auf ' + (rg.nummer ? 'Rechnung ' + esc(rg.nummer) : 'einem Rechnungsentwurf') + '.</p>' : '') : '') +
        '<div class="feld ganz"><label for="f-datei">Beleg als Datei</label>' +
        (x.datei ? '<div class="datei-zeile"><button type="button" class="link-knopf" id="datei-auf">' + esc(x.datei_name || 'Beleg öffnen') + '</button>' +
          '<label class="haken" style="min-height:0"><input type="checkbox" name="datei_weg"> Entfernen</label></div>' : '') +
        '<input class="ein datei" id="f-datei" type="file" accept="image/*,application/pdf">' +
        '<small>' + (x.datei ? 'Neue Datei ersetzt die bisherige. ' : '') + 'Foto oder PDF, ' + (AMD.modus === 'beispiel' ? 'im Beispielmodus bis 1,5 MB.' : 'bis 20 MB.') + '</small></div></div>',
      knoepfe: (neu ? [] : [{ t: 'Löschen', w: 'weg', art: 'gefahr' }]).concat([{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Speichern', w: 'ok' }]),
      nachher: function (d) {
        dateiEl = d.querySelector('#f-datei');
        var auf = d.querySelector('#datei-auf');
        if (auf) auf.addEventListener('click', function () { dateiOeffnen(x.datei); });
      } })
      .then(function (d) {
        if (d.wahl === 'weg') {
          if (rg && rg.festgeschrieben) throw new Error('Diese Auslage steht auf Rechnung ' + rg.nummer + ' und bleibt deshalb stehen.');
          return loeschen(tab, x.id).then(function () { if (x.datei) return AMD.dateiWeg(x.datei).catch(function () {}); })
            .then(function () { hinweis('Gelöscht'); route(); });
        }
        if (d.wahl !== 'ok') return;
        if (!zahl(d.werte.betrag)) throw new Error('Bitte einen Betrag eintragen.');
        var neueDatei = dateiEl && dateiEl.files[0];
        var o = Object.assign({}, x, { datum: d.werte.datum, betrag: zahl(d.werte.betrag), beschreibung: d.werte.beschreibung });
        if (aus) {
          var auf = d.werte.auftrag_id ? per(S.auftraege, d.werte.auftrag_id) : null;
          Object.assign(o, { kategorie: d.werte.kategorie, auftrag_id: auf ? auf.id : null, kunde_id: auf ? auf.kunde_id : null });
          if (!rg) o.weiterberechnen = !!(auf && d.werte.weiterberechnen);
        } else delete o.kategorie;
        var alt = x.datei || '';
        hinweis(neueDatei ? 'Datei wird hochgeladen …' : 'Speichert …');
        return (neueDatei ? AMD.dateiHoch(neueDatei) : Promise.resolve(null)).then(function (pfad) {
          if (pfad) { o.datei = pfad; o.datei_name = neueDatei.name; }
          else if (d.werte.datei_weg) { o.datei = ''; o.datei_name = ''; }
          return speichern(tab, o);
        }).then(function () {
          // Alte Datei erst wegräumen, wenn der Eintrag sicher gespeichert ist
          if (alt && alt !== o.datei) return AMD.dateiWeg(alt).catch(function () {});
        }).then(function () { hinweis('Gespeichert'); route(); });
      }).catch(fehler);
  }

  /* ---------- Leistungen ---------- */
  function ansichtLeistungen() {
    var l = S.leistungen.slice().sort(function (a, b) { return (b.aktiv !== false) - (a.aktiv !== false) || a.name.localeCompare(b.name, 'de'); });
    seite('Leistungen', 'Vorlagen für Positionen in Aufträgen, Angeboten und Rechnungen.', '<button class="knopf klein" type="button" id="neu">Neue Leistung</button>',
      '<section class="block">' + tabelle([['Leistung'], ['Einheit', 'weg'], ['Preis', 'r']], l.map(function (x) {
        return '<tr data-l="' + x.id + '" style="cursor:pointer' + (x.aktiv === false ? ';opacity:.55' : '') + '"><td><a href="#leistungen" data-l="' + x.id + '">' + esc(x.name) + '</a>' +
          '<span class="neben">' + esc(x.beschreibung) + (x.aktiv === false ? ' · ausgeblendet' : '') + '</span></td><td class="weg">' + esc(x.einheit) + '</td><td class="r">' + eur(x.preis) + '</td></tr>';
      }), 'Noch keine Leistungen.', true) + '</section>');
    inhalt.querySelectorAll('tr[data-l]').forEach(function (tr) { tr.addEventListener('click', function (e) { e.preventDefault(); leistungBearbeiten(per(S.leistungen, tr.dataset.l)); }); });
    document.getElementById('neu').addEventListener('click', function () { leistungBearbeiten(null); });
  }
  function leistungBearbeiten(x) {
    var neu = !x; x = x || { einheit: 'Stück', preis: 0, aktiv: true };
    dialog({ titel: neu ? 'Neue Leistung' : 'Leistung ändern',
      html: '<div class="felder">' + feld('name', 'Bezeichnung', x.name, { breite: 'ganz', pflicht: true }) + feld('beschreibung', 'Beschreibung', x.beschreibung, { breite: 'ganz' }) +
        feld('einheit', 'Einheit', x.einheit) + feld('preis', 'Preis in Euro', komma(x.preis), { modus: 'decimal' }) +
        '<label class="haken feld ganz"><input type="checkbox" name="aktiv"' + (x.aktiv !== false ? ' checked' : '') + '> Zur Auswahl anbieten</label></div>',
      knoepfe: (neu ? [] : [{ t: 'Löschen', w: 'weg', art: 'gefahr' }]).concat([{ t: 'Abbrechen', w: '', art: 'zweit' }, { t: 'Speichern', w: 'ok' }]) })
      .then(function (d) {
        if (d.wahl === 'weg') return Promise.all(S.kundenpreise.filter(function (p) { return p.leistung_id === x.id; }).map(function (p) { return loeschen('kundenpreise', p.id); }))
          .then(function () { return loeschen('leistungen', x.id); }).then(function () { hinweis('Gelöscht'); ansichtLeistungen(); });
        if (d.wahl !== 'ok') return;
        if (!d.werte.name.trim()) throw new Error('Bitte eine Bezeichnung eintragen.');
        return speichern('leistungen', Object.assign({}, x, d.werte, { preis: zahl(d.werte.preis) })).then(function () { hinweis('Gespeichert'); ansichtLeistungen(); });
      }).catch(fehler);
  }

  /* ---------- Einstellungen ---------- */
  function ansichtEinstellungen() {
    var e = S.e;
    seite('Einstellungen', 'Diese Angaben stehen auf jedem neuen Angebot und jeder neuen Rechnung.', '',
      '<form id="form"><section class="block"><h2>Betrieb</h2><div class="innen"><div class="felder">' +
      feld('firma_name', 'Name des Betriebs', e.firma_name) + feld('firma_inhaber', 'Inhaber', e.firma_inhaber) +
      feld('firma_strasse', 'Straße und Hausnummer', e.firma_strasse, { breite: 'ganz' }) +
      feld('firma_plz', 'PLZ', e.firma_plz, { breite: 'eins' }) + feld('firma_ort', 'Ort', e.firma_ort, { breite: 'zwei-d' }) +
      feld('firma_email', 'E-Mail', e.firma_email, { art: 'email' }) + feld('firma_telefon', 'Telefon', e.firma_telefon, { art: 'tel' }) +
      feld('firma_steuernummer', 'Steuernummer', e.firma_steuernummer, { hilfe: 'Kommt nach der Anmeldung vom Finanzamt. Ohne sie lässt sich keine Rechnung festschreiben.' }) +
      feld('firma_ust_id', 'USt-IdNr. (falls vorhanden)', e.firma_ust_id) +
      '</div></div></section><section class="block"><h2>Bankverbindung</h2><div class="innen"><div class="felder">' +
      feld('bank_inhaber', 'Kontoinhaber', e.bank_inhaber) + feld('bank_name', 'Bank', e.bank_name) +
      feld('bank_iban', 'IBAN', e.bank_iban, { hilfe: 'Für den QR-Code zum Überweisen auf der Rechnung.' }) + feld('bank_bic', 'BIC', e.bank_bic) +
      '</div></div></section><section class="block"><h2>Steuer und Rechnungen</h2><div class="innen"><div class="felder">' +
      feld('kleinunternehmer', 'Kleinunternehmer nach § 19 UStG', e.kleinunternehmer, { art: 'select', optionen: [['ja', 'Ja, keine Umsatzsteuer'], ['nein', 'Nein, mit Umsatzsteuer']] }) +
      feld('steuersatz', 'Umsatzsteuer in Prozent', e.steuersatz, { modus: 'decimal', hilfe: 'Gilt nur ohne Kleinunternehmer-Regel.' }) +
      feld('hinweis_19', 'Hinweis auf der Rechnung', e.hinweis_19, { breite: 'ganz' }) +
      feld('zahlungsziel', 'Zahlungsziel in Tagen', e.zahlungsziel, { art: 'number' }) +
      feld('steuerruecklage', 'Rücklage für Steuern in Prozent', e.steuerruecklage, { modus: 'decimal' }) +
      feld('fusstext', 'Schlusstext auf Rechnungen', e.fusstext, { art: 'textarea', breite: 'ganz', zeilen: 2 }) +
      '</div></div></section><section class="block"><h2>Mahnungen</h2><div class="innen"><div class="felder">' +
      feld('verzugszins', 'Verzugszinsen in Prozent im Jahr', e.verzugszins, { modus: 'decimal', hilfe: 'Kommen ab der 1. Mahnung dazu.' }) +
      feld('mahntext_1', 'Text der Zahlungserinnerung', e.mahntext_1, { art: 'textarea', breite: 'ganz', zeilen: 2 }) +
      feld('mahntext_2', 'Text der 1. Mahnung', e.mahntext_2, { art: 'textarea', breite: 'ganz', zeilen: 2 }) +
      feld('mahntext_3', 'Text der 2. Mahnung', e.mahntext_3, { art: 'textarea', breite: 'ganz', zeilen: 2 }) +
      '</div><div class="formfuss"><button class="knopf klein" type="submit">Speichern</button></div></div></section></form>' +
      '<section class="block"><h2>Sicherung</h2><div class="innen"><p style="margin:0 0 14px;color:var(--schrift-2)">Lädt alle Kunden, Aufträge, Belege und Finanzen als eine Datei herunter. Die Belegdateien selbst (Fotos, PDFs) sind darin nicht enthalten.</p>' +
      '<div class="formfuss" style="margin:0"><button class="knopf zweit klein" type="button" id="sichern">Sicherung herunterladen</button>' +
      (AMD.modus === 'beispiel' ? '<button class="knopf gefahr klein" type="button" id="leeren">Beispieldaten löschen</button>' : '') + '</div></div></section>');
    var form = document.getElementById('form');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var w = werteAus(form);
      AMD.einstellungenSpeichern(w).then(function () { Object.assign(S.e, w); hinweis('Gespeichert'); }).catch(fehler);
    });
    document.getElementById('sichern').addEventListener('click', function () {
      AMD.alles().then(function (d) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
        a.download = 'MeinOrbit-Sicherung-' + heute() + '.json'; a.click();
      }).catch(fehler);
    });
    var leeren = document.getElementById('leeren');
    if (leeren) leeren.addEventListener('click', function () {
      frage('Beispieldaten löschen?', 'Alles, was du im Beispielmodus eingetragen hast, wird aus diesem Browser entfernt.', 'Löschen', true).then(function (ok) {
        if (ok) AMD.zuruecksetzen().then(laden).then(function () { hinweis('Gelöscht'); location.hash = 'start'; route(); });
      });
    });
  }

  /* ---------- Wegweiser ---------- */
  function nichtGefunden() { seite('Nicht gefunden', '', '', '<p>Diesen Eintrag gibt es nicht (mehr). <a href="#start">Zur Übersicht</a></p>'); }
  function route() {
    var h = (location.hash || '#start').slice(1), teile = h.split('?'), pfad = teile[0].split('/'), q = {};
    (teile[1] || '').split('&').forEach(function (p) { var kv = p.split('='); if (kv[0]) q[kv[0]] = decodeURIComponent(kv[1] || ''); });
    var bereich = { kunde: 'kunden', auftrag: 'auftraege', beleg: null }[pfad[0]] || pfad[0];
    if (pfad[0] === 'beleg') { var r = per(S.rechnungen, pfad[1]); bereich = (r && r.typ === 'angebot') || pfad[1] === 'neu-angebot' ? 'angebote' : 'rechnungen'; }
    document.querySelectorAll('#nav a').forEach(function (a) { var an = a.dataset.r === bereich; a.classList.toggle('an', an); if (an) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var v = {
      start: ansichtStart, kunden: ansichtKunden, kunde: function () { ansichtKunde(pfad[1]); },
      auftraege: ansichtAuftraege, auftrag: function () { ansichtAuftrag(pfad[1], q); },
      rechnungen: function () { ansichtBelege('rechnung'); }, angebote: function () { ansichtBelege('angebot'); },
      beleg: function () { ansichtBeleg(pfad[1], q); },
      finanzen: ansichtFinanzen, leistungen: ansichtLeistungen, einstellungen: ansichtEinstellungen
    }[pfad[0]] || nichtGefunden;
    try { v(); } catch (err) { fehler(err); }
    window.scrollTo(0, 0);
  }

  function laden() {
    return Promise.all(['kunden', 'leistungen', 'auftraege', 'rechnungen', 'ausgaben', 'einnahmen', 'zeiten', 'kundenpreise'].map(function (t) {
      return AMD.alle(t).then(function (l) { S[t] = l.map(function (x) { x.id = Number(x.id); return x; }); });
    })).then(function () { return AMD.einstellungen(); }).then(function (e) { S.e = e; });
  }

  AMD.sitzung().then(function (u) {
    if (!u) { location.replace('anmelden.html'); return; }
    document.getElementById('wer').textContent = u.email;
    document.getElementById('abmelden').addEventListener('click', function () { AMD.abmelden().then(function () { location.replace('anmelden.html'); }); });
    return laden().then(function () {
      document.getElementById('app').hidden = false;
      window.addEventListener('hashchange', route);
      route();
    });
  }).catch(function (err) {
    document.body.innerHTML = '<p style="padding:24px">MeinOrbit konnte nicht geladen werden: ' + esc(err.message) + '</p>';
  });
})();
