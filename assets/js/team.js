/* Team-Dashboard (team.html) für Mitarbeiter von Bad Salzuflen News.
   Zeigt nur: Instagram, Aufrufe der Webseite, Mails an die eigene Adresse
   (mit Antworten), den Kalender „Bad Salzuflen News“, eigene Erinnerungen und
   Schlagzeilen von Bad Salzuflen News und Tagesschau. Was jemand sehen darf,
   entscheidet der Abruf „dashboard-konten“ auf dem Server, nicht diese Datei. */
(function () {
  var C = window.AM_CONFIG || {};
  var sb = (C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase)
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY) : null;

  var BSN = { url: "https://idvnjawudxgearwihfxn.supabase.co/rest/v1",
              key: "sb_publishable_gcDJrh1nciwG0gxYlg3CMw_dxvZiPNp",
              seite: "https://badsalzuflennews.de/" };
  var CHEFS = ["schleef.lennart@gmail.com", "l.schleef@badsalzuflennews.de"];

  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function zwei(n) { return n < 10 ? "0" + n : "" + n; }
  function isoTag(d) { return d.getFullYear() + "-" + zwei(d.getMonth() + 1) + "-" + zwei(d.getDate()); }
  function uhrzeit(iso) { var d = new Date(iso); return zwei(d.getHours()) + ":" + zwei(d.getMinutes()); }
  function vorWann(wert) {
    var d = new Date(wert), min = Math.round((Date.now() - d) / 60000);
    if (min < 1) return "gerade eben";
    if (min < 60) return "vor " + min + " Min.";
    if (min < 24 * 60) return "vor " + Math.round(min / 60) + " Std.";
    if (min < 48 * 60) return "gestern";
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  function leer(id, text) { if ($(id)) $(id).innerHTML = '<li class="leer">' + esc(text) + "</li>"; }
  function setzen(id, wert, unter) { if (!$(id)) return; $(id).textContent = wert; if (unter != null && $(id + "-u")) $(id + "-u").innerHTML = unter; }
  function linie(id, werte) {
    var max = Math.max.apply(null, werte.concat([1])), min = Math.min.apply(null, werte.concat([0]));
    var schritt = 88 / (werte.length - 1);
    $(id).setAttribute("d", werte.map(function (w, i) {
      return (i ? "L" : "M") + (2 + i * schritt).toFixed(1) + " " + (30 - (w - min) / (max - min || 1) * 26).toFixed(1);
    }).join(" "));
  }
  function tsd(n) {
    if (n == null) return "–";
    return n >= 1000 ? Math.floor(n / 1000).toLocaleString("de-DE") + " Tsd.+" : n.toLocaleString("de-DE");
  }
  async function abruf(body) {
    var r;
    try { r = await sb.functions.invoke("dashboard-konten", { body: body }); }
    catch (f) { r = { error: f }; }
    if (r.error) {
      var grund = "nicht erreichbar";
      try { var x = await r.error.context.json(); if (x && x.fehler) grund = x.fehler; } catch (_) { /* kein Text */ }
      return { fehler: grund };
    }
    return r.data || { fehler: "keine Antwort" };
  }
  var hinweisUhr = null;
  function hinweis(text) {
    var h = $("hinweis"); h.textContent = text; h.classList.add("an");
    clearTimeout(hinweisUhr); hinweisUhr = setTimeout(function () { h.classList.remove("an"); }, 6000);
  }

  /* ---------------- Reiter ---------------- */

  function wechseln(ziel) {
    document.querySelectorAll(".ansicht").forEach(function (a) { a.hidden = a.dataset.ansicht !== ziel; });
    document.querySelectorAll(".reiter button").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.ziel === ziel); });
    document.querySelectorAll(".leiste button[data-ziel]").forEach(function (b) { b.setAttribute("aria-current", b.dataset.ziel === ziel); });
    if (ziel === "mail" && !MAIL.geladen) ordnerLaden(true);
    window.scrollTo(0, 0);
  }
  var ich = $("ich"), menue = $("ich-menue");
  function menueZu() { menue.hidden = true; ich.setAttribute("aria-expanded", "false"); }
  ich.addEventListener("click", function (e) { e.stopPropagation(); var auf = menue.hidden; menue.hidden = !auf; ich.setAttribute("aria-expanded", String(auf)); });
  $("ich-raus").addEventListener("click", function () { menueZu(); $("abmelden").click(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") menueZu(); });
  document.addEventListener("click", function (e) {
    if (!menue.hidden && !e.target.closest("#ich-menue")) menueZu();
    if (e.target.closest("#ich-menue [data-ziel]")) menueZu();
    var z = e.target.closest("[data-ziel]");
    if (z) { e.preventDefault(); wechseln(z.dataset.ziel); }
  });
  var std = new Date().getHours();
  $("gruss").textContent = std < 11 ? "Guten Morgen" : std < 18 ? "Guten Tag" : "Guten Abend";
  $("datum").textContent = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  /* ---------------- Analysen ---------------- */

  async function aufrufeLaden() {
    var jetzt = new Date(), grenzen = [];
    for (var i = 13; i >= 0; i--) grenzen.push(new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() - i).toISOString());
    grenzen.push(jetzt.toISOString());
    var gestern0 = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() - 1);
    var d = await abruf({ aktion: "aufrufe", grenzen: grenzen, vergleich: [gestern0.toISOString(), new Date(jetzt - 864e5).toISOString()] });
    if (d.fehler) { setzen("z-aufrufe", "–", "nicht erreichbar"); return; }
    if (d.fehlt) { setzen("z-aufrufe", "–", "noch nicht verbunden"); return; }
    var z = d.zahlen || [], heute = z[z.length - 1] || 0, gestern = d.gestern;
    var t = function (n) { return n.toLocaleString("de-DE"); };
    setzen("z-aufrufe", t(heute), gestern > 0
      ? '<span class="' + (heute >= gestern ? "plus" : "minus") + '">' + (heute >= gestern ? "+" : "") + Math.round((heute - gestern) / gestern * 100) + " %</span> zu gestern um diese Zeit"
      : "gestern um diese Zeit: " + t(gestern || 0));
    if (z.length > 1) linie("l-aufrufe", z);
    $("l-aufrufe").closest("svg").setAttribute("aria-label", "Aufrufe der letzten 14 Tage: " + z.map(t).join(", "));
  }

  async function instagramLaden() {
    var d = await abruf({ aktion: "instagram" });
    if (d.fehler) { setzen("z-ig", "–", "nicht erreichbar"); setzen("z-igv", "–", "nicht erreichbar"); return; }
    if (d.fehlt) { setzen("z-ig", "–", "noch nicht verbunden"); setzen("z-igv", "–", "noch nicht verbunden"); return; }
    if (d.name) $("ig-name").textContent = "@" + d.name;
    setzen("z-ig", d.follower != null ? d.follower.toLocaleString("de-DE") : "–", "Follower");
    setzen("z-igv", tsd(d.aufrufe), d.aufrufe != null ? "Aufrufe aller Beiträge und Reels" : "noch nicht verfügbar");
    if (d.verlauf && d.verlauf.length > 1) {
      linie("l-ig", d.verlauf);
      $("l-ig").closest("svg").setAttribute("aria-label", "Reichweite je Tag, letzte 30 Tage");
    }
  }

  /* ---------------- Mails ---------------- */

  var PERSON = null;
  function sigHinweis() { return PERSON ? "Deine Signatur (" + PERSON.name + ", " + PERSON.rolle + ") wird automatisch angehängt." : ""; }
  var MAIL = { art: "inbox", liste: [], aktiv: null, mehr: false, aelteste: null, laeuft: 0, geladen: false, postfach: "" };
  function mailZeit(iso) {
    if (!iso) return "";
    return isoTag(new Date(iso)) === isoTag(new Date()) ? uhrzeit(iso) : new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  function mailZeile(m, i, quelle) {
    var wer = m.art === "sent" ? "An: " + (m.an || "") : m.von;
    return '<li data-' + quelle + '="' + i + '" class="' + (m.neu ? "neu" : "") + '"><span class="quelle">' + esc((m.von || "?").charAt(0).toUpperCase()) +
      '</span><span class="t"><b>' + esc(wer) + (m.beantwortet ? '<span class="beantwortet">beantwortet</span>' : "") + "</b><small>" + esc(m.betreff) +
      '</small></span><span class="r">' + mailZeit(m.datum) + "</span></li>";
  }
  var KURZ = [];
  function kurzZeigen(mails, fehler) {
    KURZ = mails || [];
    var neu = KURZ.filter(function (m) { return m.neu; }).length;
    $("mail-zahl").textContent = neu ? neu + " ungelesen" : "Alle ansehen";
    if (KURZ.length) $("mails-kurz").innerHTML = KURZ.slice(0, 5).map(function (m, i) { return mailZeile(m, i, "kurz"); }).join("");
    else leer("mails-kurz", fehler || "Noch keine Mails an deine Adresse.");
  }
  function mailListe() {
    $("mails-lang").innerHTML = MAIL.liste.length
      ? MAIL.liste.map(function (m, i) { return mailZeile(m, i, "mail"); }).join("")
      : '<li class="leer">' + (MAIL.art === "sent" ? "Noch nichts gesendet." : MAIL.art === "inbox" ? "Keine Mails an deine Adresse." : "Dieser Ordner ist leer.") + "</li>";
    if (MAIL.aktiv !== null) {
      var li = $("mails-lang").querySelector('[data-mail="' + MAIL.aktiv + '"]'); if (li) li.setAttribute("aria-current", "true");
    }
    $("aeltere").hidden = !MAIL.mehr;
  }
  async function ordnerLaden(neu) {
    var nr = ++MAIL.laeuft;
    if (neu) { MAIL.liste = []; MAIL.aktiv = null; MAIL.mehr = false; MAIL.aelteste = null; $("mails-lang").innerHTML = '<li class="leer">wird geladen</li>'; $("aeltere").hidden = true; }
    else { $("aeltere").disabled = true; $("aeltere").textContent = "wird geladen …"; }
    var d = await abruf({ aktion: "team-ordner", art: MAIL.art, vor: neu ? null : MAIL.aelteste });
    if (nr !== MAIL.laeuft) return;
    $("aeltere").disabled = false; $("aeltere").textContent = "Ältere Mails laden";
    if (d.fehler) { $("mails-lang").innerHTML = '<li class="leer">' + esc(d.fehler) + "</li>"; return; }
    MAIL.geladen = true;
    MAIL.liste = MAIL.liste.concat(d.mails || []);
    MAIL.mehr = !!d.mehr; MAIL.aelteste = d.aelteste;
    mailListe();
    if (neu && MAIL.aktiv === null && !$("lesen").querySelector("[data-neu]")) $("lesen").innerHTML = '<p class="platz">Links eine Mail auswählen.</p>';
  }

  function mailGestaltet(ziel, html) {
    var f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.title = "Inhalt der E-Mail";
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\' https:; font-src https: data:">' +
      '<base target="_blank"><style>html,body{margin:0;background:#fff}body{padding:18px;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>' +
      html + "</body></html>";
    ziel.appendChild(f);
    function hoehe() { try { var doc = f.contentDocument; if (doc && doc.documentElement) f.style.height = Math.max(200, doc.documentElement.scrollHeight) + "px"; } catch (e) { /* egal */ } }
    f.addEventListener("load", function () {
      hoehe();
      try { [].forEach.call(f.contentDocument.images, function (b) { b.addEventListener("load", hoehe); }); } catch (e) { /* egal */ }
      setTimeout(hoehe, 600); setTimeout(hoehe, 2000);
    });
  }

  /* Aufräumen wie im Dashboard von Lennart: nur Standard-Ordner, nichts wird endgültig gelöscht */
  var SYM = { archive: "i-archiv", inbox: "i-mail", junk: "i-spam", trash: "i-papierkorb", ungelesen: "i-punkt" };
  var ORDNERNAME = { inbox: "Posteingang", sent: "Gesendet", archive: "Archiv", junk: "Spam", trash: "Papierkorb" };
  var EIGENE = [];
  function ordnerName(art) { return art.indexOf("eigen:") === 0 ? art.slice(6) : ORDNERNAME[art] || art; }
  function eigeneZeigen(liste) {
    if (!liste || !liste.length || EIGENE.length) return;
    EIGENE = liste;
    $("ordner-wahl").insertAdjacentHTML("beforeend", '<optgroup label="Eigene Ordner">' +
      liste.map(function (n) { return '<option value="eigen:' + esc(n) + '">' + esc(n) + "</option>"; }).join("") + "</optgroup>");
  }
  function werkzeugHtml(m) {
    var art = m.art || "inbox", k = [];
    if (art !== "archive" && art !== "trash") k.push(["verschieben", "archive", "Archivieren"]);
    if (art === "junk") k.push(["verschieben", "inbox", "Kein Spam"]);
    else if (art !== "inbox" && art !== "sent") k.push(["verschieben", "inbox", "In Posteingang"]);
    if (art !== "junk" && art !== "trash" && art !== "sent") k.push(["verschieben", "junk", "Spam"]);
    if (art !== "trash") k.push(["verschieben", "trash", "Papierkorb"]);
    if (art !== "sent") k.push(["ungelesen", "", "Als ungelesen"]);
    var ziele = ["inbox", "archive", "junk", "trash"].filter(function (z) { return z !== art; });
    var eigene = EIGENE.map(function (n) { return "eigen:" + n; }).filter(function (z) { return z !== art; });
    var auswahl = '<select data-verschieben aria-label="Verschieben nach"><option value="">Verschieben nach …</option>' +
      ziele.map(function (z) { return '<option value="' + z + '">' + ORDNERNAME[z] + "</option>"; }).join("") +
      (eigene.length ? '<optgroup label="Eigene Ordner">' + eigene.map(function (z) { return '<option value="' + esc(z) + '">' + esc(ordnerName(z)) + "</option>"; }).join("") + "</optgroup>" : "") +
      "</select>";
    return '<div class="werkzeuge" role="toolbar" aria-label="Mail bearbeiten">' + k.map(function (b) {
      return '<button type="button" data-was="' + b[0] + '" data-nach="' + b[1] + '"><svg class="i" aria-hidden="true"><use href="#' + SYM[b[1] || "ungelesen"] + '"/></svg>' + b[2] + "</button>";
    }).join("") + auswahl + '<span class="werkzeug-meldung" aria-live="polite"></span></div>';
  }
  async function mailAendern(was, nach) {
    var i = MAIL.aktiv, m = MAIL.liste[i]; if (!m) return;
    var leiste = $("lesen").querySelector(".werkzeuge"), meldung = leiste && leiste.querySelector(".werkzeug-meldung");
    if (leiste) [].forEach.call(leiste.querySelectorAll("button,select"), function (x) { x.disabled = true; });
    if (meldung) meldung.textContent = "…";
    var d = await abruf({ aktion: "team-aufraeumen", art: m.art, uid: m.uid, was: was, ziel: nach });
    if (leiste) [].forEach.call(leiste.querySelectorAll("button,select"), function (x) { x.disabled = false; });
    if (d.fehler || !d.ok) { if (meldung) meldung.textContent = d.fehler || "Das hat nicht geklappt."; return; }
    if (was === "ungelesen") {
      m.neu = true;
      KURZ.forEach(function (k) { if (k.uid === m.uid && m.art === "inbox") k.neu = true; });
      mailListe(); kurzZeigen(KURZ);
      if (meldung) meldung.textContent = "Als ungelesen markiert";
      return;
    }
    // Verschoben: aus der Liste nehmen und die nächste Mail öffnen
    if (m.art === "inbox") { KURZ = KURZ.filter(function (k) { return k.uid !== m.uid; }); kurzZeigen(KURZ); }
    MAIL.liste.splice(i, 1);
    MAIL.aktiv = null;
    mailListe();
    hinweis("Verschoben nach „" + ordnerName(nach) + "“");
    if (MAIL.liste[i]) mailOeffnen(i); else if (MAIL.liste[i - 1]) mailOeffnen(i - 1);
    else { $("mail-bereich").classList.remove("offen"); $("lesen").innerHTML = '<p class="platz">Keine Mails mehr in diesem Ordner.</p>'; }
  }
  $("lesen").addEventListener("click", function (e) {
    var b = e.target.closest("[data-was]"); if (b) mailAendern(b.dataset.was, b.dataset.nach);
  });
  $("lesen").addEventListener("change", function (e) {
    var s = e.target.closest("[data-verschieben]"); if (s && s.value) mailAendern("verschieben", s.value);
  });

  async function mailOeffnen(i) {
    var m = MAIL.liste[i]; if (!m) return;
    MAIL.aktiv = i;
    [].forEach.call($("mails-lang").children, function (li) { li.setAttribute("aria-current", li.dataset.mail == i); });
    $("mail-bereich").classList.add("offen");
    var kopf = werkzeugHtml(m) + '<button type="button" class="zurueck-mail" data-zurueck><svg class="i" aria-hidden="true"><use href="#i-zurueck"/></svg>Zurück zur Liste</button>' +
      '<div class="kopfzeile"><span class="person">' + esc((m.von || "?").charAt(0).toUpperCase()) + "</span><div><b>" + esc(m.art === "sent" ? "An: " + m.an : m.von) +
      '</b><div style="color:var(--schrift-3);font-size:13px">' + esc(m.art === "sent" ? "" : m.vonAdresse) + (m.datum ? " · " + new Date(m.datum).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "") +
      "</div></div></div><h3>" + esc(m.betreff) + "</h3>";
    $("lesen").innerHTML = kopf + '<p class="text wenig">Wird geladen …</p>';
    var d = await abruf({ aktion: "team-mail", art: m.art, uid: m.uid });
    if (MAIL.aktiv !== i) return;
    if (d.fehler) { $("lesen").innerHTML = kopf + '<p class="text">' + esc(d.fehler) + "</p>"; return; }
    if (m.neu) {
      m.neu = false;
      KURZ.forEach(function (k) { if (k.uid === m.uid) k.neu = false; });
      mailListe(); kurzZeigen(KURZ);
    }
    var bilder = (d.bilder || []).map(function (b) {
      return '<figure class="anh-bild"><img src="' + esc(b.src) + '" alt="' + esc(b.name) + '" loading="lazy"><figcaption><span>' + esc(b.name) + '</span><a href="' + esc(b.src) + '" download="' + esc(b.name) + '">Speichern</a></figcaption></figure>';
    }).join("");
    var gezeigt = (d.bilder || []).map(function (b) { return b.name; });
    var rest = (d.anhaenge || []).filter(function (n) { var k = gezeigt.indexOf(n); if (k < 0) return true; gezeigt.splice(k, 1); return false; });
    var antwort = m.art === "sent" ? "" :
      '<form class="antwort-feld" data-antwort novalidate><label for="antwort-text">Antwort an ' + esc(d.antwortAn || m.vonAdresse) + '</label>' +
      '<textarea id="antwort-text" name="text" placeholder="Guten Tag …" required></textarea>' + anhangBlock() +
      '<div class="antwort-fuss"><button class="knopf" type="submit">Antwort senden</button><small>Geht von ' + esc(MAIL.postfach) + ' raus, mit deiner Signatur, die ursprüngliche Mail wird angehängt.</small>' +
      '<span class="antwort-meldung" aria-live="polite"></span></div></form>';
    var fuss = (bilder ? '<div class="anh-bilder">' + bilder + "</div>" : "") + (rest.length ? '<p class="anh">Anhänge: ' + esc(rest.join(", ")) + "</p>" : "") + antwort;
    if (!d.html) { $("lesen").innerHTML = kopf + '<div class="text">' + esc(d.text || "(kein Text)") + "</div>" + fuss; return; }
    $("lesen").innerHTML = kopf + '<div class="mailrahmen"></div>' + fuss;
    mailGestaltet($("lesen").querySelector(".mailrahmen"), d.html);
  }

  /* Anhänge: Dateien im Browser lesen und als Text (base64) mitschicken, zusammen höchstens 15 MB */
  var ANH_MAX = 15 * 1024 * 1024;
  function anhangBlock() {
    return '<div class="anh-zeile"><button type="button" class="knopf leise" data-anhang-wahl><svg class="i" aria-hidden="true"><use href="#i-klammer"/></svg>Datei anhängen</button>' +
      '<input type="file" multiple hidden data-anhang-datei><span class="anh-liste"></span></div>';
  }
  function groesse(n) { return n >= 1048576 ? (n / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function anhListe(f) {
    f.querySelector(".anh-liste").innerHTML = (f._anh || []).map(function (a, i) {
      return '<span class="anh-chip"><span title="' + esc(a.name) + '">' + esc(a.name) + " · " + groesse(a.groesse) + '</span><button type="button" data-anhang-weg="' + i + '" aria-label="' + esc(a.name) + ' entfernen">×</button></span>';
    }).join("");
  }
  function dateiLesen(datei) {
    return new Promise(function (ok, fehl) {
      var r = new FileReader();
      r.onload = function () { var t = String(r.result); ok(t.slice(t.indexOf(",") + 1)); };
      r.onerror = fehl;
      r.readAsDataURL(datei);
    });
  }
  function anhangDaten(f) { return (f._anh || []).map(function (a) { return { name: a.name, typ: a.typ, inhalt: a.inhalt }; }); }
  $("lesen").addEventListener("click", function (e) {
    var w = e.target.closest("[data-anhang-wahl]");
    if (w) { w.closest("form").querySelector("[data-anhang-datei]").click(); return; }
    var x = e.target.closest("[data-anhang-weg]");
    if (x) { var f = x.closest("form"); f._anh.splice(+x.dataset.anhangWeg, 1); anhListe(f); }
  });
  $("lesen").addEventListener("change", async function (e) {
    var inp = e.target.closest("[data-anhang-datei]"); if (!inp) return;
    var f = inp.closest("form"), meldung = f.querySelector(".antwort-meldung");
    f._anh = f._anh || [];
    var summe = f._anh.reduce(function (n, a) { return n + a.groesse; }, 0), zuGross = [];
    meldung.className = "antwort-meldung"; meldung.textContent = "Dateien werden gelesen …";
    for (var i = 0; i < inp.files.length; i++) {
      var d = inp.files[i];
      if (f._anh.length >= 10 || summe + d.size > ANH_MAX) { zuGross.push(d.name); continue; }
      try { f._anh.push({ name: d.name, typ: d.type || "application/octet-stream", groesse: d.size, inhalt: await dateiLesen(d) }); summe += d.size; }
      catch (_) { zuGross.push(d.name); }
    }
    inp.value = "";
    anhListe(f);
    meldung.textContent = zuGross.length ? "Nicht angehängt (zusammen höchstens 15 MB und 10 Dateien): " + zuGross.join(", ") : "";
    if (zuGross.length) meldung.classList.add("fehler");
  });

  /* Neue Mail von seiner Adresse schreiben */
  function neueMail() {
    if (!MAIL.postfach) return;
    MAIL.aktiv = null; mailListe();
    $("mail-bereich").classList.add("offen");
    $("lesen").innerHTML = '<button type="button" class="zurueck-mail" data-zurueck><svg class="i" aria-hidden="true"><use href="#i-zurueck"/></svg>Zurück zur Liste</button>' +
      '<form class="schreiben" data-neu novalidate><h3>Neue E-Mail</h3>' +
      '<p class="hilfe">Von ' + esc(MAIL.postfach) + '</p>' +
      '<label class="feld"><span>An</span><input name="an" type="text" inputmode="email" autocomplete="off" placeholder="name@beispiel.de"></label>' +
      '<p class="hilfe" style="margin-top:-8px">Mehrere Empfänger mit Komma trennen.</p>' +
      '<label class="feld"><span>Betreff</span><input name="betreff" type="text" maxlength="300" autocomplete="off"></label>' +
      '<div class="antwort-feld"><label for="neu-text">Text</label><textarea id="neu-text" name="text" placeholder="Guten Tag …"></textarea></div>' +
      (PERSON ? '<p class="hilfe" style="margin-top:-6px">' + esc(sigHinweis()) + "</p>" : "") + anhangBlock() +
      '<div class="antwort-fuss"><button class="knopf" type="submit">Senden</button><button class="knopf leise" type="button" data-verwerfen>Verwerfen</button>' +
      '<span class="antwort-meldung" aria-live="polite"></span></div></form>';
    $("lesen").querySelector('[name="an"]').focus();
  }
  function neuOeffnen(e) {
    e.preventDefault();
    if (MAIL.art !== "inbox") { MAIL.art = "inbox"; $("ordner-wahl").value = "inbox"; MAIL.geladen = false; }
    wechseln("mail");
    neueMail();
  }
  $("neu-mail").addEventListener("click", neuOeffnen);
  $("neu-mail-kurz").addEventListener("click", neuOeffnen);
  $("lesen").addEventListener("submit", async function (e) {
    var f = e.target.closest("[data-neu]"); if (!f) return;
    e.preventDefault();
    var meldung = f.querySelector(".antwort-meldung"), knopf = f.querySelector('[type="submit"]');
    meldung.className = "antwort-meldung";
    var fehlt = !f.an.value.trim() ? [f.an, "Bitte einen Empfänger eintragen."] : !f.betreff.value.trim() ? [f.betreff, "Bitte einen Betreff eintragen."]
      : !f.text.value.trim() ? [f.text, "Bitte zuerst einen Text schreiben."] : null;
    if (fehlt) { meldung.textContent = fehlt[1]; meldung.classList.add("fehler"); fehlt[0].focus(); return; }
    knopf.disabled = true; knopf.textContent = "Wird gesendet …"; meldung.textContent = "";
    var d = await abruf({ aktion: "team-neu", an: f.an.value, betreff: f.betreff.value, text: f.text.value, anhaenge: anhangDaten(f) });
    knopf.disabled = false; knopf.textContent = "Senden";
    if (d.fehler || !d.ok) { meldung.textContent = d.fehler || "Das hat nicht geklappt."; meldung.classList.add("fehler"); return; }
    hinweis("Gesendet an " + f.an.value.trim());
    $("mail-bereich").classList.remove("offen");
    $("lesen").innerHTML = '<p class="platz">Gesendet. Eine Kopie liegt unter „Gesendet“.</p>';
    if (MAIL.art === "sent") ordnerLaden(true);
  });

  $("lesen").addEventListener("click", function (e) {
    if (e.target.closest("[data-verwerfen]")) {
      var f = e.target.closest("[data-neu]");
      if (f && (f.text.value.trim() || f.betreff.value.trim()) && !confirm("Diese Mail verwerfen?")) return;
      $("mail-bereich").classList.remove("offen");
      $("lesen").innerHTML = '<p class="platz">Links eine Mail auswählen.</p>';
      return;
    }
    if (e.target.closest("[data-zurueck]")) { $("mail-bereich").classList.remove("offen"); MAIL.aktiv = null; mailListe(); }
  });
  $("lesen").addEventListener("submit", async function (e) {
    var f = e.target.closest("[data-antwort]"); if (!f) return;
    e.preventDefault();
    var m = MAIL.liste[MAIL.aktiv], meldung = f.querySelector(".antwort-meldung"), knopf = f.querySelector("button");
    var text = f.text.value.trim();
    meldung.className = "antwort-meldung";
    if (!text) { meldung.textContent = "Bitte zuerst einen Text schreiben."; meldung.classList.add("fehler"); f.text.focus(); return; }
    knopf.disabled = true; knopf.textContent = "Wird gesendet …"; meldung.textContent = "";
    var d = await abruf({ aktion: "team-antworten", art: m.art, uid: m.uid, text: text, anhaenge: anhangDaten(f) });
    knopf.disabled = false; knopf.textContent = "Antwort senden";
    if (d.fehler || !d.ok) { meldung.textContent = d.fehler || "Das hat nicht geklappt."; meldung.classList.add("fehler"); return; }
    f.text.value = ""; f._anh = []; anhListe(f); meldung.textContent = "Gesendet."; meldung.classList.add("ok");
    m.beantwortet = true; mailListe();
  });
  $("mails-lang").addEventListener("click", function (e) { var li = e.target.closest("[data-mail]"); if (li) mailOeffnen(+li.dataset.mail); });
  $("mails-kurz").addEventListener("click", function (e) {
    var li = e.target.closest("[data-kurz]"); if (!li) return;
    var m = KURZ[+li.dataset.kurz];
    if (MAIL.art !== "inbox") { MAIL.art = "inbox"; $("ordner-wahl").value = "inbox"; MAIL.geladen = false; }
    wechseln("mail");
    // Liste der Mail-Ansicht übernimmt die Übersicht, damit die Mail sofort aufgeht
    if (!MAIL.geladen) { MAIL.liste = KURZ.slice(); MAIL.geladen = true; MAIL.mehr = UEBER.mehr; MAIL.aelteste = UEBER.aelteste; MAIL.laeuft++; mailListe(); }
    var i = MAIL.liste.findIndex(function (x) { return x.uid === m.uid; });
    if (i >= 0) mailOeffnen(i);
  });
  $("ordner-wahl").addEventListener("change", function () {
    MAIL.art = this.value;
    $("mail-bereich").classList.remove("offen");
    ordnerLaden(true);
  });
  $("aeltere").addEventListener("click", function () { ordnerLaden(false); });

  /* ---------------- Kalender Bad Salzuflen News ---------------- */

  var WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  function tagVon(t) { return t.ganztags ? t.start : isoTag(new Date(t.start)); }
  function laeuftAn(t, tag) {
    if (!t.ganztags) return tagVon(t) === tag;
    return t.start <= tag && (t.ende && t.ende !== t.start ? t.ende > tag : t.start === tag);
  }
  function kalenderZeigen(d) {
    var termine = d.termine || [];
    var hinweisText = !d.kalenderGefunden ? "Der Kalender „Bad Salzuflen News“ wurde nicht gefunden." : "";
    if (d.fehler && d.fehler.some(function (f) { return /^Kalender/.test(f); })) hinweisText = "Der Kalender ist gerade nicht erreichbar.";
    // Woche auf der Übersicht
    var html = "";
    for (var i = 0; i < 7; i++) {
      var t = new Date(); t.setDate(t.getDate() + i);
      var tag = isoTag(t);
      var liste = termine.filter(function (x) { return laeuftAn(x, tag); });
      var zeilen = liste.slice(0, 5).map(function (x) {
        return '<div class="termin"' + (x.farbe ? ' style="--f:' + esc(x.farbe) + '"' : "") + "><small>" + (x.ganztags ? "ganztägig" : uhrzeit(x.start)) + "</small><span>" + esc(x.titel) + "</span></div>";
      }).join("");
      if (liste.length > 5) zeilen += '<span class="weitere">+' + (liste.length - 5) + " weitere</span>";
      if (!liste.length) zeilen = '<span class="frei">frei</span>';
      html += '<div class="tag' + (i === 0 ? " heute" : "") + (t.getDay() === 0 || t.getDay() === 6 ? " wochenende" : "") + '"><span class="tk">' + (i === 0 ? "Heute" : WOCHENTAG[t.getDay()]) + "<b>" + t.getDate() + ".</b></span>" + zeilen + "</div>";
    }
    $("woche").innerHTML = hinweisText ? '<p class="leer-text">' + esc(hinweisText) + "</p>" : html;
    // Reiter Kalender: zwei Wochen als Liste
    var lang = "";
    for (var n = 0; n < 14; n++) {
      var tg = new Date(); tg.setDate(tg.getDate() + n);
      var tagIso = isoTag(tg);
      var l = termine.filter(function (x) { return laeuftAn(x, tagIso); });
      var name = n === 0 ? "Heute" : n === 1 ? "Morgen" : tg.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
      lang += "<h3>" + name + '</h3><ul class="liste">' + (l.length ? l.map(function (x) {
        return '<li><span class="zeit">' + (x.ganztags ? "ganzt." : uhrzeit(x.start)) + '</span><span class="strich" style="background:' + esc(x.farbe || "var(--blau-hell)") + '"></span><span class="t"><b>' + esc(x.titel) + "</b><small>" +
          esc([x.ort ? x.ort.split("\n")[0] : "", !x.ganztags && x.ende ? "bis " + uhrzeit(x.ende) : ""].filter(Boolean).join(" · ") || "Bad Salzuflen News") + "</small></span></li>";
      }).join("") : '<li class="leer">Keine Termine</li>') + "</ul>";
    }
    $("kal-liste").innerHTML = hinweisText ? '<p class="platz">' + esc(hinweisText) + "</p>" : lang;
  }

  /* ---------------- Erinnerungen ---------------- */

  var ERIN = { liste: null, gemeldet: {} };
  function erinFaellig(e) { return e.datum ? new Date(e.datum + "T" + (e.uhrzeit || "00:00")) : null; }
  function erinSortiert() {
    return ERIN.liste.slice().sort(function (a, b) {
      if (a.erledigt !== b.erledigt) return a.erledigt ? 1 : -1;
      var x = a.datum ? a.datum + (a.uhrzeit || "00:00") : "9999", y = b.datum ? b.datum + (b.uhrzeit || "00:00") : "9999";
      return x === y ? String(a.erstellt).localeCompare(String(b.erstellt)) : x.localeCompare(y);
    });
  }
  function erinZeile(e) {
    var heute = isoTag(new Date()), f = erinFaellig(e), klasse = e.erledigt ? "erledigt" : "";
    var wann = "ohne Datum";
    if (e.datum) {
      wann = e.datum === heute ? "heute" : e.datum === isoTag(new Date(Date.now() + 864e5)) ? "morgen"
        : new Date(e.datum + "T12:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
      if (e.uhrzeit) wann += ", " + e.uhrzeit + " Uhr";
      if (!e.erledigt) {
        if (f < new Date() && (e.uhrzeit || e.datum < heute)) { klasse = "spaet"; wann = "überfällig · " + wann; }
        else if (e.datum === heute) klasse = "faellig";
      }
    }
    return '<li class="' + klasse + '" data-erin="' + esc(e.id) + '"><button type="button" class="haken" data-haken aria-pressed="' + e.erledigt + '" aria-label="' + esc(e.titel) + (e.erledigt ? " wieder öffnen" : " erledigt") + '"><i></i></button>' +
      '<span class="t"><b>' + esc(e.titel) + "</b><small>" + esc(wann) + '</small></span><button type="button" class="weg" data-weg aria-label="' + esc(e.titel) + ' löschen" title="Löschen"><svg class="i" aria-hidden="true"><use href="#i-papierkorb"/></svg></button></li>';
  }
  function erinZeigen() {
    if (!ERIN.liste) return;
    var s = erinSortiert(), offen = s.filter(function (e) { return !e.erledigt; }), erledigt = s.filter(function (e) { return e.erledigt; });
    $("erin-zahl").textContent = offen.length ? offen.length + " offen" : "Alle";
    $("erin-kurz").innerHTML = offen.length ? offen.slice(0, 5).map(erinZeile).join("") : '<li class="leer">Nichts offen. Oben eine neue Erinnerung eintragen.</li>';
    $("erin-lang").innerHTML =
      '<p class="erin-gruppe">Offen</p><ul class="liste erin">' + (offen.length ? offen.map(erinZeile).join("") : '<li class="leer">Nichts offen.</li>') + "</ul>" +
      (erledigt.length ? '<p class="erin-gruppe">Erledigt</p><ul class="liste erin">' + erledigt.slice(0, 30).map(erinZeile).join("") + "</ul>" : "");
  }
  var erinSpeichernLaeuft = Promise.resolve();
  function erinSpeichern(meldungText) {
    var stand = ERIN.liste.slice();
    erinSpeichernLaeuft = erinSpeichernLaeuft.then(async function () {
      var d = await abruf({ aktion: "team-erinnerungen", liste: stand });
      document.querySelectorAll("[data-erin-meldung]").forEach(function (p) {
        p.classList.toggle("fehler", !!d.fehler);
        p.textContent = d.fehler ? "Nicht gespeichert: " + d.fehler : meldungText || "";
      });
    });
  }
  function neueId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  document.querySelectorAll("[data-erin-form]").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var meldung = f.parentNode.querySelector("[data-erin-meldung]");
      var titel = f.titel.value.trim();
      if (!titel) { meldung.classList.add("fehler"); meldung.textContent = "Bitte zuerst eintragen, woran du erinnert werden willst."; f.titel.focus(); return; }
      if (!ERIN.liste) { meldung.textContent = "Einen Moment, die Liste wird noch geladen."; return; }
      if (f.uhrzeit.value && !f.datum.value) f.datum.value = isoTag(new Date());
      ERIN.liste.push({ id: neueId(), titel: titel, datum: f.datum.value || "", uhrzeit: f.uhrzeit.value || "", erledigt: false, erstellt: new Date().toISOString() });
      f.reset();
      meldung.classList.remove("fehler"); meldung.textContent = "Wird gespeichert …";
      erinZeigen();
      erinSpeichern("Gespeichert.");
    });
  });
  document.addEventListener("click", function (e) {
    var li = e.target.closest("[data-erin]"); if (!li || !ERIN.liste) return;
    var eintrag = ERIN.liste.filter(function (x) { return x.id === li.dataset.erin; })[0]; if (!eintrag) return;
    if (e.target.closest("[data-haken]")) { eintrag.erledigt = !eintrag.erledigt; erinZeigen(); erinSpeichern(eintrag.erledigt ? "Erledigt." : "Wieder offen."); }
    else if (e.target.closest("[data-weg]")) { ERIN.liste = ERIN.liste.filter(function (x) { return x !== eintrag; }); erinZeigen(); erinSpeichern("Gelöscht."); }
  });
  // Solange die Seite offen ist: zur geplanten Uhrzeit kurz Bescheid geben
  setInterval(function () {
    if (!ERIN.liste) return;
    var jetzt = new Date();
    ERIN.liste.forEach(function (e) {
      if (e.erledigt || !e.uhrzeit || ERIN.gemeldet[e.id]) return;
      var f = erinFaellig(e);
      if (f <= jetzt && jetzt - f < 5 * 60000) { ERIN.gemeldet[e.id] = true; hinweis("Erinnerung: " + e.titel); erinZeigen(); }
    });
  }, 20000);

  /* ---------------- Schlagzeilen und Meldungen ---------------- */

  var NACHR = { bsn: null, ts: null };
  var RESSORT = { inland: "Inland", ausland: "Ausland", wirtschaft: "Wirtschaft", sport: "Sport", wissen: "Wissen", investigativ: "Investigativ", faktenfinder: "Faktenfinder" };

  function bsn(pfad) {
    return fetch(BSN.url + pfad, { headers: { apikey: BSN.key } }).then(function (r) {
      if (!r.ok) throw new Error("Bad Salzuflen News nicht erreichbar");
      return r.json();
    });
  }
  async function badSalzuflen() {
    try {
      var artikel = await bsn("/articles?select=title,category,slug,published_at&status=eq.published&order=published_at.desc&limit=12");
      NACHR.bsn = artikel.map(function (a) {
        return { quelle: "Bad Salzuflen News", kurz: "BSN", titel: a.title, link: BSN.seite + "artikel.html?s=" + encodeURIComponent(a.slug), zeit: a.published_at, zusatz: a.category };
      });
      $("l-bs").innerHTML = NACHR.bsn.length ? NACHR.bsn.slice(0, 5).map(meldung).join("") : '<li class="leer">Gerade keine Meldungen.</li>';
    } catch (f) {
      NACHR.bsn = [];
      leer("l-bs", "Bad Salzuflen News ist gerade nicht erreichbar.");
    }
    nachrichtenZeigen();
  }
  async function welt() {
    try {
      var r = await fetch("https://www.tagesschau.de/api2u/homepage/");
      if (!r.ok) throw new Error();
      var d = await r.json();
      NACHR.ts = (d.news || []).filter(function (n) { return n.title && n.shareURL && n.type !== "video"; }).slice(0, 12).map(function (n) {
        return { quelle: "Tagesschau", kurz: "TS", titel: n.title, link: n.shareURL, zeit: n.date, zusatz: RESSORT[n.ressort] || "" };
      });
      if (!NACHR.ts.length) throw new Error();
      $("l-welt").innerHTML = NACHR.ts.slice(0, 5).map(meldung).join("");
    } catch (f) {
      NACHR.ts = [];
      leer("l-welt", "Die Tagesschau ist gerade nicht erreichbar.");
    }
    nachrichtenZeigen();
  }
  function meldung(n) {
    var info = [n.zusatz, n.zeit ? vorWann(n.zeit) : ""].filter(Boolean).join(" · ");
    return '<li><a href="' + esc(n.link) + '" target="_blank" rel="noopener"><span class="quelle">' + esc(n.kurz) + '</span><span class="t"><b>' + esc(n.titel) + "</b><small>" + esc(info || n.quelle) + "</small></span></a></li>";
  }
  function nachrichtenZeigen() {
    if (NACHR.bsn === null || NACHR.ts === null) return; // erst wenn beide da sind
    var alle = NACHR.bsn.concat(NACHR.ts).sort(function (a, b) { return (Date.parse(b.zeit) || 0) - (Date.parse(a.zeit) || 0); });
    $("n-alle").innerHTML = alle.length ? alle.map(function (n) {
      var info = [n.quelle, n.zusatz, n.zeit ? vorWann(n.zeit) : ""].filter(Boolean).join(" · ");
      return '<li><a href="' + esc(n.link) + '" target="_blank" rel="noopener"><span class="quelle">' + esc(n.kurz) + '</span><span class="t"><b>' + esc(n.titel) + "</b><small>" + esc(info) + "</small></span></a></li>";
    }).join("") : '<li class="leer">Gerade keine Meldungen erreichbar.</li>';
    // Schlagzeilen-Wechsler: abwechselnd Bad Salzuflen News und Tagesschau
    var liste = [];
    for (var i = 0; i < 7; i++) { if (NACHR.bsn[i]) liste.push(NACHR.bsn[i]); if (NACHR.ts[i]) liste.push(NACHR.ts[i]); }
    szStart(liste);
  }

  var SZ = { liste: [], nr: 0, uhr: null, pause: false };
  function szFuellen() {
    var s = SZ.liste[SZ.nr]; if (!s) return;
    $("sz-link").href = s.link;
    $("sz-kopf").innerHTML = "<b>" + esc(s.quelle) + "</b>" + (s.zeit ? " · " + vorWann(s.zeit) : "");
    $("sz-titel").textContent = s.titel;
    [].forEach.call($("sz-punkte").children, function (b, i) { b.setAttribute("aria-current", i === SZ.nr); });
    var n = SZ.liste.length, danach = [];
    for (var k = 1; k <= 2 && k < n; k++) danach.push((SZ.nr + k) % n);
    $("sz-danach").innerHTML = danach.map(function (i) {
      return '<li data-nr="' + i + '"><span class="q">' + esc(SZ.liste[i].kurz === "BSN" ? "BAD SALZUFLEN" : "TAGESSCHAU") + '</span><span class="t">' + esc(SZ.liste[i].titel) + "</span></li>";
    }).join("");
    var b = $("sz-balken"); b.classList.remove("lauf"); void b.offsetWidth; b.classList.add("lauf");
  }
  function szZeigen(nr) {
    SZ.nr = (nr + SZ.liste.length) % SZ.liste.length;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { szFuellen(); return; }
    $("sz-karte").classList.add("aus");
    setTimeout(function () { szFuellen(); $("sz-karte").classList.remove("aus"); }, 220);
  }
  function szStart(liste) {
    var vorher = SZ.liste[SZ.nr] && SZ.liste[SZ.nr].link;
    SZ.liste = liste;
    if (!liste.length) { $("sz-kopf").textContent = "Gerade keine Schlagzeilen erreichbar."; $("sz-titel").textContent = ""; return; }
    $("sz-punkte").innerHTML = liste.map(function (s, i) { return '<button type="button" data-nr="' + i + '" aria-label="Schlagzeile ' + (i + 1) + ' zeigen"></button>'; }).join("");
    var gleich = liste.findIndex(function (s) { return s.link === vorher; });
    SZ.nr = gleich >= 0 ? gleich : 0; szFuellen();
    clearInterval(SZ.uhr);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      SZ.uhr = setInterval(function () { if (!SZ.pause && !document.hidden) szZeigen(SZ.nr + 1); }, 7000);
    }
  }
  function szHalt(an) { SZ.pause = an; $("sz-karte").classList.toggle("halt", an); }
  $("sz-karte").addEventListener("mouseenter", function () { szHalt(true); });
  $("sz-karte").addEventListener("mouseleave", function () { szHalt(false); });
  $("sz-karte").addEventListener("focusin", function () { szHalt(true); });
  $("sz-karte").addEventListener("focusout", function () { szHalt(false); });
  $("sz-balken").addEventListener("animationend", function () { if (SZ.liste.length) szZeigen(SZ.nr + 1); });
  $("sz-danach").addEventListener("click", function (e) { var li = e.target.closest("[data-nr]"); if (li) szZeigen(+li.dataset.nr); });
  $("sz-punkte").addEventListener("click", function (e) { var b = e.target.closest("[data-nr]"); if (b) szZeigen(+b.dataset.nr); });

  /* ---------------- Übersicht vom Server ---------------- */

  var UEBER = { mehr: false, aelteste: null };
  async function uebersichtLaden() {
    var d = await abruf({ aktion: "team-uebersicht" });
    if (typeof d.fehler === "string") {
      leer("mails-kurz", d.fehler); leer("erin-kurz", d.fehler);
      $("woche").innerHTML = '<p class="leer-text">' + esc(d.fehler) + "</p>";
      return;
    }
    MAIL.postfach = d.postfach || "";
    eigeneZeigen(d.ordner);
    if (d.person && !PERSON) {
      PERSON = d.person;
      var vorname = String(PERSON.name).split(" ")[0];
      $("gruss").textContent = $("gruss").textContent.replace(/,.*$/, "") + ", " + vorname;
    }
    $("mail-adresse").textContent = MAIL.postfach ? "an " + MAIL.postfach : "";
    $("vorschau").hidden = !d.vorschau;
    UEBER.mehr = d.mehr; UEBER.aelteste = d.aelteste;
    var mailFehler = (d.fehler || []).filter(function (f) { return /^Mail/.test(f); }).map(function (f) { return f.replace(/^Mail: /, ""); })[0];
    kurzZeigen(d.mails || [], mailFehler);
    kalenderZeigen(d);
    // Erinnerungen nicht überschreiben, während gerade gespeichert wird
    if (!ERIN.liste) { ERIN.liste = d.erinnerungen || []; erinZeigen(); }
  }

  /* ---------------- Start ---------------- */

  badSalzuflen();
  welt();
  if (!sb) return;

  $("abmelden").addEventListener("click", function () { sb.auth.signOut().then(function () { location.replace("anmelden.html"); }); });

  sb.auth.getSession().then(function (r) {
    if (!r.data.session) { location.replace("anmelden.html"); return; }
    var email = String(r.data.session.user.email || "").toLowerCase();
    var k = (email.charAt(0) || "T").toUpperCase();
    $("kuerzel").textContent = k; $("ich-kuerzel").textContent = k;
    if (CHEFS.indexOf(email) >= 0) $("vorschau").hidden = false;
    uebersichtLaden();
    aufrufeLaden();
    instagramLaden();
    setInterval(allesNeu, 120000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() - ZULETZT > 120000) allesNeu(); });
  });

  var ZULETZT = Date.now();
  function allesNeu() {
    if (document.hidden) return;
    ZULETZT = Date.now();
    uebersichtLaden();
    aufrufeLaden();
    instagramLaden();
    badSalzuflen();
    welt();
  }
})();
