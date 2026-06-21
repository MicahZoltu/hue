/*
 * Hue Bridge v1 ("CLIP") protocol layer.
 *
 * Endpoints are reached at <scheme>//<ip>/api/<token>/... where <scheme> is
 * chosen by bridgeScheme() below — https when the page is itself a secure
 * context (https:, chrome-extension:, ...), http otherwise (http:, file:,
 * ipfs:, ipns:, data:, blob:, about:, capacitor:, cordova:, ionic:, tauri:,
 * android-app:, content:, ...). HTTP is preferred wherever it's allowed
 * because the bridge's self-signed HTTPS certificate is rejected by most
 * browsers' fetch() even after the user clicks through the warning.
 *
 * Errors are normalized to { code, message } so the UI can branch on code
 * without parsing strings.
 *
 * Codes:
 *   TIMEOUT      request took too long (bridge slow or unreachable)
 *   NETWORK      generic fetch failure (offline, CORS, cert, DNS, etc.)
 *   UNAUTHORIZED token rejected
 *   LINK_BUTTON  pair() got a non-101 error response
 *   HTTP_ERROR   bridge returned non-2xx for a reason we did not classify
 *   BRIDGE_OFFLINE  testBridge() couldn't reach /api/
 *   BAD_RESPONSE bridge returned something we couldn't parse
 */

