// =============================================================================
// Service worker — offline shell.
//
// The dashboard needs zero network at runtime (it talks to the treadmill over
// Bluetooth and stores history in localStorage), so it should keep working
// with the network down. Without this the installed PWA shows the browser's
// offline page.
//
// Strategy is stale-while-revalidate: serve from cache immediately, then
// refresh the entry in the background so the next launch picks up new code.
// That also replaces the hand-edited `?v=` query strings that used to be the
// only thing keeping stale JS off users' machines.
//
// Bump CACHE_VERSION when the shell changes in a way that must not be mixed
// with an older copy.
// =============================================================================

const CACHE_VERSION = 'v1';
// Cache Storage is shared across the whole origin. On GitHub Pages that origin
// hosts every other project too, so we only ever touch caches we named.
const CACHE_PREFIX = 'pitpat-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './treadmill.js',
    './manifest.json',
    './icon.svg',
    './icon-maskable.svg',
    './lib/protocol.js',
    './lib/units.js',
    './lib/sessions.js',
    './lib/dates.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names
                    .filter(n => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
                    .map(n => caches.delete(n))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(respond(event));
});

async function respond(event) {
    const { request } = event;
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });

    const fromNetwork = fetch(request)
        .then(async response => {
            if (response && response.ok && response.type === 'basic') {
                await cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => null);

    // Cached copy wins on speed; the network copy lands for next time.
    if (cached) {
        // The worker can be terminated as soon as respondWith settles, which
        // would kill the refresh before it writes and strand everyone on the
        // cached copy forever (sw.js itself is served from cache too, so a
        // deploy wouldn't fix it). waitUntil keeps us alive until it lands.
        event.waitUntil(fromNetwork);
        return cached;
    }

    const fresh = await fromNetwork;
    if (fresh) return fresh;

    // Offline with nothing cached: for a navigation, the app shell is still a
    // better answer than a network error.
    if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
    }
    return Response.error();
}
