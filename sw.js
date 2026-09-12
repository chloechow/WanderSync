/*
 * WanderSync App Shell Service Worker
 * ------------------------------------------------------------------
 * Purpose: an iPhone home-screen web app is a true cold start every single
 * launch (iOS kills the process, there's no bfcache, and its storage is
 * fully isolated from Safari — so the localStorage cache-first rendering
 * built elsewhere is unavailable here). Without a service worker, every
 * home-screen tap would re-download index.html + 3 stylesheets + fonts
 * over the network, which is the root cause of the white-screen flash.
 * This file does exactly one thing: cache those "shell" assets in Cache
 * Storage so the UI can paint instantly even offline or on a bad network.
 *
 * Deliberately NOT done (documented so it doesn't get "fixed" later):
 *   - No caching of any cross-origin request (Firebase SDK on gstatic,
 *     Firestore's realtime channel, identitytoolkit auth, the Gemini API).
 *     Caching those would produce an extremely hard-to-debug "stale data
 *     after being offline for a while" state, so they always pass straight
 *     through to the network — the SW never intercepts them.
 *   - No skipWaiting(). A new version only activates on the next launch:
 *     since a home-screen app is a cold start every time anyway, there's
 *     no "assets swapped out mid-session" risk to race against.
 */

const SW_VERSION = 'v2';
const CACHE_NAME = `wandersync-shell-${SW_VERSION}`;

// All paths are relative: a GitHub Pages project site is served under a
// subpath like <user>.github.io/WanderSync/, so an absolute path such as
// /index.html would 404.
const PRECACHE_URLS = [
  './',
  './index.html',
  './tailwind.min.css',
  './fontawesome-subset.css',
  './poppins-subset.css',
  './fonts/fa-solid-900-subset.woff2',
  './fonts/poppins-latin-700-normal.woff2',
  './fonts/poppins-latin-900-normal.woff2',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Add one at a time — a single asset's 404/network failure shouldn't
    // fail the whole install; caching even just index.html beats nothing.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (res && res.ok) {
          await cache.put(url, res);
        }
      } catch (e) {
        // A network failure during install is normal (e.g. first
        // registration while offline); don't block caching the rest.
      }
    }));
  })());
  // No self.skipWaiting(): the new SW stays waiting and only activates on
  // the next launch, once all of the old SW's clients have closed.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean up old cache versions: the shell assets need to be updatable, and a cache that can never be superseded is a real liability.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('wandersync-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

function isCacheableResponse(res) {
  // Skip non-200 responses (404/500 included) and opaque ones (the
  // status/content-blind response type cross-origin no-cors requests
  // return — there's no way to tell if it's good, so don't cache it).
  return !!res && res.status === 200 && res.type === 'basic';
}

// Turn PRECACHE_URLS into a set of absolute URLs, compared against absolute
// request URLs at fetch time — avoids error-prone string concatenation of
// a GitHub Pages subpath with relative paths.
const PRECACHE_ABSOLUTE_URLS = new Set(
  PRECACHE_URLS.map((u) => new URL(u, self.registration.scope).href)
);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only intercept same-origin static shell assets. The Firebase SDK
  // (gstatic), Firestore's realtime channel, identitytoolkit auth, and the
  // Gemini API always go straight to the network, untouched by the SW —
  // caching them would cause an extremely hard-to-debug "stale data" issue.
  if (url.origin !== self.location.origin) return;

  // Navigation requests (opening/refreshing the page): stale-while-revalidate
  // — serve the cached shell instantly, refreshing the cache in the
  // background for next launch.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      // Try an exact match on this navigation's URL first (e.g. the
      // "/WanderSync/" directory itself); fall back to the cached
      // index.html (e.g. first run after clearing cache) — the two are
      // equivalent, since GitHub Pages serves index.html for directory
      // requests anyway.
      const cached = (await cache.match(request)) || (await cache.match('./index.html'));

      const networkFetch = fetch(request).then((res) => {
        if (isCacheableResponse(res)) {
          cache.put(request, res.clone());
        }
        return res;
      }).catch(() => null);

      if (cached) {
        // Refresh in the background; don't await it or block this render.
        networkFetch.catch(() => {});
        return cached;
      }

      const networkRes = await networkFetch;
      if (networkRes) return networkRes;

      // Neither network nor cache available: no better fallback exists,
      // so surface an error and let the browser show its default offline page.
      return new Response('WanderSync 离线且本地暂无缓存，请在联网状态下先打开一次应用。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  // Remaining same-origin static assets (CSS / fonts / manifest / icons):
  // cache-first — serve a hit directly; on a miss, fetch from the network
  // and cache it for next time. There is no revalidation, so any change to
  // a static asset requires bumping SW_VERSION.
  const isShellAsset = PRECACHE_ABSOLUTE_URLS.has(url.href) ||
    request.destination === 'style' || request.destination === 'font' ||
    request.destination === 'image';
  if (isShellAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const res = await fetch(request);
        if (isCacheableResponse(res)) {
          cache.put(request, res.clone());
        }
        return res;
      } catch (e) {
        // Offline and never cached: no better option than letting the request fail.
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      }
    })());
  }
  // Other same-origin requests (types not listed above): don't intercept, fall through to default network behavior.
});