(function (global) {
	'use strict';

	var ALLOWED_LIGHT_TYPES = [
		'Extended color light',
		'Color light',
		'Color temperature light',
		'Dimmable light',
		'On/Off plug-in unit'
	];
	var ALLOWED_GROUP_TYPES = ['Room', 'Zone'];
	var ALLOWED_SCENE_TYPES = ['GroupScene'];

	function HueError(code, message) {
		this.code = code;
		this.message = message;
	}
	HueError.prototype = Object.create(Error.prototype);

	// Decide which scheme to use when talking to the bridge.
	//
	// The Hue Bridge uses a self-signed HTTPS certificate that most browsers
	// (notably Chrome) refuse to accept for fetch() API calls, even after the
	// user has clicked through the warning in the address bar. Plain HTTP has
	// no such problem, so we prefer it whenever the page's own origin does not
	// forbid it.
	//
	//   https:                -> https  (mixed-content rules block http fetch)
	//   chrome-extension:,
	//   moz-extension:,
	//   safari-extension:     -> https  (secure contexts; same mixed-content block)
	//   everything else
	//   (http:, file:, ipfs:, ipns:, data:, blob:, about:,
	//    capacitor:, cordova:, ionic:, tauri:, android-app:,
	//    content:, ...)        -> http   (no mixed-content enforcement)
	//
	// `location` may be undefined in non-browser environments (unit tests), in
	// which case we fall back to http since there is no secure-context pressure.
	var SECURE_ORIGIN_PROTOCOLS = { 'https:': 1, 'chrome-extension:': 1, 'moz-extension:': 1, 'safari-extension:': 1 };

	function bridgeScheme() {
		var p = (typeof location !== 'undefined' && location.protocol) || '';
		return SECURE_ORIGIN_PROTOCOLS[p] ? 'https:' : 'http:';
	}

	var scheme = bridgeScheme();

	function makeUrl(ip, path) {
		return scheme + '//' + ip + path;
	}

	function request(url, opts) {
		opts = opts || {};
		var timeoutMs = opts.timeoutMs || 1500;
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
		var fetchOpts = {
			method: opts.method || 'GET',
			headers: { 'Content-Type': 'application/json' },
			signal: controller.signal
		};
		if (opts.body != null) fetchOpts.body = JSON.stringify(opts.body);

		return fetch(url, fetchOpts)
			.then(function (resp) {
				clearTimeout(timer);
				return resp.text().then(function (text) {
					var data;
					try { data = text ? JSON.parse(text) : null; }
					catch (e) { throw new HueError('BAD_RESPONSE', 'Bridge returned non-JSON: ' + text.slice(0, 80)); }
					if (!resp.ok) {
						throw new HueError('HTTP_ERROR', 'HTTP ' + resp.status);
					}
					return data;
				});
			})
			.catch(function (err) {
				clearTimeout(timer);
				if (err instanceof HueError) throw err;
				if (err && err.name === 'AbortError') {
					throw new HueError('TIMEOUT', 'Request to bridge timed out');
				}
				throw new HueError('NETWORK', (err && err.message) || 'Network error');
			});
	}

	// Quick reachability check: GET /api/ on a fresh bridge returns a small
	// description object. We just need any 200 response.
	function testBridge(ip) {
		return request(makeUrl(ip, '/api/'), { timeoutMs: 1000 }).then(function () {
			return true;
		}).catch(function (err) {
			if (err.code === 'TIMEOUT' || err.code === 'NETWORK') {
				throw new HueError('BRIDGE_OFFLINE', 'Bridge at ' + ip + ' did not respond');
			}
			throw err;
		});
	}

	// Pairing flow: POST {devicetype} to /api/. The bridge returns an
	// error.type 101 until the physical link button is pressed, then a
	// success.username. We poll every 1.5s for up to ~30s.
	function pair(ip, opts) {
		opts = opts || {};
		var onTick = opts.onTick || function () {};
		var maxAttempts = 20;
		var delayMs = 1500;
		var attempt = 0;

		return new Promise(function (resolve, reject) {
			function tryOnce() {
				attempt++;
				onTick(attempt, maxAttempts);
				request(makeUrl(ip, '/api/'), {
					method: 'POST',
					body: { devicetype: 'hue-spa#browser' },
					timeoutMs: 1000
				}).then(function (data) {
					if (Array.isArray(data) && data[0]) {
						if (data[0].success && data[0].success.username) {
							resolve(data[0].success.username);
							return;
						}
						if (data[0].error) {
							var t = data[0].error.type;
							if (t === 101) {
								if (attempt >= maxAttempts) {
									reject(new HueError('LINK_BUTTON', 'Link button not pressed in time'));
								} else {
									setTimeout(tryOnce, delayMs);
								}
								return;
							}
							reject(new HueError('LINK_BUTTON', data[0].error.description || ('Error ' + t)));
							return;
						}
					}
					reject(new HueError('BAD_RESPONSE', 'Unexpected pairing response'));
				}).catch(function (err) {
					// Network blip during polling - try again unless we're out of attempts
					if (attempt >= maxAttempts) {
						reject(err);
					} else {
						setTimeout(tryOnce, delayMs);
					}
				});
			}
			tryOnce();
		});
	}

	// Verify that saved credentials still work. /api/<token> returns the
	// bridge config when authorized; an unauthorized token returns
	// [{"error":{"type":1}}].
	function verify(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token), { timeoutMs: 1500 })
			.then(function (data) {
				if (data && data.lights) return acc;
				if (Array.isArray(data) && data[0] && data[0].error) {
					throw new HueError('UNAUTHORIZED', data[0].error.description || 'Unauthorized');
				}
				throw new HueError('BAD_RESPONSE', 'Unexpected verify response');
			});
	}

	// --- List endpoints -----------------------------------------------------

	function getLights(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/lights')).then(function (data) {
			var out = [];
			Object.keys(data).forEach(function (id) {
				var l = data[id];
				if (!l || ALLOWED_LIGHT_TYPES.indexOf(l.type) < 0) return;
				out.push({
					id: id,
					name: l.name,
					type: l.type,
					modelid: l.modelid,
					state: l.state || {}
				});
			});
			return out;
		});
	}

	function getGroups(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/groups')).then(function (data) {
			var out = [];
			Object.keys(data).forEach(function (id) {
				var g = data[id];
				if (!g || ALLOWED_GROUP_TYPES.indexOf(g.type) < 0) return;
				out.push({
					id: id,
					name: g.name,
					type: g.type,
					lights: g.lights || [],
					state: g.state || {},
					action: g.action || {}
				});
			});
			return out;
		});
	}

	function getScenes(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/scenes')).then(function (data) {
			var out = [];
			Object.keys(data).forEach(function (id) {
				var s = data[id];
				if (!s || ALLOWED_SCENE_TYPES.indexOf(s.type) < 0) return;
				out.push({
					id: id,
					name: s.name,
					group: s.group
				});
			});
			return out;
		});
	}

	// --- Mutations ----------------------------------------------------------

	function put(acc, path, body) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + path), {
			method: 'PUT',
			body: body
		});
	}

	function setLight(acc, lightId, body) {
		return put(acc, '/lights/' + encodeURIComponent(lightId) + '/state', body);
	}

	function setGroup(acc, groupId, body) {
		return put(acc, '/groups/' + encodeURIComponent(groupId) + '/action', body);
	}

	function activateScene(acc, groupId, sceneId) {
		return setGroup(acc, groupId, { scene: sceneId });
	}

	global.HueApi = {
		testBridge:    testBridge,
		pair:          pair,
		verify:        verify,
		getLights:     getLights,
		getGroups:     getGroups,
		getScenes:     getScenes,
		setLight:      setLight,
		setGroup:      setGroup,
		activateScene: activateScene,
		HueError:      HueError,
		scheme:        scheme
	};
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
