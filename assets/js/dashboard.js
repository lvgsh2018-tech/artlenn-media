/* Dashboard: holt echte Zahlen aus MeinOrbit und Meldungen aus Bad Salzuflen
   und der Welt. MeinOrbit liegt als gepackte Datendatei in der Tabelle
   orbit_datenbank (siehe orbit/bruecke.js); hier wird sie nur gelesen, nie
   geschrieben. */
(function () {
  var C = window.AM_CONFIG || {};
  var sb = (C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase)
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY) : null;

  // Öffentliche Lese-Adresse von Bad Salzuflen News (steht dort ebenfalls offen in config.js)
  var BSN = { url: "https://idvnjawudxgearwihfxn.supabase.co/rest/v1",
              key: "sb_publishable_gcDJrh1nciwG0gxYlg3CMw_dxvZiPNp",
              seite: "https://badsalzuflennews.de/" };

  var MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  var MONATE_LANG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function euro(n, cent) { return (n || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: cent ? 2 : 0, maximumFractionDigits: cent ? 2 : 0 }); }
  function zwei(n) { return n < 10 ? "0" + n : "" + n; }
  function isoTag(d) { return d.getFullYear() + "-" + zwei(d.getMonth() + 1) + "-" + zwei(d.getDate()); }
  function datumDE(iso) { return iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : ""; }
  function vorWann(wert) {
    var d = new Date(wert), min = Math.round((Date.now() - d) / 60000);
    if (min < 1) return "gerade eben";
    if (min < 60) return "vor " + min + " Min.";
    if (min < 24 * 60) return "vor " + Math.round(min / 60) + " Std.";
    if (min < 48 * 60) return "gestern";
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  function leer(id, text) { if (!$(id)) return; $(id).innerHTML = '<li class="leer">' + esc(text) + "</li>"; }
  function setzen(id, wert, unter) { if (!$(id)) return; $(id).textContent = wert; if (unter != null && $(id + "-u")) $(id + "-u").innerHTML = unter; }

  /* ---------------- MeinOrbit ---------------- */

  async function orbitLaden() {
    var r = await sb.from("orbit_datenbank").select("inhalt").eq("id", 1).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data || !r.data.inhalt) throw new Error("Noch keine MeinOrbit-Daten gespeichert.");
    var roh = atob(r.data.inhalt.replace(/\s+/g, ""));
    var bytes = new Uint8Array(roh.length);
    for (var i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
    var strom = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    var datei = new Uint8Array(await new Response(strom).arrayBuffer());
    var SQL = await initSqlJs({ locateFile: function (f) { return "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/" + f; } });
    return new SQL.Database(datei);
  }

  function abfrage(db, sql, werte) {
    var st = db.prepare(sql), aus = [];
    st.bind(werte || []);
    while (st.step()) aus.push(st.getAsObject());
    st.free();
    return aus;
  }

  function kundenname(k) {
    return (k.firma && String(k.firma).trim()) || [k.vorname, k.nachname].filter(Boolean).join(" ") || "Ohne Namen";
  }

  function orbitZeigen(db) {
    var jetzt = new Date(), heute = isoTag(jetzt);

    // Umsatz wie in MeinOrbit: zählt am Tag des Geldeingangs (bezahlt_am), Korrekturen negativ, dazu Geld ohne Rechnung
    var proMonat = {};
    abfrage(db, "SELECT bezahlt_am, brutto, typ FROM rechnungen WHERE typ IN ('rechnung','storno') AND festgeschrieben=1 AND bezahlt_am != ''")
      .forEach(function (r) { var m = String(r.bezahlt_am).slice(0, 7); proMonat[m] = (proMonat[m] || 0) + (r.brutto || 0) * (r.typ === "storno" ? -1 : 1); });
    abfrage(db, "SELECT datum, betrag FROM einnahmen WHERE datum != ''")
      .forEach(function (x) { var m = String(x.datum).slice(0, 7); proMonat[m] = (proMonat[m] || 0) + (x.betrag || 0); });

    var reihe = [];
    for (var i = 11; i >= 0; i--) {
      var d = new Date(jetzt.getFullYear(), jetzt.getMonth() - i, 1);
      var schl = d.getFullYear() + "-" + zwei(d.getMonth() + 1);
      reihe.push({ schl: schl, name: MONATE[d.getMonth()], wert: Math.round((proMonat[schl] || 0) * 100) / 100 });
    }
    saeulen(reihe);

    var jahr = String(jetzt.getFullYear()), summeJahr = 0, best = null;
    Object.keys(proMonat).forEach(function (m) {
      if (m.slice(0, 4) !== jahr) return;
      summeJahr += proMonat[m];
      if (!best || proMonat[m] > proMonat[best]) best = m;
    });
    $("d-jahr").textContent = euro(summeJahr);
    $("d-schnitt").textContent = euro(summeJahr / (jetzt.getMonth() + 1));
    $("d-best").textContent = best && proMonat[best] > 0 ? MONATE_LANG[+best.slice(5, 7) - 1] : "–";

    var dieser = reihe[11].wert, vorher = reihe[10].wert;
    $("z-monat").textContent = MONATE_LANG[jetzt.getMonth()];
    var vergleich = vorher > 0
      ? '<span class="' + (dieser >= vorher ? "plus" : "minus") + '">' + (dieser >= vorher ? "+" : "") + Math.round((dieser - vorher) / vorher * 100) + " %</span> zum " + MONATE_LANG[(jetzt.getMonth() + 11) % 12]
      : MONATE_LANG[(jetzt.getMonth() + 11) % 12] + ": " + euro(vorher);
    setzen("z-umsatz", euro(dieser), vergleich);
    linie("l-umsatz", reihe.slice(4).map(function (r) { return r.wert; }));

    // Offene Rechnungen wie offene_posten() in MeinOrbit
    var offen = abfrage(db, "SELECT typ, brutto, faellig_am FROM rechnungen WHERE typ IN ('rechnung','storno') AND status='offen'");
    var anzahl = 0, summe = 0, ueber = 0;
    offen.forEach(function (r) {
      if (r.typ === "rechnung") anzahl++;
      summe += (r.brutto || 0) * (r.typ === "storno" ? -1 : 1);
      if (r.typ === "rechnung" && r.faellig_am && r.faellig_am < heute) ueber++;
    });
    setzen("z-offen", String(anzahl), anzahl ? euro(summe) + (ueber ? ', <span class="minus">' + ueber + " überfällig</span>" : ", nichts überfällig") : "alles bezahlt");

    // Heute: Termine und fällige Aufgaben aus MeinOrbit
    var termine = abfrage(db, "SELECT titel, von, bis, ganztags, ort FROM termine WHERE datum = ? ORDER BY ganztags DESC, von", [heute]);
    var aufgaben = abfrage(db, "SELECT titel, faellig, uhrzeit, wichtig FROM aufgaben WHERE erledigt = 0 AND faellig != '' AND faellig <= ? ORDER BY faellig, uhrzeit", [heute]);
    HEUTE.orbit = termine.map(function (t) {
      return { zeit: t.ganztags ? "" : (t.von || ""), titel: t.titel || "Termin", unter: "MeinOrbit" + (t.ort ? " · " + t.ort : ""), farbe: "var(--petrol)" };
    });
    HEUTE.aufgaben = aufgaben.map(function (a) {
      var spaet = a.faellig < heute;
      return { zeit: a.uhrzeit || "", aufgabe: true, titel: a.titel || "Aufgabe", farbe: spaet ? "var(--pink)" : "rgba(255,255,255,.35)",
        unter: (spaet ? "seit " + datumDE(a.faellig) + " fällig" : "Aufgabe für heute") + (a.wichtig ? " · wichtig" : "") };
    });
    HEUTE.orbitDa = true;
    heuteZeigen();

    // Letzte Rechnungen
    var rech = abfrage(db, "SELECT r.nummer, r.datum, r.brutto, r.status, r.faellig_am, r.typ, k.firma, k.vorname, k.nachname FROM rechnungen r LEFT JOIN kunden k ON k.id = r.kunde_id WHERE r.typ IN ('rechnung','storno') AND r.status != 'entwurf' ORDER BY r.datum DESC, r.id DESC LIMIT 5");
    if (!rech.length) { leer("l-rechnungen", "Noch keine gestellten Rechnungen."); return; }
    $("l-rechnungen").innerHTML = rech.map(function (r) {
      var stand = r.status === "bezahlt" ? ["bezahlt", "bezahlt"]
        : r.status === "storniert" ? ["", "storniert"]
        : (r.status === "offen" && r.faellig_am && r.faellig_am < heute) ? ["ueber", "überfällig"]
        : r.status === "offen" ? ["offen", "offen"] : ["", r.status];
      return '<li><span class="quelle">' + (r.typ === "storno" ? "KO" : "RE") + '</span><span class="t"><b>' + esc(kundenname(r)) + "</b><small>" + esc(r.nummer || "ohne Nummer") + " · " + datumDE(r.datum) + '</small></span><span class="r">' + euro((r.brutto || 0) * (r.typ === "storno" ? -1 : 1), true) + '</span><span class="stand ' + stand[0] + '">' + esc(stand[1]) + "</span></li>";
    }).join("");
  }

  function saeulen(reihe) {
    var max = Math.max.apply(null, reihe.map(function (r) { return r.wert; }).concat([1]));
    $("diagramm").innerHTML = reihe.map(function (r, i) {
      var h = Math.max(4, Math.round(Math.max(r.wert, 0) / max * 82));
      return '<div class="saeule' + (i === reihe.length - 1 ? " jetzt" : "") + '"><span class="b" style="height:' + h + '%"><em>' + euro(r.wert) + "</em></span><small>" + r.name + "</small></div>";
    }).join("");
    $("diagramm").setAttribute("aria-label", "Umsatz je Monat: " + reihe.map(function (r) { return r.name + " " + euro(r.wert); }).join(", "));
  }

  function linie(id, werte) {
    var max = Math.max.apply(null, werte.concat([1])), min = Math.min.apply(null, werte.concat([0]));
    var schritt = 88 / (werte.length - 1);
    $(id).setAttribute("d", werte.map(function (w, i) {
      return (i ? "L" : "M") + (2 + i * schritt).toFixed(1) + " " + (30 - (w - min) / (max - min || 1) * 26).toFixed(1);
    }).join(" "));
  }

  function orbitFehler(text) {
    ["z-umsatz", "z-offen"].forEach(function (id) { setzen(id, "–", esc(text)); });
    ["d-jahr", "d-schnitt", "d-best"].forEach(function (id) { $(id).textContent = "–"; });
    leer("l-rechnungen", text);
    HEUTE.orbitDa = true; heuteZeigen();
  }

  /* ---------------- Heute: MeinOrbit und Apple-Kalender zusammen ---------------- */

  var HEUTE = { orbit: [], aufgaben: [], apple: [], orbitDa: false, appleDa: false };

  function uhrzeit(iso) { var d = new Date(iso); return zwei(d.getHours()) + ":" + zwei(d.getMinutes()); }
  function tagVon(t) { return t.ganztags ? t.start : isoTag(new Date(t.start)); }
  function laeuftAn(t, tag) {
    if (!t.ganztags) return tagVon(t) === tag;
    // Ganztägig: Ende zählt nicht mehr mit (so liefert Apple es)
    return t.start <= tag && (t.ende && t.ende !== t.start ? t.ende > tag : t.start === tag);
  }

  function heuteZeigen() {
    if (!HEUTE.orbitDa && !HEUTE.appleDa) return;
    var jetzt = new Date(), uhr = zwei(jetzt.getHours()) + ":" + zwei(jetzt.getMinutes());
    var termine = HEUTE.orbit.concat(HEUTE.apple).sort(function (a, b) { return (a.zeit || "00:00").localeCompare(b.zeit || "00:00"); });
    var alle = termine.concat(HEUTE.aufgaben);
    var naechster = termine.filter(function (t) { return t.zeit && t.zeit > uhr; })[0];
    setzen("z-heute", String(alle.length),
      naechster ? "nächster Termin um " + esc(naechster.zeit) + " Uhr"
        : termine.length + (termine.length === 1 ? " Termin, " : " Termine, ") + HEUTE.aufgaben.length + (HEUTE.aufgaben.length === 1 ? " Aufgabe" : " Aufgaben"));
    if (!$("l-heute")) return; // Kasten „Heute“ ist derzeit nicht auf der Übersicht
    if (!alle.length) { leer("l-heute", "Heute stehen keine Termine oder Aufgaben an."); return; }
    $("l-heute").innerHTML = alle.slice(0, 6).map(function (t) {
      return '<li><span class="zeit">' + (t.zeit ? esc(t.zeit) : (t.aufgabe ? "Aufg." : "ganzt.")) + '</span><span class="strich" style="background:' + t.farbe + '"></span><span class="t"><b>' + esc(t.titel) + "</b><small>" + esc(t.unter) + "</small></span></li>";
    }).join("");
  }

  /* ---------------- Konten: Mails und Apple-Kalender ---------------- */

  var KONTEN = { liste: [], mails: [], filter: "alle", aktiv: null };

  function nichtVerbunden(text) {
    leer("mails-kurz", text);
    $("mails-lang").innerHTML = '<li class="leer">' + esc(text) + "</li>";
    $("lesen").innerHTML = '<p class="platz">' + esc(text) + "</p>";
    $("kal-liste").innerHTML = '<p class="platz">' + esc(text) + "</p>";
    if ($("woche")) $("woche").innerHTML = '<p class="leer-text">' + esc(text) + "</p>";
    leer("l-erin", text);
  }

  async function kontenLaden() {
    var r;
    try {
      r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "uebersicht" } });
    } catch (f) { r = { error: f }; }
    if (r.error || !r.data) {
      nichtVerbunden("Mails und Kalender sind noch nicht verbunden.");
      HEUTE.appleDa = true; heuteZeigen();
      return;
    }
    var d = r.data;
    KONTEN.liste = d.konten || [];
    KONTEN.mails = d.mails || [];
    if (d.fehler && d.fehler.length) console.warn("Konten:", d.fehler);

    // Kalender
    var heute = isoTag(new Date());
    HEUTE.apple = (d.termine || []).filter(function (t) { return laeuftAn(t, heute); }).map(function (t) {
      return { zeit: t.ganztags ? "" : uhrzeit(t.start), titel: t.titel, farbe: t.farbe || "var(--blau-hell)",
        unter: t.kalender + (t.ort ? " · " + t.ort.split("\n")[0] : "") };
    });
    HEUTE.appleDa = true; heuteZeigen();
    kalenderZeigen(d);
    wocheZeigen(d);
    erinnerungenZeigen(d);

    // Mails
    if (!KONTEN.liste.length) { nichtVerbunden("Mails und Kalender sind noch nicht verbunden."); kalenderZeigen(d); return; }
    var summe = 0;
    Object.keys(d.ungelesen || {}).forEach(function (k) { summe += d.ungelesen[k]; });
    $("mail-zahl").textContent = summe ? summe + " ungelesen" : "Alle ansehen";
    var fehlerText = (d.fehler || []).filter(function (f) { return !/^Kalender/.test(f); });
    if (KONTEN.mails.length) $("mails-kurz").innerHTML = KONTEN.mails.slice(0, 4).map(mailZeile).join("");
    else leer("mails-kurz", fehlerText.length ? fehlerText.join(" · ") : "Keine Mails im Posteingang.");
    if (fehlerText.length && KONTEN.mails.length) $("mails-kurz").insertAdjacentHTML("beforeend", '<li class="leer">' + esc(fehlerText.join(" · ")) + "</li>");

    var knoepfe = [{ s: "alle", n: "Alle" }].concat(KONTEN.liste.map(function (k) { return { s: k.schluessel, n: k.name }; }));
    $("konten-knoepfe").innerHTML = knoepfe.map(function (k) {
      return '<button type="button" data-konto="' + esc(k.s) + '" aria-pressed="' + (k.s === KONTEN.filter) + '">' + esc(k.n) + "</button>";
    }).join("");
    mailListe();
  }

  function kuerzel(m) { return m.konto.indexOf("gmail") === 0 ? "G" : "iC"; }
  function mailZeit(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isoTag(d) === isoTag(new Date()) ? uhrzeit(iso) : d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  function mailZeile(m) {
    var i = KONTEN.mails.indexOf(m);
    return '<li data-mail="' + i + '" class="' + (m.neu ? "neu" : "") + '"><span class="quelle">' + kuerzel(m) + '</span><span class="t"><b>' + esc(m.von) + "</b><small>" + esc(m.betreff) + '</small></span><span class="r">' + mailZeit(m.datum) + "</span></li>";
  }
  function mailListe() {
    var liste = KONTEN.mails.filter(function (m) { return KONTEN.filter === "alle" || m.konto === KONTEN.filter; });
    $("mails-lang").innerHTML = liste.length ? liste.map(mailZeile).join("") : '<li class="leer">Keine Mails.</li>';
    if (KONTEN.aktiv === null) $("lesen").innerHTML = '<p class="platz">Links eine Mail auswählen.</p>';
  }

  async function mailOeffnen(i) {
    var m = KONTEN.mails[i]; if (!m) return;
    KONTEN.aktiv = i;
    [].forEach.call($("mails-lang").children, function (li) { li.setAttribute("aria-current", li.dataset.mail == i); });
    var konto = KONTEN.liste.filter(function (k) { return k.schluessel === m.konto; })[0] || {};
    var oeffnen = konto.art === "gmail"
      ? "https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(konto.adresse || "")
      : "https://www.icloud.com/mail/";
    var kopfHtml = '<div class="kopfzeile"><span class="person">' + esc((m.von || "?").charAt(0).toUpperCase()) + "</span><div><b>" + esc(m.von) + '</b><div style="color:var(--schrift-3);font-size:13px">' + esc(m.vonAdresse) + " · " + esc(m.kontoName) + (m.datum ? " · " + new Date(m.datum).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "") + "</div></div></div><h3>" + esc(m.betreff) + "</h3>";
    $("lesen").innerHTML = kopfHtml + '<p class="text wenig">Wird geladen …</p>';
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "mail", konto: m.konto, uid: m.uid } }); }
    catch (f) { r = { error: f }; }
    if (KONTEN.aktiv !== i) return; // inzwischen andere Mail angeklickt
    if (r.error || !r.data || r.data.fehler) { $("lesen").innerHTML = kopfHtml + '<p class="text">Die Mail ließ sich nicht laden.</p>'; return; }
    var d = r.data;
    $("lesen").innerHTML = kopfHtml + '<div class="text">' + esc(d.text || "(kein Text)") + "</div>" +
      (d.anhaenge && d.anhaenge.length ? '<p class="anh">Anhänge: ' + esc(d.anhaenge.join(", ")) + "</p>" : "") +
      '<a class="knopf link" href="' + esc(oeffnen) + '" target="_blank" rel="noopener">In ' + esc(konto.art === "gmail" ? "Gmail" : "iCloud Mail") + " antworten</a>";
  }

  function kalenderZeigen(d) {
    if (!d.kalenderVerbunden) { $("kal-liste").innerHTML = '<p class="platz">Der Apple-Kalender ist noch nicht verbunden.</p>'; return; }
    var fehler = (d.fehler || []).filter(function (f) { return /^Kalender/.test(f); });
    var tage = [];
    for (var i = 0; i < 7; i++) { var t = new Date(); t.setDate(t.getDate() + i); tage.push(isoTag(t)); }
    var html = tage.map(function (tag, n) {
      var liste = (d.termine || []).filter(function (t) { return laeuftAn(t, tag); });
      var name = n === 0 ? "Heute" : n === 1 ? "Morgen" : new Date(tag + "T12:00").toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
      return "<h3>" + name + '</h3><ul class="liste">' + (liste.length ? liste.map(function (t) {
        return '<li><span class="zeit">' + (t.ganztags ? "ganzt." : uhrzeit(t.start)) + '</span><span class="strich" style="background:' + esc(t.farbe || "var(--blau-hell)") + '"></span><span class="t"><b>' + esc(t.titel) + "</b><small>" + esc(t.kalender) + (t.ort ? " · " + esc(t.ort.split("\n")[0]) : "") + (!t.ganztags && t.ende ? " · bis " + uhrzeit(t.ende) : "") + "</small></span></li>";
      }).join("") : '<li class="leer">Keine Termine</li>') + "</ul>";
    }).join("");
    $("kal-liste").innerHTML = (fehler.length ? '<p class="platz">' + esc(fehler.join(" · ")) + "</p>" : "") + html;
  }

  /* ---------------- Bad Salzuflen ---------------- */

  function bsn(pfad) {
    return fetch(BSN.url + pfad, { headers: { apikey: BSN.key } }).then(function (r) {
      if (!r.ok) throw new Error("Bad Salzuflen News nicht erreichbar");
      return r.json();
    });
  }

  async function badSalzuflen() {
    var heute = isoTag(new Date());
    var mitternacht = new Date(); mitternacht.setHours(0, 0, 0, 0);
    try {
      var teile = await Promise.all([
        bsn("/articles?select=title,category,slug,published_at&status=eq.published&order=published_at.desc&limit=20"),
        bsn("/blaulicht?select=title,place,source_id,published_at&hidden=eq.false&order=published_at.desc&limit=1"),
        bsn("/events?select=title,starts_on,starts_at,location&starts_on=gte." + heute + "&order=starts_on.asc,starts_at.asc&limit=10")
      ]);
      var jetztUhr = zwei(new Date().getHours()) + ":" + zwei(new Date().getMinutes());
      var artikel = teile[0], blau = teile[1];
      // Heute schon vorbei? Dann den nächsten nehmen
      var termin = teile[2].filter(function (t) { return t.starts_on > heute || !t.starts_at || t.starts_at.slice(0, 5) >= jetztUhr; }).slice(0, 1);
      var neuHeute = artikel.filter(function (a) { return new Date(a.published_at) >= mitternacht; }).length;
      setzen("z-news", String(neuHeute), neuHeute === 1 ? "Meldung seit Mitternacht" : "Meldungen seit Mitternacht");
      var z = artikel.slice(0, 3).map(function (a) {
        return '<li><a href="' + BSN.seite + "artikel.html?s=" + encodeURIComponent(a.slug) + '" target="_blank" rel="noopener"><span class="punkt" style="background:var(--petrol)"></span><span class="t"><b>' + esc(a.title) + "</b><small>" + esc(a.category) + " · " + vorWann(a.published_at) + "</small></span></a></li>";
      });
      blau.forEach(function (b) {
        z.push('<li><a href="' + BSN.seite + "blaulicht.html?m=" + encodeURIComponent(b.source_id) + '" target="_blank" rel="noopener"><span class="punkt" style="background:var(--pink)"></span><span class="t"><b>' + esc(b.title) + "</b><small>Blaulicht · " + esc(b.place) + " · " + vorWann(b.published_at) + "</small></span></a></li>");
      });
      termin.forEach(function (t) {
        var tag = t.starts_on === heute ? "heute" : new Date(t.starts_on + "T12:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
        z.push('<li><a href="' + BSN.seite + 'termine.html" target="_blank" rel="noopener"><span class="punkt" style="background:var(--gelb)"></span><span class="t"><b>' + esc(t.title) + "</b><small>Nächster Termin · " + tag + (t.starts_at ? ", " + esc(t.starts_at) + " Uhr" : "") + (t.location ? " · " + esc(t.location) : "") + "</small></span></a></li>");
      });
      if (z.length) $("l-bs").innerHTML = z.join(""); else leer("l-bs", "Gerade keine Meldungen.");
    } catch (f) {
      setzen("z-news", "–", "nicht erreichbar");
      leer("l-bs", "Bad Salzuflen News ist gerade nicht erreichbar.");
    }
  }

  /* ---------------- Welt ---------------- */

  var RESSORT = { inland: "Inland", ausland: "Ausland", wirtschaft: "Wirtschaft", sport: "Sport", wissen: "Wissen", investigativ: "Investigativ", faktenfinder: "Faktenfinder" };

  async function welt() {
    try {
      var r = await fetch("https://www.tagesschau.de/api2u/homepage/");
      if (!r.ok) throw new Error();
      var d = await r.json();
      var liste = (d.news || []).filter(function (n) { return n.title && n.shareURL && n.type !== "video"; }).slice(0, 5);
      if (!liste.length) throw new Error();
      $("l-welt").innerHTML = liste.map(function (n) {
        return '<li><a href="' + esc(n.shareURL) + '" target="_blank" rel="noopener"><span class="quelle">TS</span><span class="t"><b>' + esc(n.title) + "</b><small>" + esc(RESSORT[n.ressort] || "tagesschau") + (n.date ? " · " + vorWann(n.date) : "") + "</small></span></a></li>";
      }).join("");
    } catch (f) {
      leer("l-welt", "Die Schlagzeilen der Tagesschau sind gerade nicht erreichbar.");
    }
  }

  /* ---------------- Aufrufe Bad Salzuflen News ---------------- */

  async function aufrufeLaden() {
    var jetzt = new Date(), grenzen = [];
    for (var i = 13; i >= 0; i--) { var t = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() - i); grenzen.push(t.toISOString()); }
    grenzen.push(jetzt.toISOString());
    var gestern0 = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() - 1);
    var gesternJetzt = new Date(jetzt.getTime() - 24 * 3600e3);
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "aufrufe", grenzen: grenzen, vergleich: [gestern0.toISOString(), gesternJetzt.toISOString()] } }); }
    catch (f) { r = { error: f }; }
    if (r.error || !r.data) { setzen("z-aufrufe", "–", "nicht erreichbar"); return; }
    if (r.data.fehlt) { setzen("z-aufrufe", "–", "noch nicht verbunden"); return; }
    var z = r.data.zahlen || [], heute = z[z.length - 1] || 0, gestern = r.data.gestern;
    var tausend = function (n) { return n.toLocaleString("de-DE"); };
    var vergleich = gestern > 0
      ? '<span class="' + (heute >= gestern ? "plus" : "minus") + '">' + (heute >= gestern ? "+" : "") + Math.round((heute - gestern) / gestern * 100) + " %</span> zu gestern um diese Zeit"
      : "gestern um diese Zeit: " + tausend(gestern || 0);
    setzen("z-aufrufe", tausend(heute), vergleich);
    // Verlauf: abgeschlossene Tage plus heute bis jetzt
    if (z.length > 1) linie("l-aufrufe", z);
    $("l-aufrufe").closest("svg").setAttribute("aria-label", "Aufrufe der letzten 14 Tage: " + z.map(tausend).join(", "));
  }

  /* ---------------- Instagram ---------------- */

  // Reichweite wie in den Mediadaten: „410 Tsd.+“ (abgerundet, nie aufgerundet)
  function tsd(n) {
    if (n == null) return "–";
    return n >= 1000 ? Math.floor(n / 1000).toLocaleString("de-DE") + " Tsd.+" : n.toLocaleString("de-DE");
  }

  async function instagramLaden() {
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "instagram" } }); }
    catch (f) { r = { error: f }; }
    if (r.error || !r.data) { setzen("z-ig", "–", "nicht erreichbar"); return; }
    var d = r.data;
    if (d.fehlt) { setzen("z-ig", "–", "noch nicht verbunden"); return; }
    if (d.name) $("ig-name").textContent = "@" + d.name;
    // Follower genau, Aufrufe gerundet
    setzen("z-ig", d.follower != null ? d.follower.toLocaleString("de-DE") : "–", "Follower · " + (d.aufrufe != null ? tsd(d.aufrufe) + " Aufrufe in 30 Tagen" : "Aufrufe noch nicht verfügbar"));
    $("z-ig").setAttribute("aria-label", (d.follower || 0).toLocaleString("de-DE") + " Follower");
    if (d.verlauf && d.verlauf.length > 1) linie("l-ig", d.verlauf);
  }

  /* ---------------- Schlagzeilen BILD / NIUS ----------------
     Eine Schlagzeile nach der anderen, alle 7 Sekunden die nächste; hält an,
     solange die Maus darauf liegt oder der Tab verdeckt ist. */
  var SZ = { liste: [], nr: 0, uhr: null, pause: false };

  function szFuellen() {
    var s = SZ.liste[SZ.nr]; if (!s) return;
    $("sz-link").href = s.link;
    $("sz-kopf").innerHTML = "<b>" + esc(s.quelle) + "</b>" + (s.zeit ? " · " + vorWann(s.zeit) : "");
    $("sz-titel").textContent = s.titel;
    [].forEach.call($("sz-punkte").children, function (b, i) { b.setAttribute("aria-current", i === SZ.nr); });
    // Vorschau: die zwei folgenden Schlagzeilen
    var n = SZ.liste.length, danach = [];
    for (var k = 1; k <= 2 && k < n; k++) danach.push((SZ.nr + k) % n);
    $("sz-danach").innerHTML = danach.map(function (i) {
      var d = SZ.liste[i];
      return '<li data-nr="' + i + '"><span class="q">' + esc(d.quelle) + '</span><span class="t">' + esc(d.titel) + "</span></li>";
    }).join("");
    // Fortschrittsbalken neu starten; sein Ende schaltet zur nächsten Schlagzeile
    var b = $("sz-balken"); b.classList.remove("lauf"); void b.offsetWidth; b.classList.add("lauf");
  }
  function szZeigen(nr) {
    SZ.nr = (nr + SZ.liste.length) % SZ.liste.length;
    var karte = $("sz-karte");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { szFuellen(); return; }
    karte.classList.add("aus");
    setTimeout(function () { szFuellen(); karte.classList.remove("aus"); }, 220);
  }
  async function schlagzeilenLaden() {
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "schlagzeilen" } }); }
    catch (f) { r = { error: f }; }
    SZ.liste = ((r && r.data && r.data.schlagzeilen) || []).slice(0, 21); // je Quelle etwa 7
    if (r.error || !SZ.liste.length) { $("sz-kopf").textContent = "Gerade keine Schlagzeilen erreichbar."; return; }
    $("sz-punkte").innerHTML = SZ.liste.map(function (s, i) {
      return '<button type="button" data-nr="' + i + '" aria-label="Schlagzeile ' + (i + 1) + ' zeigen"></button>';
    }).join("");
    SZ.nr = 0; szFuellen();
    clearInterval(SZ.uhr);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // ohne Animation: einfacher Takt
      SZ.uhr = setInterval(function () { if (!SZ.pause && !document.hidden) szZeigen(SZ.nr + 1); }, 7000);
    }
  }

  /* ---------------- Wochenübersicht und Erinnerungen ---------------- */

  var WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  function wocheZeigen(d) {
    if (!$("woche")) return;
    if (!d.kalenderVerbunden) { $("woche").innerHTML = '<p class="leer-text">Der Apple-Kalender ist noch nicht verbunden.</p>'; return; }
    var html = "";
    for (var i = 0; i < 7; i++) {
      var t = new Date(); t.setDate(t.getDate() + i);
      var tag = isoTag(t);
      var liste = (d.termine || []).filter(function (x) { return laeuftAn(x, tag); });
      var zeilen = liste.slice(0, 5).map(function (x) {
        return '<div class="termin"' + (x.farbe ? ' style="--f:' + esc(x.farbe) + '"' : "") + '><small>' + (x.ganztags ? "ganztägig" : uhrzeit(x.start)) + "</small><span>" + esc(x.titel) + "</span></div>";
      }).join("");
      if (liste.length > 5) zeilen += '<span class="weitere">+' + (liste.length - 5) + " weitere</span>";
      if (!liste.length) zeilen = '<span class="frei">frei</span>';
      html += '<div class="tag' + (i === 0 ? " heute" : "") + (t.getDay() === 0 || t.getDay() === 6 ? " wochenende" : "") + '"><span class="tk">' + (i === 0 ? "Heute" : WOCHENTAG[t.getDay()]) + "<b>" + t.getDate() + ".</b></span>" + zeilen + "</div>";
    }
    $("woche").innerHTML = html;
  }

  function erinnerungenZeigen(d) {
    if (!$("l-erin")) return;
    var e = d.erinnerungen || [];
    if ($("erin-stand")) $("erin-stand").textContent = d.erinnerungenStand ? "vom iPhone, " + vorWann(d.erinnerungenStand) : "iCloud";
    if (!e.length) {
      leer("l-erin", d.erinnerungenStand
        ? "Keine offenen Erinnerungen."
        : "Noch keine Erinnerungen vom iPhone empfangen. Der Kurzbefehl schickt sie hierher.");
      return;
    }
    var heute = isoTag(new Date());
    // Mit Fälligkeit zuerst (älteste oben), danach die ohne Datum
    e = e.slice().sort(function (a, b) { return String(a.faellig || "9999").localeCompare(String(b.faellig || "9999")); });
    if ($("erin-stand") && d.erinnerungenStand) $("erin-stand").textContent = e.length + " offen · vom iPhone, " + vorWann(d.erinnerungenStand);
    $("l-erin").innerHTML = e.slice(0, 6).map(function (x) {
      var f = x.faellig ? (x.ganztags ? x.faellig : isoTag(new Date(x.faellig))) : "";
      var spaet = f && f < heute;
      var wann = !f ? "ohne Datum" : f === heute ? "heute" + (x.ganztags ? "" : ", " + uhrzeit(x.faellig) + " Uhr") : datumDE(f);
      return '<li><span class="strich" style="background:' + (spaet ? "var(--pink)" : esc(x.farbe || "rgba(255,255,255,.35)")) + '"></span><span class="t"><b>' + esc(x.titel) + "</b><small>" + esc(x.liste) + " · " + (spaet ? "überfällig seit " : "") + wann + "</small></span></li>";
    }).join("");
  }

  /* ---------------- Aktien ---------------- */

  function zahlDE(n, stellen) { return n.toLocaleString("de-DE", { minimumFractionDigits: stellen, maximumFractionDigits: stellen }); }

  function aktienZeigen(liste) {
    if (!liste || !liste.length) { $("l-aktien").innerHTML = '<p class="leer-text">Keine Kurse.</p>'; return; }
    $("l-aktien").innerHTML = liste.map(function (a) {
      if (a.fehler || a.kurs == null) return '<div class="aktie"><span class="n">' + esc(a.symbol) + '</span><span class="s">nicht erreichbar</span></div>';
      var w = a.waehrung === "EUR" ? " €" : a.waehrung === "USD" ? " $" : " " + esc(a.waehrung || "");
      var stellen = a.kurs >= 1000 ? 0 : 2;
      var plus = a.aenderung != null && a.aenderung >= 0;
      var farbe = a.aenderung == null ? "var(--schrift-3)" : plus ? "#86efac" : "#ffb3c0";
      var v = (a.verlauf || []).slice(-22), pfad = "";
      if (v.length > 1) {
        var max = Math.max.apply(null, v), min = Math.min.apply(null, v), sp = 100 / (v.length - 1);
        pfad = v.map(function (x, i) { return (i ? "L" : "M") + (i * sp).toFixed(1) + " " + (28 - (x - min) / (max - min || 1) * 26).toFixed(1); }).join(" ");
      }
      return '<div class="aktie" title="' + esc(a.symbol) + '"><span class="n">' + esc(a.name) + '</span><span class="s">' + esc(a.symbol) + '</span>' +
        '<span class="k">' + zahlDE(a.kurs, stellen) + w + '</span>' +
        '<span class="a" style="color:' + farbe + '">' + (a.aenderung == null ? "–" : (plus ? "▲ +" : "▼ ") + zahlDE(a.aenderung, 2) + " %") + " heute</span>" +
        (pfad ? '<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="' + pfad + '" stroke="' + farbe + '" vector-effect="non-scaling-stroke"/></svg>' : "") + "</div>";
    }).join("");
    var zeiten = liste.map(function (a) { return a.zeit; }).filter(Boolean).sort();
    if (zeiten.length) $("aktien-stand").textContent = "Stand " + new Date(zeiten[zeiten.length - 1]).toLocaleString("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · etwa 15 Min. verzögert";
  }

  /* Dritte Kachel: zeigt die Aktien einzeln im Wechsel. Alle 5 Sekunden die
     nächste; hält an, solange die Maus darauf liegt oder der Tab verdeckt ist. */
  var TICKER = { liste: [], nr: 0, uhr: null, pause: false };

  function tickerFuellen() {
    var a = TICKER.liste[TICKER.nr]; if (!a) return;
    var w = a.waehrung === "EUR" ? " €" : a.waehrung === "USD" ? " $" : " " + (a.waehrung || "");
    var plus = a.aenderung != null && a.aenderung >= 0;
    var farbe = a.aenderung == null ? "var(--schrift-3)" : plus ? "#86efac" : "#ffb3c0";
    $("t-name").textContent = a.name;
    $("t-symbol").textContent = a.symbol;
    $("t-kurs").textContent = zahlDE(a.kurs, a.kurs >= 1000 ? 0 : 2) + w;
    $("t-aend").innerHTML = a.aenderung == null ? "–" : '<span style="color:' + farbe + '">' + (plus ? "▲ +" : "▼ ") + zahlDE(a.aenderung, 2) + " %</span> heute";
    $("l-ticker").setAttribute("stroke", farbe);
    if ((a.verlauf || []).length > 1) linie("l-ticker", a.verlauf.slice(-22)); else $("l-ticker").setAttribute("d", "");
    [].forEach.call($("t-punkte").children, function (b, i) { b.setAttribute("aria-current", i === TICKER.nr); });
  }

  function tickerZeigen(nr) {
    TICKER.nr = (nr + TICKER.liste.length) % TICKER.liste.length;
    var karte = $("ticker");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { tickerFuellen(); return; }
    karte.classList.add("aus");
    setTimeout(function () { tickerFuellen(); karte.classList.remove("aus"); }, 220);
  }

  function tickerStart(liste) {
    TICKER.liste = liste.filter(function (a) { return !a.fehler && a.kurs != null; });
    if (!TICKER.liste.length) { $("t-aend").textContent = "nicht erreichbar"; return; }
    $("t-punkte").innerHTML = TICKER.liste.map(function (a, i) {
      return '<button type="button" data-nr="' + i + '" aria-label="' + esc(a.name) + ' zeigen"></button>';
    }).join("");
    TICKER.nr = 0; tickerFuellen();
    clearInterval(TICKER.uhr);
    TICKER.uhr = setInterval(function () {
      if (!TICKER.pause && !document.hidden) tickerZeigen(TICKER.nr + 1);
    }, 5000);
  }

  async function aktienLaden() {
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: { aktion: "aktien" } }); }
    catch (f) { r = { error: f }; }
    if (r.error || !r.data || !r.data.aktien) {
      $("l-aktien").innerHTML = '<p class="leer-text">Die Kurse sind gerade nicht erreichbar.</p>';
      $("t-aend").textContent = "nicht erreichbar";
      return;
    }
    aktienZeigen(r.data.aktien);
    tickerStart(r.data.aktien);
  }

  /* ---------------- Start ---------------- */

  badSalzuflen();
  welt();

  if (!sb) { orbitFehler("Keine Verbindung zu MeinOrbit eingerichtet."); return; }

  $("abmelden").addEventListener("click", function () {
    sb.auth.signOut().then(function () { location.replace("anmelden.html"); });
  });

  $("ticker").addEventListener("mouseenter", function () { TICKER.pause = true; });
  $("ticker").addEventListener("mouseleave", function () { TICKER.pause = false; });
  $("ticker").addEventListener("focusin", function () { TICKER.pause = true; });
  $("ticker").addEventListener("focusout", function () { TICKER.pause = false; });
  function szHalt(an) { SZ.pause = an; $("sz-karte").classList.toggle("halt", an); }
  $("sz-karte").addEventListener("mouseenter", function () { szHalt(true); });
  $("sz-karte").addEventListener("mouseleave", function () { szHalt(false); });
  $("sz-karte").addEventListener("focusin", function () { szHalt(true); });
  $("sz-karte").addEventListener("focusout", function () { szHalt(false); });
  $("sz-danach").addEventListener("click", function (e) {
    var li = e.target.closest("[data-nr]"); if (li) szZeigen(+li.dataset.nr);
  });
  $("sz-balken").addEventListener("animationend", function () { if (SZ.liste.length) szZeigen(SZ.nr + 1); });
  $("sz-punkte").addEventListener("click", function (e) {
    var b = e.target.closest("[data-nr]"); if (b) szZeigen(+b.dataset.nr);
  });
  $("t-punkte").addEventListener("click", function (e) {
    var b = e.target.closest("[data-nr]"); if (b) tickerZeigen(+b.dataset.nr);
  });

  $("konten-knoepfe").addEventListener("click", function (e) {
    var b = e.target.closest("[data-konto]"); if (!b) return;
    KONTEN.filter = b.dataset.konto; KONTEN.aktiv = null;
    [].forEach.call(this.children, function (x) { x.setAttribute("aria-pressed", x === b); });
    mailListe();
  });
  $("mails-lang").addEventListener("click", function (e) { var li = e.target.closest("[data-mail]"); if (li) mailOeffnen(+li.dataset.mail); });
  $("mails-kurz").addEventListener("click", function (e) {
    var li = e.target.closest("[data-mail]"); if (!li) return;
    var ziel = document.querySelector('.reiter [data-ziel="mail"]'); if (ziel) ziel.click();
    mailOeffnen(+li.dataset.mail);
  });

  sb.auth.getSession().then(function (r) {
    if (!r.data.session) { location.replace("anmelden.html"); return; }
    kontenLaden();
    aktienLaden();
    aufrufeLaden();
    instagramLaden();
    schlagzeilenLaden();
    orbitLaden().then(orbitZeigen).catch(function (f) {
      console.error(f);
      orbitFehler("MeinOrbit ließ sich nicht laden.");
    });
  });
})();
