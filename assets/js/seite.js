/* Öffentliche Seite: Menü auf dem Handy, Linie unter der Kopfleiste beim Scrollen,
   sanftes Einblenden der Abschnitte. */
(function () {
  'use strict';
  var kopf = document.getElementById('kopf');
  var knopf = kopf && kopf.querySelector('.menue-knopf');

  function zu() {
    kopf.classList.remove('offen');
    knopf.setAttribute('aria-expanded', 'false');
    knopf.setAttribute('aria-label', 'Menü öffnen');
  }
  if (knopf) {
    knopf.addEventListener('click', function () {
      var offen = kopf.classList.toggle('offen');
      knopf.setAttribute('aria-expanded', String(offen));
      knopf.setAttribute('aria-label', offen ? 'Menü schließen' : 'Menü öffnen');
    });
    kopf.querySelectorAll('nav a').forEach(function (a) { a.addEventListener('click', zu); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') zu(); });
  }

  function gerollt() { kopf && kopf.classList.toggle('gerollt', window.scrollY > 8); }
  window.addEventListener('scroll', gerollt, { passive: true });
  gerollt();

  var jahr = document.getElementById('jahr');
  if (jahr) jahr.textContent = new Date().getFullYear();

  var teile = document.querySelectorAll('.zeigen');
  if (!('IntersectionObserver' in window)) { teile.forEach(function (t) { t.classList.add('da'); }); return; }
  var beob = new IntersectionObserver(function (eintraege) {
    eintraege.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('da'); beob.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  teile.forEach(function (t) { beob.observe(t); });
})();
