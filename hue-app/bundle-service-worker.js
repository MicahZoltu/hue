/*
 * Bundle-aware service worker.
 *
 * Installs from a priority-split bundle system:
 *   - bundles/high-priority.json (HTML + CSS + manifest map)
 *   - bundles/medium-priority.json (JS files)
 *   - bundles/low-priority.json (images, etc.)
 *
 * High-priority bundle is fetched during install and contains a "manifest" field mapping every bundled file path to its priority level.
 * This lets the fetch handler distinguish between "still being downloaded" and "not in any bundle, fall through to network".
 *
 * Medium and low bundles are fetched during activate.
 * Their files are cached as they arrive.
 * The fetch handler awaits the relevant bundle Promise if a requested file isn't cached yet but the manifest says it's coming.
 *
 * If any bundle fails to load (missing directory, 404, parse error, etc.), the service worker still installs and activates.
 * Files from the failed bundle fall through to network like normal requests.
 */

const CACHE_NAME = 'hue-bundle';

var manifest = {};
var mediumDone = null;
var lowDone = null;
var mediumPromise = new Promise(function (resolve) { mediumDone = resolve; });
var lowPromise = new Promise(function (resolve) { lowDone = resolve; });

function b64Decode(b64) {
	var bin = atob(b64);
	var arr = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) {
		arr[i] = bin.charCodeAt(i);
	}
	return arr;
}

function cacheFiles(cache, files) {
	return Promise.all(files.map(function (file) {
		var url = new URL(file.path, self.location.href).href;
		var body = file.encoding === 'base64' ? b64Decode(file.body) : file.body;
		var headers = { 'Content-Type': file.type };
		return cache.put(new Request(url), new Response(body, { headers: headers }));
	}));
}

function fetchBundle(name) {
	return fetch(`./bundle/${name}`)
		.then(function (response) {
			if (!response.ok) {
				throw new Error(name + ' returned ' + response.status);
			}
			return response.json();
		});
}

self.addEventListener('install', function (event) {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(function (cache) {
				return fetchBundle('high-priority.json')
					.then(function (bundle) {
						manifest = bundle.manifest || {};
						return cacheFiles(cache, bundle.files);
					})
					.catch(function (err) {
						if (typeof console !== 'undefined' && console.warn) {
							console.warn('High-priority bundle failed; all requests will use network:', err);
						}
					});
			})
			.then(function () {
				self.skipWaiting();
			})
	);
});

self.addEventListener('activate', function (event) {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(function (cache) {
				var m = fetchBundle('medium-priority.json')
					.then(function (bundle) {
						return cacheFiles(cache, bundle.files);
					})
					.catch(function (err) {
						if (typeof console !== 'undefined' && console.warn) {
							console.warn('Medium-priority bundle failed; JS files will use network:', err);
						}
					})
					.then(mediumDone);

				var l = fetchBundle('low-priority.json')
					.then(function (bundle) {
						return cacheFiles(cache, bundle.files);
					})
					.catch(function (err) {
						if (typeof console !== 'undefined' && console.warn) {
							console.warn('Low-priority bundle failed; image files will use network:', err);
						}
					})
					.then(lowDone);

				return Promise.all([m, l]);
			})
			.then(function () {
				return self.clients.claim();
			})
	);
});

self.addEventListener('fetch', function (event) {
	var url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (event.request.method !== 'GET') return;
	if (url.pathname.endsWith('/bundle-service-worker.js')) return;

	event.respondWith(
		caches.match(event.request).then(function (cached) {
			if (cached) return cached;

			var priority = manifest[url.pathname.replace(/^\//, '')];
			if (!priority) return fetch(event.request);

			if (priority === 'medium') {
				return mediumPromise.then(function () {
					return caches.match(event.request).then(function (c) {
						return c || fetch(event.request);
					});
				});
			}

			if (priority === 'low') {
				return lowPromise.then(function () {
					return caches.match(event.request).then(function (c) {
						return c || fetch(event.request);
					});
				});
			}

			return fetch(event.request);
		})
	);
});