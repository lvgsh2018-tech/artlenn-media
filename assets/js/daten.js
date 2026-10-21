/* Datenablage für MeinOrbit im Web.
   Zwei Wege mit denselben Befehlen:
   - Beispielmodus: alles in localStorage, nur in diesem Browser.
   - Echtbetrieb: Supabase mit Anmeldung (Tabellen aus supabase/setup.sql).
   Rechnungen, die festgeschrieben sind, schützt im Echtbetrieb zusätzlich
   eine Regel in der Datenbank (GoBD: Festschreiben statt Ändern). */
(function () {
  'use strict';
  var C = window.AM_CONFIG || {};
  var echt = !!(C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase);
  var sb = echt ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY) : null;
  var TABELLEN = ['kunden', 'leistungen', 'auftraege', 'rechnungen', 'ausgaben', 'einnahmen'];
  var SCHLUESSEL = 'artlenn-orbit-beispiel';

  /* Startwerte, wie sie in MeinOrbit am Mac stehen (Stand 2026-10-21).
     Bankverbindung und Telefon bewusst leer: diese Datei ist öffentlich. */
  var START_EINSTELLUNGEN = {
    firma_name: 'ARTLENN MEDIA', firma_inhaber: 'Lennart Schleef',
    firma_strasse: 'Wiensieker Weg 15', firma_plz: '32108', firma_ort: 'Bad Salzuflen',
    firma_email: 'hallo@artlenn.de', firma_telefon: '', firma_web: '',
    firma_steuernummer: '', firma_ust_id: '',
    bank_inhaber: 'Lennart Schleef', bank_name: '', bank_iban: '', bank_bic: '',
    kleinunternehmer: 'ja', hinweis_19: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    steuersatz: '19', zahlungsziel: '14', fusstext: 'Vielen Dank für die gute Zusammenarbeit.',
    steuerruecklage: '25'
  };
  var START_LEISTUNGEN = [
    ["Werbung auf Bad Salzuflen News: Reel", "Dreh, Schnitt, Text, 1 Korrekturrunde", "Stück", 249.0],
    ["Werbung auf Bad Salzuflen News: Story mit Link", "1 Instagram-Story", "Stück", 19.0],
    ["Werbung auf Bad Salzuflen News: Story-Paket (3 Storys)", "3 Instagram-Storys mit Link (statt 57 €)", "Pauschale", 49.0],
    ["Werbung auf Bad Salzuflen News: Artikel als Anzeige", "Text schreiben, dauerhaft online, als Anzeige gekennzeichnet", "Stück", 149.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel klein, 1 Monat", "Quadrat auf der Startseite", "Monat", 59.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel klein, 3 Monate", "Quadrat auf der Startseite, Quartal (statt 177 €)", "Pauschale", 159.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel klein, 6 Monate", "Quadrat auf der Startseite, Halbjahr (statt 354 €)", "Pauschale", 299.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel klein, 12 Monate", "Quadrat auf der Startseite, Jahr (statt 708 €)", "Pauschale", 569.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel groß, 1 Monat", "Rechteck auf der Startseite, doppelte Fläche", "Monat", 89.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel groß, 3 Monate", "Rechteck auf der Startseite, Quartal (statt 267 €)", "Pauschale", 239.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel groß, 6 Monate", "Rechteck auf der Startseite, Halbjahr (statt 534 €)", "Pauschale", 449.0],
    ["Werbung auf Bad Salzuflen News: Startseiten-Kachel groß, 12 Monate", "Rechteck auf der Startseite, Jahr (statt 1.068 €)", "Pauschale", 849.0],
    ["Werbung auf Bad Salzuflen News: Anzeige unter dem Artikel, 1 Monat", "Unter jedem Beitrag, über „Beitrag teilen“", "Monat", 39.0],
    ["Werbung auf Bad Salzuflen News: Anzeige unter dem Artikel, 3 Monate", "Unter jedem Beitrag, Quartal (statt 117 €)", "Pauschale", 105.0],
    ["Werbung auf Bad Salzuflen News: Anzeige unter dem Artikel, 6 Monate", "Unter jedem Beitrag, Halbjahr (statt 234 €)", "Pauschale", 199.0],
    ["Werbung auf Bad Salzuflen News: Anzeige unter dem Artikel, 12 Monate", "Unter jedem Beitrag, Jahr (statt 468 €)", "Pauschale", 375.0],
    ["Werbung auf Bad Salzuflen News: „präsentiert von“ bei den Terminen", "Ein Platz, ein Kunde", "Monat", 49.0],
    ["Werbung auf Bad Salzuflen News: Partnerleiste, 1 Monat", "Logo unten auf jeder Seite", "Monat", 19.0],
    ["Werbung auf Bad Salzuflen News: Partnerleiste, 12 Monate", "Logo unten auf jeder Seite, Jahr (statt 228 €)", "Pauschale", 179.0],
    ["Werbung auf Bad Salzuflen News: Paket Neueröffnung", "Artikel + Reel + Story (statt 417 €)", "Pauschale", 359.0],
    ["Werbung auf Bad Salzuflen News: Paket Sichtbar im Monat", "Kleine Startseiten-Kachel 1 Monat + 2 Storys (statt 97 €)", "Pauschale", 85.0],
    ["Werbung auf Bad Salzuflen News: Paket Reel + Story", "Reel + Story mit Link, Story gratis (statt 268 €)", "Pauschale", 249.0],
  ];

  function heute() { return new Date().toISOString().slice(0, 10); }

  /* ---------- Beispielmodus ---------- */
  function lesen() {
    var d;
    try { d = JSON.parse(localStorage.getItem(SCHLUESSEL)); } catch (e) { d = null; }
    if (!d) {
      d = { seq: {}, einstellungen: Object.assign({}, START_EINSTELLUNGEN) };
      TABELLEN.forEach(function (t) { d[t] = []; d.seq[t] = 0; });
      START_LEISTUNGEN.forEach(function (l) {
        d.leistungen.push({ id: ++d.seq.leistungen, name: l[0], beschreibung: l[1], einheit: l[2], preis: l[3], aktiv: true });
      });
    }
    return d;
  }
  function schreiben(d) { localStorage.setItem(SCHLUESSEL, JSON.stringify(d)); }
  function kopie(x) { return JSON.parse(JSON.stringify(x)); }

  var demo = {
    sitzung: function () { return Promise.resolve(sessionStorage.getItem(SCHLUESSEL + '-an') ? { email: 'Beispielmodus' } : null); },
    anmelden: function () { sessionStorage.setItem(SCHLUESSEL + '-an', '1'); return Promise.resolve({ email: 'Beispielmodus' }); },
    abmelden: function () { sessionStorage.removeItem(SCHLUESSEL + '-an'); return Promise.resolve(); },
    alle: function (t) { return Promise.resolve(kopie(lesen()[t] || [])); },
    speichern: function (t, obj) {
      var d = lesen(), liste = d[t], o = kopie(obj);
      if (o.id) {
        var i = liste.findIndex(function (x) { return x.id === o.id; });
        if (i < 0) return Promise.reject(new Error('Eintrag nicht gefunden'));
        if (t === 'rechnungen' && liste[i].festgeschrieben) {
          var erlaubt = ['status', 'bezahlt_am', 'bezahlt_betrag', 'storniert_durch', 'notiz_intern'];
          Object.keys(o).forEach(function (k) {
            if (erlaubt.indexOf(k) < 0 && JSON.stringify(o[k]) !== JSON.stringify(liste[i][k])) throw new Error('Festgeschriebene Rechnung kann nicht geändert werden.');
          });
        }
        liste[i] = Object.assign(liste[i], o);
        o = liste[i];
      } else {
        o.id = ++d.seq[t];
        o.angelegt_am = o.angelegt_am || heute();
        liste.push(o);
      }
      schreiben(d);
      return Promise.resolve(kopie(o));
    },
    loeschen: function (t, id) {
      var d = lesen();
      var x = d[t].find(function (e) { return e.id === id; });
      if (t === 'rechnungen' && x && x.festgeschrieben) return Promise.reject(new Error('Festgeschriebene Rechnungen bleiben stehen.'));
      d[t] = d[t].filter(function (e) { return e.id !== id; });
      schreiben(d);
      return Promise.resolve();
    },
    einstellungen: function () { return Promise.resolve(Object.assign({}, START_EINSTELLUNGEN, lesen().einstellungen)); },
    einstellungenSpeichern: function (werte) {
      var d = lesen(); d.einstellungen = Object.assign(d.einstellungen || {}, werte); schreiben(d);
      return Promise.resolve();
    },
    zuruecksetzen: function () { localStorage.removeItem(SCHLUESSEL); return Promise.resolve(); },
    alles: function () { return Promise.resolve(lesen()); }
  };

  /* ---------- Echtbetrieb (Supabase) ---------- */
  function pruefen(r) { if (r.error) throw new Error(r.error.message); return r.data; }
  var supa = {
    sitzung: function () { return sb.auth.getSession().then(function (r) { return r.data.session ? r.data.session.user : null; }); },
    anmelden: function (email, pw) {
      return sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) {
        if (r.error) throw new Error('E-Mail oder Passwort stimmt nicht.');
        return r.data.user;
      });
    },
    abmelden: function () { return sb.auth.signOut(); },
    alle: function (t) { return sb.from(t).select('*').order('id').then(pruefen); },
    speichern: function (t, obj) {
      var o = kopie(obj);
      if (o.id) {
        var id = o.id; delete o.id;
        return sb.from(t).update(o).eq('id', id).select().single().then(pruefen);
      }
      delete o.id;
      return sb.from(t).insert(o).select().single().then(pruefen);
    },
    loeschen: function (t, id) { return sb.from(t).delete().eq('id', id).then(pruefen); },
    einstellungen: function () {
      return sb.from('einstellungen').select('*').then(pruefen).then(function (zeilen) {
        var m = Object.assign({}, START_EINSTELLUNGEN);
        zeilen.forEach(function (z) { m[z.schluessel] = z.wert; });
        return m;
      });
    },
    einstellungenSpeichern: function (werte) {
      var zeilen = Object.keys(werte).map(function (k) { return { schluessel: k, wert: String(werte[k] == null ? '' : werte[k]) }; });
      return sb.from('einstellungen').upsert(zeilen).then(pruefen);
    },
    alles: function () {
      var d = {};
      return Promise.all(TABELLEN.map(function (t) { return supa.alle(t).then(function (r) { d[t] = r; }); }))
        .then(function () { return supa.einstellungen(); })
        .then(function (e) { d.einstellungen = e; return d; });
    }
  };

  window.AMD = Object.assign({ modus: echt ? 'echt' : 'beispiel' }, echt ? supa : demo);
})();
