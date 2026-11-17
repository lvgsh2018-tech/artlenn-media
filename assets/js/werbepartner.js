/* Werbepartner-Kachel für dashboard.html und team.html (gemeinsame Liste).
   Die Seite legt <article id="wp-karte"> an und ruft AM_WP.start(abruf) nach der
   Anmeldung auf. Gespeichert wird über den Abruf „dashboard-konten“
   (Aktionen werbepartner, werbepartner-speichern, werbepartner-loeschen). */
(function () {
  var STATUS = [
    { id: "neu", name: "Noch nicht angefragt", kurz: "Offen" },
    { id: "angerufen", name: "Angerufen", kurz: "Angerufen" },
    { id: "warten", name: "Wartet auf Rückmeldung", kurz: "Wartet" },
    { id: "zusage", name: "Zusage", kurz: "Zusage" },
    { id: "absage", name: "Kein Interesse", kurz: "Absage" },
  ];
  var NAME = {}; STATUS.forEach(function (s) { NAME[s.id] = s; });
  var FELDER = [
    ["firma", "Firma oder Name", "text", 120, "voll"],
    ["ansprechpartner", "Ansprechperson", "text", 120],
    ["branche", "Branche", "text", 80],
    ["strasse", "Straße und Hausnummer", "text", 120, "voll"],
    ["plz", "PLZ", "text", 10, "plz"],
    ["ort", "Ort", "text", 80],
    ["telefon", "Telefon", "tel", 40],
    ["email", "E-Mail", "email", 120],
    ["webseite", "Webseite", "url", 200, "voll"],
  ];

  var W = { abruf: null, liste: null, filter: "alle", offen: null, laeuft: false };

  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function zwei(n) { return n < 10 ? "0" + n : "" + n; }
  function heute() { var d = new Date(); return d.getFullYear() + "-" + zwei(d.getMonth() + 1) + "-" + zwei(d.getDate()); }
  function datumDE(iso) { var t = String(iso || "").slice(0, 10).split("-"); return t.length === 3 ? +t[2] + "." + +t[1] + "." + t[0] : ""; }
  function vorWann(iso) {
    var d = new Date(iso), min = Math.round((Date.now() - d) / 60000);
    if (isNaN(min)) return "";
    if (min < 1) return "gerade eben";
    if (min < 60) return "vor " + min + " Min.";
    if (min < 24 * 60) return "vor " + Math.round(min / 60) + " Std.";
    if (min < 48 * 60) return "gestern";
    return "am " + d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  function neueId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function ampel(status) { return '<span class="wp-ampel" data-s="' + esc(status) + '" aria-hidden="true"></span>'; }
  function telLink(t) { return "tel:" + String(t).replace(/[^\d+]/g, ""); }

  /* ---------- Kachel ---------- */

  function kachelBauen() {
    var k = $("wp-karte"); if (!k || k.dataset.fertig) return;
    k.dataset.fertig = "1";
    k.innerHTML =
      '<h2>Werbepartner <button type="button" class="wp-neu" data-wp-neu><span aria-hidden="true">+</span> Neu</button></h2>' +
      '<div class="wp-filter" role="group" aria-label="Nach Stand filtern"></div>' +
      '<ul class="liste wp-liste" id="wp-liste"><li class="leer">wird geladen</li></ul>';
    k.addEventListener("click", function (e) {
      if (e.target.closest("[data-wp-neu]")) { oeffnen(null); return; }
      var f = e.target.closest("[data-wp-filter]");
      if (f) { W.filter = f.dataset.wpFilter; zeigen(); return; }
      if (e.target.closest("a")) return; // Anrufen/Mail direkt aus der Liste
      var li = e.target.closest("[data-wp]");
      if (li) oeffnen(li.dataset.wp);
    });
    k.addEventListener("keydown", function (e) {
      var li = e.target.closest("[data-wp]");
      if (li && e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); oeffnen(li.dataset.wp); }
    });
  }

  function sortiert() {
    var h = heute();
    return (W.liste || []).slice().sort(function (a, b) {
      // Fällige Wiedervorlagen zuerst, dann Absagen ans Ende, sonst zuletzt geändert oben
      var fa = a.wiedervorlage && a.wiedervorlage <= h ? 0 : 1, fb = b.wiedervorlage && b.wiedervorlage <= h ? 0 : 1;
      if (fa !== fb) return fa - fb;
      var xa = a.status === "absage" ? 1 : 0, xb = b.status === "absage" ? 1 : 0;
      if (xa !== xb) return xa - xb;
      return String(b.geaendert || "").localeCompare(String(a.geaendert || ""));
    });
  }

  function zeigen() {
    var ul = $("wp-liste"); if (!ul) return;
    var alle = W.liste || [], zahl = { alle: alle.length };
    alle.forEach(function (p) { zahl[p.status] = (zahl[p.status] || 0) + 1; });
    var filter = document.querySelector("#wp-karte .wp-filter");
    filter.innerHTML = [{ id: "alle", kurz: "Alle" }].concat(STATUS).map(function (s) {
      var an = W.filter === s.id;
      return '<button type="button" data-wp-filter="' + s.id + '" aria-pressed="' + an + '">' + (s.id === "alle" ? "" : ampel(s.id)) + esc(s.kurz) + ' <b>' + (zahl[s.id] || 0) + "</b></button>";
    }).join("");
    var h = heute();
    var liste = sortiert().filter(function (p) {
      return W.filter === "alle" || p.status === W.filter;
    });
    if (!alle.length) { ul.innerHTML = '<li class="leer">Noch keine Werbepartner. Oben auf „Neu“ tippen.</li>'; return; }
    if (!liste.length) { ul.innerHTML = '<li class="leer">Keine Treffer.</li>'; return; }
    ul.innerHTML = liste.map(function (p) {
      var s = NAME[p.status] || NAME.neu, faellig = p.wiedervorlage && p.wiedervorlage <= h;
      var zweite = esc(s.name) + (faellig ? ' · <em>Wiedervorlage ' + (p.wiedervorlage === h ? "heute" : "seit " + datumDE(p.wiedervorlage)) + "</em>"
        : p.geaendertVon ? " · " + esc(p.geaendertVon) + " " + vorWann(p.geaendert) : "");
      return '<li data-wp="' + esc(p.id) + '" tabindex="0" aria-label="' + esc(p.firma + ", " + s.name) + '">' + ampel(p.status) +
        '<span class="t"><b>' + esc(p.firma) + (p.ort ? ' <span class="wp-ort">' + esc(p.ort) + "</span>" : "") + "</b><small>" + zweite + "</small></span>" +
        (p.telefon ? '<a class="wp-anruf" href="' + esc(telLink(p.telefon)) + '" aria-label="' + esc(p.firma) + ' anrufen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg></a>' : "") +
        "</li>";
    }).join("");
  }

  async function laden() {
    if (!W.abruf || W.laeuft) return;
    W.laeuft = true;
    var d = await W.abruf({ aktion: "werbepartner" });
    W.laeuft = false;
    if (d.fehler) {
      if (!W.liste) { var ul = $("wp-liste"); if (ul) ul.innerHTML = '<li class="leer">' + esc(d.fehler === "Keine Berechtigung" ? "Die Werbepartner-Liste ist noch nicht freigeschaltet." : d.fehler) + "</li>"; }
      return;
    }
    W.liste = d.partner || [];
    zeigen();
  }

  /* ---------- Fenster zum Anlegen und Bearbeiten ---------- */

  function fensterBauen() {
    if ($("wp-fenster")) return $("wp-fenster");
    var dlg = document.createElement("dialog");
    dlg.id = "wp-fenster"; dlg.className = "wp-fenster glas"; dlg.setAttribute("aria-labelledby", "wp-titel");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) { dlg.close(); return; } // Klick neben das Fenster
      if (e.target.closest("[data-wp-zu]")) { dlg.close(); return; }
      var st = e.target.closest("[data-wp-status]");
      if (st) {
        dlg.querySelectorAll("[data-wp-status]").forEach(function (b) { b.setAttribute("aria-checked", b === st ? "true" : "false"); b.tabIndex = b === st ? 0 : -1; });
        return;
      }
      if (e.target.closest("[data-wp-weg]")) loeschen();
    });
    dlg.addEventListener("keydown", function (e) {
      var st = e.target.closest("[data-wp-status]"); if (!st) return;
      var alle = [].slice.call(dlg.querySelectorAll("[data-wp-status]")), i = alle.indexOf(st);
      var n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
      if (n === null) return;
      e.preventDefault(); n = (n + alle.length) % alle.length; alle[n].click(); alle[n].focus();
    });
    dlg.addEventListener("submit", function (e) { e.preventDefault(); speichern(); });
    dlg.addEventListener("close", function () { W.offen = null; });
    return dlg;
  }

  function oeffnen(id) {
    var dlg = fensterBauen();
    var p = id ? (W.liste || []).filter(function (x) { return x.id === id; })[0] : null;
    W.offen = p ? p.id : neueId();
    var status = p ? p.status : "neu";
    var verlauf = p && p.verlauf && p.verlauf.length ? p.verlauf.slice().reverse().slice(0, 8).map(function (v) {
      var t = v.was === "angelegt" ? "angelegt" : "→ " + (NAME[v.status] || NAME.neu).name;
      return "<li>" + ampel(v.status) + "<span>" + esc(t) + "</span><small>" + esc(v.von || "") + ", " + datumDE(v.am) + "</small></li>";
    }).join("") : "";
    var schnell = p ? [
      p.telefon ? '<a class="knopf leise" href="' + esc(telLink(p.telefon)) + '">Anrufen</a>' : "",
      p.email ? '<a class="knopf leise" href="mailto:' + esc(p.email) + '">E-Mail schreiben</a>' : "",
      p.webseite ? '<a class="knopf leise" href="' + esc(p.webseite) + '" target="_blank" rel="noopener">Webseite öffnen</a>' : "",
    ].join("") : "";
    dlg.innerHTML =
      '<form class="wp-form" novalidate>' +
        '<div class="wp-kopf"><h3 id="wp-titel">' + (p ? esc(p.firma) : "Neuer Werbepartner") + '</h3>' +
        '<button type="button" class="wp-x" data-wp-zu aria-label="Schließen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
        (schnell ? '<div class="wp-schnell">' + schnell + "</div>" : "") +
        '<fieldset class="wp-stand"><legend>Stand</legend><div role="radiogroup" aria-label="Stand">' +
          STATUS.map(function (s) {
            var an = s.id === status;
            return '<button type="button" role="radio" data-wp-status="' + s.id + '" aria-checked="' + an + '" tabindex="' + (an ? 0 : -1) + '">' + ampel(s.id) + esc(s.name) + "</button>";
          }).join("") +
        "</div></fieldset>" +
        '<div class="wp-felder">' +
          FELDER.map(function (f) {
            return '<label class="feld wp-f ' + (f[4] || "") + '"><span>' + esc(f[1]) + (f[0] === "firma" ? " *" : "") + '</span><input name="' + f[0] + '" type="' + f[2] + '" maxlength="' + f[3] + '" value="' + esc(p ? p[f[0]] : "") + '"' +
              (f[0] === "firma" ? ' required autocomplete="organization"' : f[0] === "telefon" ? ' autocomplete="tel"' : f[0] === "email" ? ' autocomplete="email"' : f[0] === "plz" ? ' inputmode="numeric" autocomplete="postal-code"' : ' autocomplete="off"') + "></label>";
          }).join("") +
          '<label class="feld wp-f"><span>Wiedervorlage am</span><input name="wiedervorlage" type="date" value="' + esc(p ? p.wiedervorlage : "") + '"></label>' +
          '<label class="feld wp-f voll"><span>Notiz</span><textarea name="notiz" maxlength="2000" rows="3" placeholder="z. B. Chef ist erst ab Montag da, Interesse an Paket für die Webseite">' + esc(p ? p.notiz : "") + "</textarea></label>" +
        "</div>" +
        (verlauf ? '<div class="wp-verlauf"><p>Verlauf</p><ul>' + verlauf + "</ul></div>" : "") +
        '<p class="wp-meldung" aria-live="polite"></p>' +
        '<div class="wp-fuss">' +
          (p ? '<button type="button" class="knopf leise wp-loeschen" data-wp-weg>Löschen</button>' : "<span></span>") +
          '<span class="wp-rechts"><button type="button" class="knopf leise" data-wp-zu>Abbrechen</button><button type="submit" class="knopf">Speichern</button></span>' +
        "</div>" +
      "</form>";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    if (!p) dlg.querySelector('input[name="firma"]').focus();
  }

  function meldung(text, fehler) {
    var m = document.querySelector("#wp-fenster .wp-meldung"); if (!m) return;
    m.textContent = text; m.classList.toggle("fehler", !!fehler);
  }

  async function speichern() {
    var dlg = $("wp-fenster"), f = dlg.querySelector("form");
    var p = { id: W.offen };
    FELDER.forEach(function (x) { p[x[0]] = f.elements[x[0]].value.trim(); });
    p.wiedervorlage = f.elements.wiedervorlage.value;
    p.notiz = f.elements.notiz.value.trim();
    var st = dlg.querySelector('[data-wp-status][aria-checked="true"]');
    p.status = st ? st.dataset.wpStatus : "neu";
    if (!p.firma) { meldung("Bitte einen Namen eintragen.", true); f.elements.firma.focus(); return; }
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) { meldung("Die E-Mail-Adresse sieht nicht vollständig aus.", true); f.elements.email.focus(); return; }
    var knopf = f.querySelector('[type="submit"]'); knopf.disabled = true; knopf.textContent = "Speichert …";
    meldung("");
    var d = await W.abruf({ aktion: "werbepartner-speichern", partner: p });
    knopf.disabled = false; knopf.textContent = "Speichern";
    if (d.fehler || !d.partner) { meldung(d.fehler || "Speichern hat nicht geklappt.", true); return; }
    W.liste = (W.liste || []).filter(function (x) { return x.id !== d.partner.id; }).concat([d.partner]);
    zeigen();
    dlg.close();
  }

  async function loeschen() {
    var p = (W.liste || []).filter(function (x) { return x.id === W.offen; })[0]; if (!p) return;
    if (!confirm("„" + p.firma + "“ wirklich aus der Liste löschen? Das lässt sich nicht rückgängig machen.")) return;
    var d = await W.abruf({ aktion: "werbepartner-loeschen", id: p.id });
    if (d.fehler) { meldung(d.fehler, true); return; }
    W.liste = W.liste.filter(function (x) { return x.id !== p.id; });
    zeigen();
    $("wp-fenster").close();
  }

  window.AM_WP = {
    start: function (abruf) { W.abruf = abruf; kachelBauen(); laden(); },
    // beim regelmäßigen Neuladen nicht stören, solange jemand gerade etwas einträgt
    neu: function () { if (!W.offen) laden(); },
  };
  kachelBauen();
})();
