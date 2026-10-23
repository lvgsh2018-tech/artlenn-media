/* MeinOrbit im Browser.

   Die Oberflaeche (orbit.html) ist die vom Mac, das Rechenprogramm auch: es
   laeuft hier mit Pyodide. Diese Datei spielt den kleinen Server von dort:
   Sie faengt die Aufrufe an /api/... und die Links auf Rechnungen, Tabellen und
   Dateien ab, reicht sie an orbit/bruecke.py weiter und speichert danach, was
   sich geaendert hat:
   - die Datendatei gepackt in der Tabelle orbit_datenbank (mit Versionszaehler,
     damit zwei offene Geraete sich nicht gegenseitig ueberschreiben),
   - abgelegte Dateien und Sicherungen in der privaten Ablage "orbit".
   Ohne Eintrag in assets/js/config.js laeuft ein Beispielmodus, der nur in
   diesem Browser speichert. */
(function () {
  "use strict";

  var C = window.AM_CONFIG || {};
  var ECHT = !!(C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase);
  var sb = ECHT ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY) : null;
  var STAND = window.ORBIT_STAND || "";
  var ABLAGE = "orbit";
  var BEISPIEL = "artlenn-orbit-mac-beispiel";
  var SICHERN_ALLE_STUNDEN = 6;
  var PROGRAMM = ["meinorbit.py", "datenbank.py", "vorgaenge.py", "rechnung.py", "finanzen.py",
    "kalender.py", "content.py", "sperre.py", "qr.py"];

  var echtesFetch = window.fetch.bind(window);
  var py = null;            // die Funktionen aus bruecke.py
  var pyo = null;           // Pyodide selbst
  var version = 0;          // Stand der Datendatei in Supabase
  var gespeichert = "";     // Fingerabdruck der zuletzt gespeicherten Datendatei
  var dokStand = {};        // Name -> [Groesse, Zeit] der zuletzt abgeglichenen Dateien
  var ungesichert = false;

  /* ---------- Hilfen ---------- */

  function fehler(r) { if (r.error) throw new Error(r.error.message || String(r.error)); return r.data; }

  // Die Ablage nimmt nur einfache Zeichen; Dateinamen wie "58,89 EUR Büro.pdf"
  // werden deshalb als base64url abgelegt.
  function schluessel(name) {
    var b = new TextEncoder().encode(name), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function name(schl) {
    var s = atob(schl.replace(/-/g, "+").replace(/_/g, "/"));
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return new TextDecoder().decode(b);
  }

  function lesen(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function merken(k, v) {
    try { localStorage.setItem(k, v); }
    catch (e) { throw new Error("Der Speicher dieses Browsers ist voll."); }
  }

  /* Abgelegte Dateien zusaetzlich im Browser vorhalten, damit sie nicht bei
     jedem Oeffnen neu geladen werden muessen. */
  var idb = new Promise(function (ok) {
    try {
      var r = indexedDB.open("meinorbit-dateien", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("dateien"); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ok(null); };
    } catch (e) { ok(null); }
  });
  function zwischenspeicher(art, schl, wert) {
    return idb.then(function (d) {
      if (!d) return null;
      return new Promise(function (ok) {
        try {
          var t = d.transaction("dateien", art === "lesen" ? "readonly" : "readwrite").objectStore("dateien");
          var r = art === "lesen" ? t.get(schl) : t.put(wert, schl);
          r.onsuccess = function () { ok(r.result || null); };
          r.onerror = function () { ok(null); };
        } catch (e) { ok(null); }
      });
    });
  }

  /* ---------- Start ---------- */

  var bereit = (async function () {
    if (ECHT) {
      var s = await sb.auth.getSession();
      if (!s.data.session) {
        location.replace("anmelden.html");
        return new Promise(function () {});
      }
    }
    var quellen = await Promise.all([
      loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" })
    ].concat(PROGRAMM.concat(["../bruecke.py"]).map(function (n) {
      return echtesFetch("orbit/programm/" + n + "?v=" + STAND).then(function (r) {
        if (!r.ok) throw new Error(n + " fehlt");
        return r.text();
      });
    })));
    pyo = quellen[0];
    await pyo.loadPackage("sqlite3");
    pyo.FS.mkdirTree("/programm");
    pyo.FS.mkdirTree("/daten/dokumente");
    pyo.FS.mkdirTree("/daten/sicherungen");
    PROGRAMM.forEach(function (n, i) { pyo.FS.writeFile("/programm/" + n, quellen[i + 1]); });
    pyo.FS.writeFile("/programm/bruecke.py", quellen[quellen.length - 1]);

    pyo.runPython("import sys\nsys.path.insert(0, '/programm')");
    await bestandHolen();
    py = pyo.pyimport("bruecke");
    py.adresse_setzen(location.origin);
    py.vorbereiten();
    await ersteFassungUebernehmen();
    await dateienHolen();
    await sicherungenAuflisten();
    await synchronisieren();
    await vonSelbstSichern();
  })();

  bereit.catch(function (f) { console.error(f); });

  async function bestandHolen() {
    if (!ECHT) {
      var alt = lesen(BEISPIEL);
      if (alt) { schreibenRoh(alt); }
      return;
    }
    var r = fehler(await sb.from("orbit_datenbank").select("inhalt, version").eq("id", 1).maybeSingle());
    if (r) { schreibenRoh(r.inhalt); version = r.version; }
  }

  function schreibenRoh(text) {
    // Noch vor dem Import von bruecke.py: gzip und base64 direkt in Python
    pyo.globals.set("_roh", text);
    pyo.runPython("import base64, gzip, os\nos.makedirs('/daten', exist_ok=True)\n" +
      "open('/daten/meinorbit.db', 'wb').write(gzip.decompress(base64.b64decode(_roh)))");
    pyo.globals.delete("_roh");
  }

  /* Einmalig: was in der ersten Browser-Fassung (bis 2026-10-23) angelegt
     wurde, kommt dazu. bruecke.py merkt sich, dass es erledigt ist. */
  async function ersteFassungUebernehmen() {
    if (!ECHT || py.einstellung("web_alt_uebernommen") === "ja") return;
    var t = await Promise.all(["kunden", "leistungen", "einstellungen"].map(function (n) {
      return sb.from(n).select("*").order(n === "einstellungen" ? "schluessel" : "id");
    }));
    if (t.some(function (r) { return r.error; })) return;
    var einst = {};
    t[2].data.forEach(function (z) { einst[z.schluessel] = z.wert; });
    py.alte_webdaten(JSON.stringify({ kunden: t[0].data, leistungen: t[1].data, einstellungen: einst }));
  }

  async function dateienHolen() {
    if (!ECHT) return;
    var liste = fehler(await sb.storage.from(ABLAGE).list("dokumente", { limit: 10000 }));
    await Promise.all(liste.filter(function (x) { return x.id; }).map(async function (x) {
      var n = name(x.name), kennung = x.updated_at + ":" + (x.metadata && x.metadata.size);
      var vorrat = await zwischenspeicher("lesen", x.name);
      var bytes;
      if (vorrat && vorrat.kennung === kennung) {
        bytes = vorrat.bytes;
      } else {
        var blob = fehler(await sb.storage.from(ABLAGE).download("dokumente/" + x.name));
        bytes = new Uint8Array(await blob.arrayBuffer());
        zwischenspeicher("schreiben", x.name, { kennung: kennung, bytes: bytes });
      }
      pyo.FS.writeFile("/daten/dokumente/" + n, bytes);
    }));
    dokStand = JSON.parse(py.dokumente());
  }

  async function sicherungenAuflisten() {
    var liste = [];
    if (ECHT) {
      var roh = fehler(await sb.storage.from(ABLAGE).list("sicherungen", { limit: 1000, sortBy: { column: "name", order: "desc" } }));
      liste = roh.filter(function (x) { return x.id; });
    } else {
      liste = JSON.parse(lesen(BEISPIEL + "-sicherungen") || "[]");
    }
    py.sicherungen_setzen(JSON.stringify(liste.slice(0, 12).map(function (x) {
      var z = new Date(x.created_at || x.zeit);
      return {
        name: x.name, groesse: Math.round(((x.metadata && x.metadata.size) || x.groesse || 0) / 102.4) / 10,
        zeit: z.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " +
          z.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      };
    })));
    return liste;
  }

  async function vonSelbstSichern() {
    if (py.einstellung("sicherung_automatisch", "ja") !== "ja") return;
    var liste = await sicherungenAuflisten();
    var letzte = liste.length ? new Date(liste[0].created_at || liste[0].zeit).getTime() : 0;
    if (Date.now() - letzte < SICHERN_ALLE_STUNDEN * 3600000) return;
    pyo.runPython("import datenbank\ndatenbank.sicherung_anlegen()");
    await synchronisieren();
  }

  /* ---------- Speichern ---------- */

  async function synchronisieren() {
    var jetzt = py.stand();
    if (jetzt && jetzt !== gespeichert) {
      var paket = py.paket();
      if (ECHT) {
        var r = await sb.rpc("orbit_speichern", { neu: paket, erwartet: version });
        if (r.error) {
          if (/ANDERSWO_GEAENDERT/.test(r.error.message)) {
            await bestandHolen();
            gespeichert = py.stand();
            ungesichert = false;
            throw new Error("Auf einem anderen Gerät wurde inzwischen etwas geändert. " +
              "Der neue Stand ist geladen, bitte die letzte Eingabe wiederholen.");
          }
          ungesichert = true;
          throw new Error("Speichern hat nicht geklappt: " + r.error.message);
        }
        version = r.data;
      } else {
        merken(BEISPIEL, paket);
      }
      gespeichert = jetzt;
      ungesichert = false;
    }

    // Abgelegte Dateien: neue hoch, verschwundene in den Papierkorb
    var dok = JSON.parse(py.dokumente());
    if (ECHT) {
      for (var n in dok) {
        var alt = dokStand[n];
        if (alt && alt[0] === dok[n][0] && alt[1] === dok[n][1]) continue;
        var bytes = pyo.FS.readFile("/daten/dokumente/" + n);
        fehler(await sb.storage.from(ABLAGE).upload("dokumente/" + schluessel(n), bytes, { upsert: true, contentType: "application/octet-stream" }));
      }
      for (var w in dokStand) {
        if (dok[w]) continue;
        var stempel = new Date().toISOString().replace(/[:.]/g, "-");
        await sb.storage.from(ABLAGE).move("dokumente/" + schluessel(w), "papierkorb/" + stempel + "-" + schluessel(w));
      }
    }
    dokStand = dok;

    // Neue Sicherungen hochladen, dann vor Ort loeschen und Alte aufraeumen
    var neue = JSON.parse(py.neue_sicherungen());
    if (neue.length) {
      var behalten = parseInt(py.einstellung("sicherung_anzahl", "30"), 10) || 30;
      for (var i = 0; i < neue.length; i++) {
        var pfad = "/daten/sicherungen/" + neue[i];
        var inhalt = pyo.FS.readFile(pfad);
        if (ECHT) {
          fehler(await sb.storage.from(ABLAGE).upload("sicherungen/" + neue[i], inhalt, { upsert: true, contentType: "application/zip" }));
        } else {
          var l = JSON.parse(lesen(BEISPIEL + "-sicherungen") || "[]");
          l.unshift({ name: neue[i], groesse: inhalt.length, zeit: new Date().toISOString() });
          merken(BEISPIEL + "-sicherungen", JSON.stringify(l.slice(0, behalten)));
        }
        pyo.FS.unlink(pfad);
      }
      var alle = await sicherungenAuflisten();
      if (ECHT && alle.length > behalten) {
        await sb.storage.from(ABLAGE).remove(alle.slice(behalten).map(function (x) { return "sicherungen/" + x.name; }));
        await sicherungenAuflisten();
      }
    }
  }

  /* Wurde auf einem anderen Geraet gespeichert, waehrend dieses Fenster im
     Hintergrund lag? Dann beim Zurueckkommen den neuen Stand holen. */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !ECHT || !py || ungesichert) return;
    reihe(async function () {
      var r = await sb.from("orbit_datenbank").select("version").eq("id", 1).maybeSingle();
      if (r.error || !r.data || r.data.version === version) return;
      await bestandHolen();
      gespeichert = py.stand();
      await dateienHolen();
      if (typeof window.neuLaden === "function") window.neuLaden();
    });
  });

  window.addEventListener("beforeunload", function (ev) {
    if (ungesichert) { ev.preventDefault(); ev.returnValue = ""; }
  });

  /* ---------- Der Server ---------- */

  // Eine Anfrage nach der anderen, wie am Mac auch nur eine Datendatei offen ist.
  var schlange = Promise.resolve();
  function reihe(aufgabe) {
    var weiter = schlange.then(aufgabe);
    schlange = weiter.catch(function () {});
    return weiter;
  }

  function antwortJson(daten, code) {
    return { code: code || 200, typ: "application/json; charset=utf-8", inhalt: JSON.stringify(daten), name: "" };
  }

  async function sperre(pfad) {
    // Das Passwort ist hier die Anmeldung der Webseite. "Jetzt sperren" meldet ab.
    if (pfad === "/api/sperre") return antwortJson({ aktiv: true, offen: true, minuten: 0, beim_oeffnen: false });
    if (pfad === "/api/sperre/zu") {
      if (ECHT) await sb.auth.signOut();
      return antwortJson({ ok: true, offen: false });
    }
    return antwortJson({ fehler: "Im Browser gilt das Passwort der Anmeldung auf artlenn.de." }, 400);
  }

  function bearbeiten(methode, adresse, koerper) {
    return reihe(async function () {
      await bereit;
      var u = new URL(adresse, location.href);
      if (u.pathname.indexOf("/api/sperre") === 0) return sperre(u.pathname);
      var r = py.anfrage(methode, u.pathname + u.search, koerper || "");
      var teile = r.toJs();
      r.destroy();
      var antwort = { code: teile[0], typ: teile[1], inhalt: teile[2], name: teile[3] };
      try {
        await synchronisieren();
      } catch (f) {
        return antwortJson({ fehler: f.message }, 409);
      }
      return antwort;
    });
  }

  var SEITEN = /^\/(rechnung|angebot|storno|mahnung)\/\d+\.(html|xml)$|^\/kalender\.ics$|^\/ausgabe\/|^\/datei\//;

  function istUnseres(pfad) { return pfad.indexOf("/api/") === 0 || SEITEN.test(pfad); }

  window.fetch = function (eingabe, optionen) {
    var adresse = typeof eingabe === "string" ? eingabe : eingabe.url;
    var u = new URL(adresse, location.href);
    if (u.origin !== location.origin || !istUnseres(u.pathname)) return echtesFetch(eingabe, optionen);
    optionen = optionen || {};
    return bearbeiten((optionen.method || "GET").toUpperCase(), adresse, optionen.body).then(function (a) {
      return new Response(a.inhalt, { status: a.code, headers: { "Content-Type": a.typ } });
    });
  };

  /* Links auf Rechnungen, Tabellen und Dateien: Seiten in einem neuen Fenster,
     alles mit Dateinamen als Download - wie beim Server am Mac. */
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[href]");
    if (!a || ev.defaultPrevented) return;
    var u = new URL(a.getAttribute("href"), location.href);
    if (u.origin !== location.origin || !SEITEN.test(u.pathname)) return;
    ev.preventDefault();
    var alsSeite = /\.html$/.test(u.pathname) || u.pathname.indexOf("/datei/") === 0;
    var fenster = alsSeite ? window.open("", "_blank") : null;
    if (fenster) fenster.document.write("<p style='font:15px -apple-system,sans-serif;padding:24px'>Einen Augenblick …</p>");
    bearbeiten("GET", u.pathname + u.search, "").then(function (a) {
      if (a.code !== 200) {
        var t = typeof a.inhalt === "string" ? a.inhalt : new TextDecoder().decode(a.inhalt);
        throw new Error((JSON.parse(t) || {}).fehler || "Nicht gefunden.");
      }
      var typ = a.typ;
      if (u.pathname.indexOf("/datei/") === 0) typ = dateityp(u.pathname) || typ;
      var url = URL.createObjectURL(new Blob([a.inhalt], { type: typ }));
      if (a.name || !alsSeite) {
        var l = document.createElement("a");
        l.href = url;
        l.download = a.name || decodeURIComponent(u.pathname.split("/").pop());
        document.body.appendChild(l);
        l.click();
        l.remove();
        if (fenster) fenster.close();
      } else if (fenster) {
        fenster.location.href = url;
      } else {
        ueberlagern(url);
        return;
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (f) {
      if (fenster) fenster.close();
      if (typeof window.melden === "function") window.melden(f.message, true);
    });
  }, true);

  /* Blockiert der Browser neue Fenster (etwa als Web-App im Dock), liegt die
     Seite stattdessen ueber MeinOrbit. "Schliessen" und "Drucken" gelten dann
     fuer diese Ebene. */
  function ueberlagern(url) {
    var ebene = document.createElement("iframe");
    ebene.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:10000;background:#fff";
    var zu = document.createElement("button");
    zu.textContent = "Zurück zu MeinOrbit";
    zu.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:10001;font:500 13px -apple-system,'Segoe UI',sans-serif;" +
      "padding:9px 14px;border-radius:8px;border:1px solid #d5dde8;background:#fff;color:#0d253d;cursor:pointer;" +
      "box-shadow:0 2px 8px rgba(13,37,61,.12)";
    zu.onclick = weg;
    function weg() {
      ebene.remove(); zu.remove(); URL.revokeObjectURL(url);
      document.removeEventListener("keydown", taste);
    }
    function taste(ev) { if (ev.key === "Escape") weg(); }
    ebene.onload = function () {
      try {
        ebene.contentWindow.close = weg;
        ebene.contentWindow.addEventListener("keydown", taste);
      } catch (e) { /* fremde Datei ohne Zugriff */ }
    };
    document.addEventListener("keydown", taste);
    ebene.src = url;
    document.body.appendChild(ebene);
    document.body.appendChild(zu);
  }

  function dateityp(pfad) {
    var e = (pfad.split(".").pop() || "").toLowerCase();
    return { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
      txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8" }[e] || "";
  }
})();
