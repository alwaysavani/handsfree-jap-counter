/* ============================================================
   sw.js — offline support.
   Network-first for the app's own files (so updates always arrive;
   the previous cache-first worker pinned users to old code forever),
   falling back to the cache when offline. Fonts: cache-first.
   ============================================================ */
const CACHE = "jap-counter-v8";
const ASSETS = [
  "./", "./index.html", "./css/styles.css", "./manifest.json",
  "./js/storage.js", "./js/themes.js", "./js/miccheck.js", "./js/chime.js",
  "./js/dsp.js", "./js/audio.js", "./js/pcm-worklet.js", "./js/share.js", "./js/app.js",
  "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
    );
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit ||
      fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }))));
  }
});
