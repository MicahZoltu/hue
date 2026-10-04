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

	// Hue answers list GETs with an object keyed by resource id, but error
	// responses (e.g. an endpoint the firmware doesn't support, like GET
	// /automations on some bridges) come back as an array: [{"error":{...}}].
	// Normalize: keyed object -> pass through; error array -> throw a HueError
	// so callers don't mistake the error entry for a resource.
	function asKeyedList(data) {
		if (Array.isArray(data)) {
			var e = data[0] && data[0].error;
			if (e) throw new HueError('HTTP_ERROR', e.description || ('Bridge error ' + e.type));
			return {};
		}
		if (data && data.error) {
			throw new HueError('HTTP_ERROR', data.error.description || 'Bridge error');
		}
		return data || {};
	}

	// --- List endpoints -----------------------------------------------------

	function getLights(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/lights')).then(function (data) { data = asKeyedList(data);
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
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/groups')).then(function (data) { data = asKeyedList(data);
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
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/scenes')).then(function (data) { data = asKeyedList(data);
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

	// Bridge configuration. The bridge exposes its own clock via the config
	// object: `UTC` (current UTC time) and `localtime` (in the bridge's timezone).
	// We surface a minimal normalized slice plus the model/API versions so the UI
	// can show the server time and flag time-sync drift without full config access.
	function getConfig(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/config')).then(function (data) {
			return {
				localtime: data.localtime != null ? data.localtime : null,
				utc: data.UTC != null ? data.UTC : null,
				timezone: data.timezone != null ? data.timezone : null,
				modelid: data.modelid != null ? data.modelid : null,
				apiversion: data.apiversion != null ? data.apiversion : null
			};
		});
	}

	// Automations / schedules / rules are the bridge's automatic ("routines")
	// mechanisms. Schedules and rules always use status enabled/disabled. The
	// newer /automations endpoint may report a different "on" string on some
	// firmware (e.g. "active"), so we record the observed non-disabled string as
	// `onStatus` and let the caller toggle to that value rather than hardcoding it.
	function getSchedules(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/schedules')).then(function (data) { data = asKeyedList(data);
			var out = [];
			Object.keys(data).forEach(function (id) {
				var s = data[id];
				if (!s) return;
				out.push({
					id: id,
					name: s.name != null ? s.name : '',
					localtime: s.localtime != null ? s.localtime : null,
					status: s.status != null ? s.status : 'disabled',
					onStatus: 'enabled',
					description: s.description != null ? s.description : '',
					created: s.created != null ? s.created : null,
					command: s.command || null
				});
			});
			return out;
		});
	}

	function getRules(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/rules')).then(function (data) { data = asKeyedList(data);
			var out = [];
			Object.keys(data).forEach(function (id) {
				var r = data[id];
				if (!r) return;
				out.push({
					id: id,
					name: r.name != null ? r.name : '',
					status: r.status != null ? r.status : 'disabled',
					onStatus: 'enabled',
					conditions: (r.conditions || []).slice(),
					actions: (r.actions || []).slice(),
					lasttriggered: r.lasttriggered != null ? r.lasttriggered : null
				});
			});
			return out;
		});
	}

	function getAutomations(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/automations')).then(function (data) { data = asKeyedList(data);
			var out = [];
			Object.keys(data).forEach(function (id) {
				var a = data[id];
				if (!a) return;
				var status = a.status != null ? a.status : 'disabled';
				out.push({
					id: id,
					name: a.name != null ? a.name : '',
					type: a.type != null ? a.type : null,
					status: status,
					onStatus: status === 'disabled' ? 'enabled' : status,
					starttime: a.starttime != null ? a.starttime : null,
					description: a.description != null ? a.description : '',
					template: a.template != null ? a.template : null,
					args: a.args != null ? a.args : null,
					lasttriggered: a.lasttriggered != null ? a.lasttriggered : null,
					raw: a
				});
			});
			return out;
		});
	}

	// Sensors back rule conditions and some automation args (e.g. motion). We keep
	// just enough (id + name + type) to render human-readable summaries.
	function getSensors(acc) {
		return request(makeUrl(acc.ip, '/api/' + acc.token + '/sensors')).then(function (data) { data = asKeyedList(data);
			var out = [];
			Object.keys(data).forEach(function (id) {
				var s = data[id];
				if (!s) return;
				out.push({
					id: id,
					name: s.name != null ? s.name : '',
					type: s.type != null ? s.type : null,
					modelid: s.modelid != null ? s.modelid : null
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

	// Generic enable/disable for schedules, rules, and automations (all accept a
	// `status` field via PUT on the resource's own endpoint). `resource` is the
	// plural endpoint name, e.g. 'schedules' | 'rules' | 'automations'.
	function setResourceStatus(acc, resource, id, status) {
		return put(acc, '/' + resource + '/' + encodeURIComponent(id), { status: status });
	}

	function updateSchedule(acc, id, body) {
		return put(acc, '/schedules/' + encodeURIComponent(id), body);
	}

	function updateAutomation(acc, id, body) {
		return put(acc, '/automations/' + encodeURIComponent(id), body);
	}

	// --- CLIP v2 (native Hue-app automations) -------------------------------
	//
	// Routines created in the official Hue app (Wake up / Go to sleep / Natural
	// light / scheduled scenes / Hue Labs) are stored as `behavior_instance`
	// resources and are only reachable through the v2 API. v2 differs from v1:
	//   - officially documented as TLS-only, but bridges that still have HTTP
	//     enabled (RED deprecation pending) also serve /clip/v2 on port 80, so
	//     we use the same scheme as v1 (makeUrl) — http wherever it's allowed
	//   - auth via the `hue-application-key` header (the v1 token works)
	//   - JSON envelope: { data: [...], errors: [...] }

	function requestV2(acc, path, opts) {
		opts = opts || {};
		var timeoutMs = opts.timeoutMs || 3000;
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
		var fetchOpts = {
			method: opts.method || 'GET',
			headers: { 'hue-application-key': acc.token, 'Content-Type': 'application/json' },
			signal: controller.signal
		};
		if (opts.body != null) fetchOpts.body = JSON.stringify(opts.body);

		return fetch(makeUrl(acc.ip, path), fetchOpts)
			.then(function (resp) {
				clearTimeout(timer);
				return resp.text().then(function (text) {
					var data;
					try { data = text ? JSON.parse(text) : null; }
					catch (e) { throw new HueError('BAD_RESPONSE', 'Bridge returned non-JSON: ' + text.slice(0, 80)); }
					if (!resp.ok) {
						throw new HueError('HTTP_ERROR', 'HTTP ' + resp.status);
					}
					if (data && Array.isArray(data.errors) && data.errors.length) {
						throw new HueError('HTTP_ERROR', data.errors[0].description || 'Bridge error');
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

	// Normalize a behavior_instance list, from either a live v2 response envelope
	// ({ data: [...] }) or a bare array pasted from curl.
	function normalizeBehaviorInstances(data) {
		var list = Array.isArray(data) ? data : (data && data.data) || [];
		return list.filter(function (b) { return b && b.id; }).map(function (b) {
			return {
				id: b.id,
				scriptId: b.script_id || null,
				name: b.name != null ? b.name : (b.metadata && b.metadata.name != null ? b.metadata.name : null),
				enabled: !!b.enabled,
				status: b.status != null ? b.status : null,
				configuration: b.configuration != null ? b.configuration : null,
				raw: b
			};
		});
	}

	function getBehaviorInstances(acc) {
		return requestV2(acc, '/clip/v2/resource/behavior_instance').then(normalizeBehaviorInstances);
	}

	function getBehaviorScripts(acc) {
		return requestV2(acc, '/clip/v2/resource/behavior_script').then(function (data) {
			return (data && data.data || []).map(function (s) {
				return {
					id: s.id,
					name: s.metadata && s.metadata.name != null ? s.metadata.name : null,
					description: s.metadata && s.metadata.description != null ? s.metadata.description : null
				};
			});
		});
	}

	// Resolve v2 rids (rooms/zones/scenes referenced inside behavior configs) to
	// names. Best-effort: any kind that fails simply contributes nothing.
	function getV2ResourceNames(acc) {
		return Promise.all(['room', 'zone', 'scene'].map(function (kind) {
			return requestV2(acc, '/clip/v2/resource/' + kind)
				.then(function (d) { return (d && d.data) || []; })
				.catch(function () { return []; });
		})).then(function (lists) {
			var map = {};
			lists.forEach(function (list) {
				list.forEach(function (r) {
					var nm = r.metadata && r.metadata.name;
					if (r.id && nm) map[r.id] = nm;
				});
			});
			return map;
		});
	}

	function setBehaviorInstanceEnabled(acc, id, enabled) {
		return requestV2(acc, '/clip/v2/resource/behavior_instance/' + encodeURIComponent(id), {
			method: 'PUT',
			body: { enabled: !!enabled }
		});
	}

	global.HueApi = {
		testBridge:       testBridge,
		pair:             pair,
		verify:           verify,
		getConfig:        getConfig,
		getLights:        getLights,
		getGroups:        getGroups,
		getScenes:        getScenes,
		getSchedules:     getSchedules,
		getRules:         getRules,
		getAutomations:   getAutomations,
		getSensors:       getSensors,
		getBehaviorInstances: getBehaviorInstances,
		getBehaviorScripts:   getBehaviorScripts,
		getV2ResourceNames:   getV2ResourceNames,
		setBehaviorInstanceEnabled: setBehaviorInstanceEnabled,
		normalizeBehaviorInstances: normalizeBehaviorInstances,
		setLight:         setLight,
		setGroup:         setGroup,
		activateScene:    activateScene,
		setResourceStatus: setResourceStatus,
		updateSchedule:   updateSchedule,
		updateAutomation: updateAutomation,
		HueError:         HueError,
		scheme:           scheme
	};
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
