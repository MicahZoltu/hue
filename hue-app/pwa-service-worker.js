/*
 * Hue Mobile - service worker.
 *
 * Strategy: cache-first for the app's own files (HTML, CSS, JS, manifest,
 * icon). Cross-origin requests (Hue Bridge API) are passed through
 * untouched so live light state is always fresh and CORS still applies.
 *
 * Bump CACHE to a new version (e.g. hue-mobile-v2) when you want users
 * to drop the old cache. The activate handler deletes any cache whose
 * name doesn't match.
 */

const CACHE = 'hue-mobile-v1';
const ASSETS = [
	'./',
	'./mobile.html',
	'./mobile.css',
	'./mobile.js',
	'./core.js',
	'./color.js',
	'./hue.js',
	'./manifest.webmanifest',
	'./icon.svg'
];

self.addEventListener('install', function (e) {
	e.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }));
	self.skipWaiting();
});

self.addEventListener('activate', function (e) {
	e.waitUntil(caches.keys().then(function (keys) {
		return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
	}).then(function () {
		return self.clients.claim();
	}));
});

self.addEventListener('fetch', function (e) {
	var url = new URL(e.request.url);

	// Only handle same-origin GETs. Cross-origin (bridge) and non-GET
	// requests bypass the service worker entirely.
	if (url.origin !== self.location.origin) return;
	if (e.request.method !== 'GET') return;

	// Never serve the service worker file from cache; the browser must
	// be able to fetch the latest pwa-service-worker.js so updates can be detected.
	if (url.pathname.endsWith('/pwa-service-worker.js')) return;

	e.respondWith(
		caches.match(e.request).then(function (cached) {
			return cached || fetch(e.request);
		})
	);
});
