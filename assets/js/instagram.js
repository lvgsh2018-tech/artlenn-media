/* Reiter „Instagram“: ausführliche Zahlen der letzten 30 Tage.
   Start: AM_IG.start(abruf, ziel) – abruf ist die Funktion, die den
   Supabase-Abruf „dashboard-konten“ aufruft; ziel das leere Element. */
(function () {
  "use strict";
  var ABRUF = null, ZIEL = null, DATEN = null, SORT = "aufrufe", LAEUFT = false;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ganz(n) { return n == null ? "–" : Number(n).toLocaleString("de-DE"); }
  function tsd(n) {
    if (n == null) return "–";
    return n >= 1000 ? Math.floor(n / 1000).toLocaleString("de-DE") + " Tsd.+" : n.toLocaleString("de-DE");
  }
  function kurz(n) {
    if (n == null) return "–";
    if (n >= 10000) return Math.round(n / 1000).toLocaleString("de-DE") + " Tsd.";
    if (n >= 1000) return (Math.round(n / 100) / 10).toLocaleString("de-DE") + " Tsd.";
    return n.toLocaleString("de-DE");
  }
  function tagText(iso) { return new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short" }); }
  function wochentag(tag) { return new Date(tag + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" }); }

  function veraenderung(k) {
    if (!k || k.jetzt == null || !k.davor) return '<span class="ig-ruhig">kein Vergleich</span>';
    var p = Math.round((k.jetzt - k.davor) / k.davor * 100);
    var hoch = p >= 0;
    return '<span class="' + (hoch ? "plus" : "minus") + '">' + (hoch ? "+" : "−") + Math.abs(p) + " %</span> zu den 30 Tagen davor";
  }

  /* ---------- Gerüst ---------- */

  function geruest() {
    ZIEL.innerHTML =
      '<div class="ig-kopfzeile"><p id="ig-stand">wird geladen</p><button type="button" class="ig-neu" id="ig-neu">Neu laden</button></div>' +
      '<div class="ig-kacheln" id="ig-kacheln"></div>' +
      '<div class="raster ig-raster">' +
        '<article class="k glas s8"><h2>Erreichte Konten je Tag <span class="mehr">letzte 30 Tage</span></h2><div class="ig-verlauf" id="ig-verlauf"><p class="ig-leer">wird geladen</p></div></article>' +
        '<article class="k glas s4"><h2>Interaktionen <span class="mehr">letzte 30 Tage</span></h2><div id="ig-interaktion"><p class="ig-leer">wird geladen</p></div></article>' +
        '<article class="k glas s8"><h2>Beste Beiträge <span class="ig-sortierung" role="group" aria-label="Sortieren nach">' +
          [["aufrufe", "Aufrufe"], ["likes", "Likes"], ["geteilt", "Geteilt"], ["gespeichert", "Gespeichert"]].map(function (s) {
            return '<button type="button" data-sort="' + s[0] + '" aria-pressed="' + (s[0] === SORT) + '">' + s[1] + "</button>";
          }).join("") +
        '</span></h2><ul class="ig-beitraege" id="ig-beitraege"><li class="ig-leer">wird geladen</li></ul></article>' +
        '<article class="k glas s4"><h2>Woher die Follower kommen</h2><div id="ig-staedte"><p class="ig-leer">wird geladen</p></div></article>' +
        '<article class="k glas s6"><h2>Wer folgt <span class="mehr">Alter und Geschlecht</span></h2><div id="ig-wer"><p class="ig-leer">wird geladen</p></div></article>' +
        '<article class="k glas s6"><h2>Neueste Kommentare</h2><ul class="liste ig-kommentare" id="ig-kommentare"><li class="leer">wird geladen</li></ul></article>' +
      "</div>";
    ZIEL.querySelector("#ig-neu").addEventListener("click", function () { laden(true); });
    ZIEL.querySelector(".ig-sortierung").addEventListener("click", function (e) {
      var b = e.target.closest("[data-sort]"); if (!b) return;
      SORT = b.dataset.sort;
      ZIEL.querySelectorAll("[data-sort]").forEach(function (x) { x.setAttribute("aria-pressed", x === b); });
      beitraegeZeigen();
    });
  }

  /* ---------- Kacheln oben ---------- */

  function kachelnZeigen() {
    var k = DATEN.kennzahlen || {};
    var weg = k.entfolgt && k.entfolgt.jetzt;
    var reihe = [
      ["Follower", ganz(DATEN.follower), k.neue_follower && k.neue_follower.jetzt != null
        ? "+" + ganz(k.neue_follower.jetzt) + " neu" + (weg ? ", " + ganz(weg) + " entfolgt" : "") : "insgesamt"],
      ["Aufrufe", tsd(k.views && k.views.jetzt), veraenderung(k.views)],
      ["Erreichte Konten", tsd(k.reach && k.reach.jetzt), veraenderung(k.reach)],
      ["Interaktionen", ganz(k.total_interactions && k.total_interactions.jetzt), veraenderung(k.total_interactions)],
      ["Profilaufrufe", ganz(k.profile_views && k.profile_views.jetzt), veraenderung(k.profile_views)],
      ["Link-Klicks im Profil", ganz(k.profile_links_taps && k.profile_links_taps.jetzt), veraenderung(k.profile_links_taps)],
    ];
    ZIEL.querySelector("#ig-kacheln").innerHTML = reihe.map(function (r) {
      return '<article class="k glas ig-kachel"><span class="ig-name">' + r[0] + '</span><span class="ig-wert">' + r[1] + '</span><span class="ig-unter">' + r[2] + "</span></article>";
    }).join("");
  }

  /* ---------- Verlauf ---------- */

  function verlaufZeigen() {
    var box = ZIEL.querySelector("#ig-verlauf");
    var reihe = (DATEN.reichweite || []).filter(function (x) { return x.tag; });
    if (reihe.length < 2) { box.innerHTML = '<p class="ig-leer">Noch kein Verlauf verfügbar.</p>'; return; }
    var B = 600, H = 220, L = 6, R = 6, O = 14, U = 26;
    var max = Math.max.apply(null, reihe.map(function (x) { return x.wert; }).concat([1]));
    var oben = Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max)));
    function x(i) { return L + i * (B - L - R) / (reihe.length - 1); }
    function y(w) { return O + (1 - w / oben) * (H - O - U); }
    var pfad = reihe.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.wert).toFixed(1); }).join(" ");
    var flaeche = pfad + " L" + x(reihe.length - 1).toFixed(1) + " " + (H - U) + " L" + x(0).toFixed(1) + " " + (H - U) + " Z";
    var striche = [0, .5, 1].map(function (f) {
      var yy = y(oben * f).toFixed(1);
      return '<line x1="0" x2="' + B + '" y1="' + yy + '" y2="' + yy + '" class="ig-gitter"/>';
    }).join("");
    var beschriftung = [0, Math.floor((reihe.length - 1) / 2), reihe.length - 1].map(function (i, n) {
      return '<span style="left:' + (x(i) / B * 100).toFixed(2) + '%" class="' + ["a", "m", "e"][n] + '">' + tagText(reihe[i].tag + "T12:00:00") + "</span>";
    }).join("");
    var summe = reihe.reduce(function (s, p) { return s + p.wert; }, 0);
    box.innerHTML =
      '<div class="ig-achse-y"><span style="top:' + (y(oben) / H * 100) + '%">' + kurz(oben) + '</span><span style="top:' + (y(oben / 2) / H * 100) + '%">' + kurz(oben / 2) + "</span></div>" +
      '<svg viewBox="0 0 ' + B + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Erreichte Konten je Tag, letzte 30 Tage, Durchschnitt ' + ganz(Math.round(summe / reihe.length)) + ' pro Tag">' +
        '<defs><linearGradient id="ig-fl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7DB2FF" stop-opacity=".28"/><stop offset="1" stop-color="#7DB2FF" stop-opacity="0"/></linearGradient></defs>' +
        striche + '<path d="' + flaeche + '" fill="url(#ig-fl)"/>' +
        '<path d="' + pfad + '" class="ig-strich"/>' +
        '<line class="ig-faden" id="ig-faden" y1="' + O + '" y2="' + (H - U) + '" x1="-10" x2="-10"/>' +
      "</svg>" +
      '<span class="ig-punkt" id="ig-punkt" hidden></span>' +
      '<div class="ig-tipp glas" id="ig-tipp" hidden></div>' +
      '<div class="ig-achse-x">' + beschriftung + "</div>";

    var svg = box.querySelector("svg"), faden = box.querySelector("#ig-faden"), tipp = box.querySelector("#ig-tipp"), punkt = box.querySelector("#ig-punkt");
    function zeigen(e) {
      var r = svg.getBoundingClientRect();
      var px = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * B;
      var i = Math.max(0, Math.min(reihe.length - 1, Math.round((px - L) / ((B - L - R) / (reihe.length - 1)))));
      faden.setAttribute("x1", x(i)); faden.setAttribute("x2", x(i));
      var links = x(i) / B * r.width, hoehe = y(reihe[i].wert) / H * r.height;
      punkt.hidden = false; punkt.style.left = links + "px"; punkt.style.top = hoehe + "px";
      tipp.hidden = false;
      tipp.innerHTML = "<small>" + wochentag(reihe[i].tag) + "</small><b>" + ganz(reihe[i].wert) + "</b> erreichte Konten";
      var tb = tipp.offsetWidth;
      tipp.style.left = Math.max(0, Math.min(r.width - tb, links - tb / 2)) + "px";
      tipp.style.top = Math.max(0, hoehe - tipp.offsetHeight - 14) + "px";
    }
    function weg() { tipp.hidden = true; punkt.hidden = true; faden.setAttribute("x1", -10); faden.setAttribute("x2", -10); }
    svg.addEventListener("pointermove", zeigen);
    svg.addEventListener("pointerdown", zeigen);
    svg.addEventListener("pointerleave", weg);
  }

  /* ---------- Balken ---------- */

  function balken(liste, wertText) {
    var max = Math.max.apply(null, liste.map(function (x) { return x.wert || 0; }).concat([1]));
    return '<ul class="ig-balken">' + liste.map(function (x) {
      return '<li><span class="ig-b-name">' + esc(x.name) + '</span><span class="ig-b-wert">' + (wertText ? wertText(x) : ganz(x.wert)) +
        '</span><span class="ig-b-spur"><i style="width:' + Math.max(1.5, (x.wert || 0) / max * 100).toFixed(1) + '%"></i></span></li>';
    }).join("") + "</ul>";
  }

  function interaktionZeigen() {
    var k = DATEN.kennzahlen || {};
    var teile = [["Likes", "likes"], ["Kommentare", "comments"], ["Geteilt", "shares"], ["Gespeichert", "saves"]]
      .map(function (t) { return { name: t[0], wert: k[t[1]] && k[t[1]].jetzt }; })
      .filter(function (t) { return t.wert != null; });
    var box = ZIEL.querySelector("#ig-interaktion");
    if (!teile.length) { box.innerHTML = '<p class="ig-leer">Noch nicht verfügbar.</p>'; return; }
    var aktiv = k.accounts_engaged && k.accounts_engaged.jetzt;
    box.innerHTML = balken(teile) + (aktiv != null ? '<p class="ig-fuss">' + ganz(aktiv) + " Konten haben etwas angeklickt, geliked oder kommentiert.</p>" : "");
  }

  function herkunftZeigen() {
    var box = ZIEL.querySelector("#ig-staedte");
    var st = DATEN.staedte || [];
    if (!st.length) { box.innerHTML = '<p class="ig-leer">Instagram zeigt die Herkunft erst ab 100 Followern oder gerade nicht.</p>'; return; }
    var gesamt = DATEN.follower || st.reduce(function (s, x) { return s + x.wert; }, 0);
    box.innerHTML = balken(st.map(function (x) { return { name: x.name.split(",")[0], wert: x.wert }; }), function (x) {
      return Math.round(x.wert / gesamt * 100) + " %";
    }) + '<p class="ig-fuss">Anteil an allen Followern, die acht häufigsten Orte.</p>';
  }

  function werZeigen() {
    var box = ZIEL.querySelector("#ig-wer");
    var alter = (DATEN.alter || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var g = DATEN.geschlecht || [];
    if (!alter.length && !g.length) { box.innerHTML = '<p class="ig-leer">Gerade nicht verfügbar.</p>'; return; }
    var summe = alter.reduce(function (s, x) { return s + x.wert; }, 0) || 1;
    var html = "";
    if (alter.length) {
      var max = Math.max.apply(null, alter.map(function (x) { return x.wert; }));
      html += '<div class="ig-alter" role="img" aria-label="Follower nach Alter: ' + alter.map(function (x) { return x.name + " Jahre " + Math.round(x.wert / summe * 100) + " %"; }).join(", ") + '">' +
        alter.map(function (x) {
          return '<div class="ig-a"><span class="ig-a-wert">' + Math.round(x.wert / summe * 100) + ' %</span><span class="ig-a-saeule"><i style="height:' + Math.max(2, x.wert / max * 100).toFixed(1) + '%"></i></span><small>' + esc(x.name) + "</small></div>";
        }).join("") + "</div>";
    }
    if (g.length) {
      var gs = g.reduce(function (s, x) { return s + x.wert; }, 0) || 1;
      var namen = { F: "Frauen", M: "Männer", U: "ohne Angabe" };
      var reihe = ["F", "M", "U"].map(function (k) { var e = g.find(function (x) { return x.name === k; }); return { k: k, p: e ? Math.round(e.wert / gs * 100) : 0 }; }).filter(function (x) { return x.p > 0; });
      html += '<div class="ig-geschlecht"><div class="ig-g-spur">' + reihe.map(function (x) { return '<i class="g-' + x.k + '" style="flex:' + x.p + '"></i>'; }).join("") + "</div>" +
        '<ul class="ig-g-legende">' + reihe.map(function (x) { return '<li><span class="g-' + x.k + '"></span>' + namen[x.k] + " <b>" + x.p + " %</b></li>"; }).join("") + "</ul></div>";
    }
    box.innerHTML = html;
  }

  /* ---------- Beiträge ---------- */

  function beitraegeZeigen() {
    var box = ZIEL.querySelector("#ig-beitraege");
    var liste = (DATEN.beitraege || []).filter(function (b) { return b.neu; });
    var hinweis = "";
    if (!liste.length) { liste = (DATEN.beitraege || []).slice(); hinweis = "In den letzten 30 Tagen nichts veröffentlicht, das sind die letzten Beiträge."; }
    if (!liste.length) { box.innerHTML = '<li class="ig-leer">Noch keine Beiträge.</li>'; return; }
    liste.sort(function (a, b) { return (b[SORT] || 0) - (a[SORT] || 0); });
    box.innerHTML = (hinweis ? '<li class="ig-leer">' + hinweis + "</li>" : "") + liste.slice(0, 8).map(function (b, i) {
      function z(feld, name) { return '<span class="' + (feld === SORT ? "an" : "") + '"><b>' + ganz(b[feld]) + "</b>" + name + "</span>"; }
      return '<li><a href="' + esc(b.link) + '" target="_blank" rel="noopener">' +
        '<span class="ig-platz">' + (i + 1) + "</span>" +
        '<span class="ig-bild">' + (b.bild ? '<img src="' + esc(b.bild) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + "</span>" +
        '<span class="ig-text"><b>' + esc(b.text || "ohne Text") + "</b><small>" + esc(b.art) + " · " + tagText(b.zeit) + "</small></span>" +
        '<span class="ig-zahlen">' + z("aufrufe", "Aufrufe") + z("likes", "Likes") + z("geteilt", "Geteilt") + z("gespeichert", "Gespeichert") + "</span>" +
        "</a></li>";
    }).join("");
  }

  async function kommentareLaden() {
    var box = ZIEL.querySelector("#ig-kommentare");
    var d = await ABRUF({ aktion: "kommentare" });
    if (d.fehler || !d.kommentare) { box.innerHTML = '<li class="leer">' + esc(d.fehler || "nicht erreichbar") + "</li>"; return; }
    var liste = d.kommentare.slice(0, 6);
    if (!liste.length) { box.innerHTML = '<li class="leer">Noch keine Kommentare unter den letzten Beiträgen.</li>'; return; }
    box.innerHTML = liste.map(function (k) {
      return '<li><a href="' + esc(k.link) + '" target="_blank" rel="noopener"><span class="t"><b>' + esc(k.name) + "</b><small>" + esc(k.text) + '</small></span><span class="r">' + tagText(k.zeit) + "</span></a></li>";
    }).join("");
  }

  /* ---------- Laden ---------- */

  async function laden(neu) {
    if (LAEUFT) return; LAEUFT = true;
    var knopf = ZIEL.querySelector("#ig-neu");
    knopf.disabled = true; knopf.textContent = "wird geladen …";
    var d = await ABRUF({ aktion: "instagram-mehr", neu: !!neu });
    LAEUFT = false; knopf.disabled = false; knopf.textContent = "Neu laden";
    if (d.fehler || d.fehlt) {
      ZIEL.querySelector("#ig-stand").textContent = d.fehlt ? "Instagram ist noch nicht verbunden." : "Instagram: " + String(d.fehler).replace(/^Instagram: /, "");
      return;
    }
    DATEN = d;
    var st = new Date(d.stand);
    ZIEL.querySelector("#ig-stand").innerHTML = "@" + esc(d.name) + " · letzte 30 Tage · Stand " +
      String(st.getHours()).padStart(2, "0") + ":" + String(st.getMinutes()).padStart(2, "0") + " Uhr";
    kachelnZeigen(); verlaufZeigen(); interaktionZeigen(); beitraegeZeigen(); herkunftZeigen(); werZeigen();
  }

  window.AM_IG = {
    start: function (abruf, ziel) {
      if (ZIEL) return;
      ABRUF = abruf; ZIEL = ziel;
      geruest(); laden(false); kommentareLaden();
    },
    neu: function () { if (ZIEL && !document.hidden) { laden(false); kommentareLaden(); } },
  };
})();
