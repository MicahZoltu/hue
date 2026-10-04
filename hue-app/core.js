/*
 * HueCore - shared state, persistence, and mutations for the unified Hue controller. Renders nothing; no DOM access.
 * The single UI (app.js) subscribes to events and re-renders on 'state'.
 *
 * Public surface (window.HueCore):
 *   getState(), getGroups(), getLights(), getScenes(),
 *   getSelectedRoomId(), setSelectedRoomId(id),
 *   tryRestoreSession(), importCreds(json), connectAndPair(ip, onTick?),
 *   testBridge(ip), disconnect(),
 *   toggleLight(id, wantOn), setLightBri(id, bri),
 *   toggleGroup(id, wantOn), setGroupBri(id, bri),
 *   activateScene(groupId, sceneId),
 *   clearCertError(),
 *   on(event, callback)
 *
 * Events: 'state' | 'connected' | 'disconnected' | 'error' | 'cert-error'.
 *
 * Cert error model: when the bridge is reached over HTTPS (page origin is itself a secure context — https:, chrome-extension:, etc.) and any bridge fetch fails with a network-class error (NETWORK / TIMEOUT / BRIDGE_OFFLINE), the most likely cause is an untrusted self-signed cert. We set state.certError and emit 'cert-error'.
 * The renderer (mobile only for now) shows a tailored view with retry + open-bridge buttons.
 * After the user accepts the cert in the address bar (or installs the CA on the device), they tap Retry; on success the cert error clears and normal flow resumes.
 */

(function (global) {
	'use strict';

	var STORAGE_CREDS = 'hue.creds';
	var STORAGE_ROOM  = 'hue.selectedRoomId';
	var STORAGE_V2_MANUAL = 'hue.v2manual';

	// True when the bridge is being reached over HTTPS. The bridge ships with a
	// self-signed cert, so an HTTPS page can't talk to it until the user trusts
	// the cert; any fetch-class failure in that situation is treated as a cert
	// problem. On every other page origin (http, file, ipfs, ipns, data, blob,
	// about, capacitor, cordova, ionic, tauri, android-app, content, ...) the
	// bridge is reached over plain HTTP and a fetch failure is a plain network
	// error, not a cert issue.
	//
	// The scheme is decided once at IIFE init in hue.js (HueApi.scheme) so every
	// bridge URL is built consistently.
	var bridgeSecure = (typeof HueApi !== 'undefined' && HueApi.scheme === 'https:');

	var state = {
		creds: null,             // { ip, token } | null
		groups: [],
		lights: [],
		scenes: [],
		selectedRoomId: null,
		certError: null,         // { ip, timestamp } | null
		bridge: { localtime: null, utc: null, timezone: null, fetchedAt: null, error: false },
		schedules: [],
		rules: [],
		automations: [],
		sensors: [],
		automationsSupported: true,
		behaviorInstances: [],
		behaviorScripts: [],
		v2Names: {},
		v2Status: 'unknown'      // 'ok' | 'cert' | 'unavailable' | 'unknown'
	};

	var listeners = { state: [], connected: [], disconnected: [], error: [], 'cert-error': [] };

	function emit(event, payload) {
		var list = listeners[event] || [];
		for (var i = 0; i < list.length; i++) {
			try { list[i](payload); }
			catch (e) {
				if (typeof console !== 'undefined' && console.error) console.error('HueCore listener error:', e);
			}
		}
	}

	function on(event, callback) {
		if (!listeners[event]) throw new Error('Unknown event: ' + event);
		listeners[event].push(callback);
		return function off() {
			var arr = listeners[event];
			var idx = arr.indexOf(callback);
			if (idx >= 0) arr.splice(idx, 1);
		};
	}

	// --- cert error helpers -------------------------------------------------

	function setCertError(ip) {
		state.certError = { ip: ip || (state.creds && state.creds.ip) || null, timestamp: Date.now() };
		emit('cert-error', state.certError);
	}

	function clearCertError() {
		if (state.certError) {
			state.certError = null;
			emit('state');
		}
	}

	// Heuristic: in HTTPS context, any fetch-class error against the bridge is treated as a cert problem.
	// Aggressive on purpose — false positives just leave the user on the cert view, where Retry will quickly tell them whether the real issue was a cert or a network.
	function maybeSetCertError(err, ip) {
		if (!bridgeSecure) return;
		if (!err) return;
		if (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.code === 'BRIDGE_OFFLINE') {
			setCertError(ip);
		}
	}

	// --- persistence -------------------------------------------------------

	function loadCredsFromStorage() {
		try {
			var raw = localStorage.getItem(STORAGE_CREDS);
			if (!raw) return null;
			var c = JSON.parse(raw);
			if (c && c.ip && c.token) return c;
		} catch (e) { /* ignore */ }
		return null;
	}
	function saveCredsToStorage(c) { localStorage.setItem(STORAGE_CREDS, JSON.stringify(c)); }
	function clearCredsFromStorage() { localStorage.removeItem(STORAGE_CREDS); }
	function loadRoomIdFromStorage() { return localStorage.getItem(STORAGE_ROOM); }
	function saveRoomIdToStorage(id) {
		if (id) localStorage.setItem(STORAGE_ROOM, id);
		else localStorage.removeItem(STORAGE_ROOM);
	}

	// Manual v2 import (pasted curl output). Keyed by bridge ip so data from a
	// different bridge is never shown.
	function loadManualV2FromStorage() {
		try {
			var raw = localStorage.getItem(STORAGE_V2_MANUAL);
			if (!raw) return null;
			var m = JSON.parse(raw);
			if (m && m.ip && Array.isArray(m.instances) && m.instances.length) return m;
		} catch (e) { /* ignore */ }
		return null;
	}
	function saveManualV2ToStorage(ip, instances) {
		localStorage.setItem(STORAGE_V2_MANUAL, JSON.stringify({ ip: ip, instances: instances }));
	}
	function clearManualV2FromStorage() { localStorage.removeItem(STORAGE_V2_MANUAL); }

	// --- state read/write --------------------------------------------------

	function getState() {
		return {
			creds: state.creds,
			groups: state.groups.slice(),
			lights: state.lights.slice(),
			scenes: state.scenes.slice(),
			selectedRoomId: state.selectedRoomId,
			certError: state.certError,
			bridge: Object.assign({}, state.bridge),
			schedules: state.schedules.slice(),
			rules: state.rules.slice(),
			automations: state.automations.slice(),
			sensors: state.sensors.slice(),
			automationsSupported: state.automationsSupported,
			behaviorInstances: state.behaviorInstances.slice(),
			behaviorScripts: state.behaviorScripts.slice(),
			v2Names: Object.assign({}, state.v2Names),
			v2Status: state.v2Status
		};
	}
	function getGroups()  { return state.groups.slice(); }
	function getLights()  { return state.lights.slice(); }
	function getScenes()  { return state.scenes.slice(); }
	function getSchedules() { return state.schedules.slice(); }
	function getRules()   { return state.rules.slice(); }
	function getAutomations() { return state.automations.slice(); }
	function getSensors() { return state.sensors.slice(); }
	function getBehaviorInstances() { return state.behaviorInstances.slice(); }
	function getBehaviorScripts() { return state.behaviorScripts.slice(); }
	function getBridgeTime() {
		if (!state.bridge) return null;
		return {
			localtime: state.bridge.localtime,
			utc: state.bridge.utc,
			timezone: state.bridge.timezone,
			fetchedAt: state.bridge.fetchedAt,
			error: state.bridge.error
		};
	}
	function getSelectedRoomId() { return state.selectedRoomId; }
	function setSelectedRoomId(id) {
		if (state.selectedRoomId === id) return;
		state.selectedRoomId = id;
		saveRoomIdToStorage(id);
		emit('state');
	}

	function setAll(creds, groups, lights, scenes) {
		state.creds = creds;
		state.groups = groups || [];
		state.lights = lights || [];
		state.scenes = scenes || [];
		if (state.groups.length && !state.groups.find(function (g) { return g.id === state.selectedRoomId; })) {
			state.selectedRoomId = state.groups[0].id;
			saveRoomIdToStorage(state.selectedRoomId);
		}
	}

	function findGroup(id) {
		return state.groups.find(function (g) { return g.id === id; });
	}
	function findLight(id) {
		return state.lights.find(function (l) { return l.id === id; });
	}

	function applyLightUpdate(id, patch) {
		var l = findLight(id);
		if (l) Object.assign(l.state || (l.state = {}), patch);
	}
	function applyGroupUpdate(id, patch) {
		var g = findGroup(id);
		if (g) {
			Object.assign(g.state || (g.state = {}), patch);
			Object.assign(g.action || (g.action = {}), patch);
		}
	}

	// --- loadAll -----------------------------------------------------------

	// Core (lights/groups/scenes) only. Used by the fast reconciliation path after a
	// mutation. Bridge time + automations are cheaper/slower and refreshed explicitly.
	function loadCore() {
		if (!state.creds) throw new HueApi.HueError('NO_CREDS', 'Not connected');
		return Promise.all([
			HueApi.getLights(state.creds),
			HueApi.getGroups(state.creds),
			HueApi.getScenes(state.creds)
		]).then(function (res) {
			// Preserve selectedRoomId if it still exists in the new data
			var prevRoom = state.selectedRoomId;
			state.lights = res[0];
			state.groups = res[1];
			state.scenes = res[2];
			if (state.groups.length) {
				var found = state.groups.find(function (g) { return g.id === prevRoom; });
				state.selectedRoomId = found ? found.id : state.groups[0].id;
				saveRoomIdToStorage(state.selectedRoomId);
			}
		});
	}

	// Bridge clock + automations/schedules/rules. Failures here never break the rest
	// of the load; they just leave that slice empty/unchanged.
	function refreshBridgeTime() {
		if (!state.creds) return Promise.resolve();
		return HueApi.getConfig(state.creds).then(function (cfg) {
			state.bridge = {
				localtime: cfg.localtime,
				utc: cfg.utc,
				timezone: cfg.timezone,
				fetchedAt: Date.now(),
				error: false
			};
		}).catch(function () {
			state.bridge.error = true;
		});
	}

	function refreshAutomations() {
		if (!state.creds) return Promise.resolve();
		return HueApi.getSchedules(state.creds)
			.then(function (s) { state.schedules = s; })
			.catch(function () { state.schedules = []; })
			.then(function () {
				return HueApi.getRules(state.creds)
					.then(function (r) { state.rules = r; })
					.catch(function () { state.rules = []; });
			})
			.then(function () {
				return HueApi.getAutomations(state.creds)
					.then(function (a) { state.automations = a; state.automationsSupported = true; })
					.catch(function () { state.automations = []; state.automationsSupported = false; });
			})
			.then(function () {
				return HueApi.getSensors(state.creds)
					.then(function (s) { state.sensors = s; })
					.catch(function () { state.sensors = []; });
			})
			.then(function () { return refreshBehaviors(); });
	}

	// Native Hue-app automations (CLIP v2 behavior instances). TLS-only endpoint
	// with a self-signed cert, so failures are expected in some setups — record
	// why instead of breaking the refresh. 'cert' means the browser blocked the
	// connection (untrusted cert or CORS preflight); 'unavailable' means the
	// bridge said no; 'manual' means we're showing a pasted curl import instead.
	function refreshBehaviors() {
		if (!state.creds) return Promise.resolve();
		return HueApi.getBehaviorInstances(state.creds)
			.then(function (b) {
				state.behaviorInstances = b;
				state.v2Status = 'ok';
				return HueApi.getBehaviorScripts(state.creds)
					.then(function (s) { state.behaviorScripts = s; })
					.catch(function () { state.behaviorScripts = []; });
			})
			.then(function () {
				return HueApi.getV2ResourceNames(state.creds)
					.then(function (n) { state.v2Names = n; })
					.catch(function () { state.v2Names = {}; });
			})
			.catch(function (err) {
				state.behaviorScripts = [];
				state.v2Names = {};
				var manual = loadManualV2FromStorage();
				if (manual && state.creds && manual.ip === state.creds.ip) {
					state.behaviorInstances = manual.instances;
					state.v2Status = 'manual';
					return;
				}
				state.behaviorInstances = [];
				state.v2Status = (err && err.code === 'NETWORK') ? 'cert' : 'unavailable';
			});
	}

	// Import behavior instances from pasted curl output (accepts the {data:[...]}
	// envelope or a bare array). Browser access to v2 is blocked on some bridges
	// (HTTPS-only + CORS 405), so this is the fallback path for viewing them.
	function importV2Behaviors(json) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		var parsed;
		try { parsed = typeof json === 'string' ? JSON.parse(json) : json; }
		catch (e) { return Promise.reject(new HueApi.HueError('BAD_JSON', 'Invalid JSON')); }
		var instances = HueApi.normalizeBehaviorInstances(parsed);
		if (!instances.length) {
			return Promise.reject(new HueApi.HueError('EMPTY', 'No behavior instances found in that JSON'));
		}
		saveManualV2ToStorage(state.creds.ip, instances);
		state.behaviorInstances = instances;
		state.behaviorScripts = [];
		state.v2Names = {};
		state.v2Status = 'manual';
		emit('state');
		return Promise.resolve(instances.length);
	}

	function clearV2Import() {
		clearManualV2FromStorage();
		state.behaviorInstances = [];
		state.v2Status = 'unknown';
		return refreshBehaviors().then(function () { emit('state'); });
	}

	var bridgeTimer = null;
	function scheduleBridgeTimeRefresh() {
		if (bridgeTimer != null) clearInterval(bridgeTimer);
		bridgeTimer = setInterval(function () {
			refreshBridgeTime().then(function () { emit('state'); });
		}, 60 * 60 * 1000);
	}

	function loadAll() {
		return loadCore().then(function () {
			return Promise.all([refreshBridgeTime(), refreshAutomations()]);
		}).then(function () {
			scheduleBridgeTimeRefresh();
			emit('state');
			return { groups: state.groups, lights: state.lights, scenes: state.scenes, schedules: state.schedules, rules: state.rules, automations: state.automations };
		});
	}

	// --- lifecycle ---------------------------------------------------------

	function tryRestoreSession() {
		var creds = loadCredsFromStorage();
		if (!creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'No saved credentials'));
		state.creds = creds;
		state.selectedRoomId = loadRoomIdFromStorage();
		return HueApi.verify(creds).then(function () {
			return loadAll();
		}).then(function (data) {
			emit('connected', data);
			return data;
		}).catch(function (err) {
			maybeSetCertError(err, creds.ip);
			throw err;
		});
	}

	function importCreds(json) {
		var c;
		try { c = typeof json === 'string' ? JSON.parse(json) : json; }
		catch (e) { return Promise.reject(new HueApi.HueError('BAD_JSON', 'Invalid JSON')); }
		if (!c || !c.ip || !c.token) {
			return Promise.reject(new HueApi.HueError('BAD_CREDS', 'JSON must include ip and token'));
		}
		state.creds = { ip: String(c.ip), token: String(c.token) };
		state.selectedRoomId = loadRoomIdFromStorage();
		saveCredsToStorage(state.creds);
		return HueApi.verify(state.creds).then(function () {
			return loadAll();
		}).then(function (data) {
			emit('connected', data);
			return data;
		}).catch(function (err) {
			maybeSetCertError(err, state.creds.ip);
			throw err;
		});
	}

	function connectAndPair(ip, onTick) {
		return HueApi.testBridge(ip).then(function () {
			state.creds = { ip: ip, token: null };
			return HueApi.pair(ip, { onTick: onTick || function () {} });
		}).then(function (token) {
			state.creds.token = token;
			saveCredsToStorage(state.creds);
			return loadAll();
		}).then(function (data) {
			emit('connected', data);
			return data;
		}).catch(function (err) {
			maybeSetCertError(err, ip);
			throw err;
		});
	}

	// Standalone bridge reachability check. Used by the Retry button on the cert-error view to test whether the cert is now trusted without committing to the full connectAndPair flow.
	function testBridge(ip) {
		return HueApi.testBridge(ip);
	}

	function disconnect() {
		if (bridgeTimer != null) { clearInterval(bridgeTimer); bridgeTimer = null; }
		state.creds = null;
		state.groups = [];
		state.lights = [];
		state.scenes = [];
			state.selectedRoomId = null;
			state.schedules = [];
			state.rules = [];
			state.automations = [];
			state.sensors = [];
			state.behaviorInstances = [];
			state.behaviorScripts = [];
			state.v2Names = {};
			state.v2Status = 'unknown';
		state.bridge = { localtime: null, utc: null, timezone: null, fetchedAt: null, error: false };
		clearCredsFromStorage();
		localStorage.removeItem(STORAGE_ROOM);
		emit('disconnected');
	}

	// --- mutations ---------------------------------------------------------

	function refreshAll() {
		return loadAll();
	}

	function reconcile(delay) {
		setTimeout(function () {
			loadCore().then(function () { emit('state'); }).catch(function () {});
		}, delay != null ? delay : 400);
	}

	function toggleLight(lightId, wantOn) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		applyLightUpdate(lightId, { on: wantOn });
		emit('state');
		return HueApi.setLight(state.creds, lightId, { on: wantOn })
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	function setLightBri(lightId, bri) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		applyLightUpdate(lightId, { bri: bri, on: bri > 0 });
		emit('state');
		return HueApi.setLight(state.creds, lightId, { bri: bri, on: bri > 0 })
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	function toggleGroup(groupId, wantOn) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		applyGroupUpdate(groupId, { on: wantOn });
		emit('state');
		return HueApi.setGroup(state.creds, groupId, { on: wantOn })
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	function setGroupBri(groupId, bri) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		applyGroupUpdate(groupId, { bri: bri, on: bri > 0 });
		emit('state');
		return HueApi.setGroup(state.creds, groupId, { bri: bri, on: bri > 0 })
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	function activateScene(groupId, sceneId) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		return HueApi.activateScene(state.creds, groupId, sceneId)
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	// Enable/disable a schedule, rule, or automation. `resource` is the plural
	// endpoint name; `list` is the state slice holding that resource's items so we
	// can optimistically flip the status. The "on" status string comes from each
	// item's captured `onStatus` (the bridge may use "enabled" or "active"), and
	// "off" is always "disabled".
	function setResourceEnabled(resource, id, wantEnabled, list) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		var item = list.find(function (x) { return x.id === id; });
		var off = 'disabled';
		var on = (item && item.onStatus) || 'enabled';
		if (item) item.status = wantEnabled ? on : off;
		emit('state');
		return HueApi.setResourceStatus(state.creds, resource, id, wantEnabled ? on : off)
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	function setScheduleEnabled(id, wantEnabled) {
		return setResourceEnabled('schedules', id, wantEnabled, state.schedules);
	}
	function setRuleEnabled(id, wantEnabled) {
		return setResourceEnabled('rules', id, wantEnabled, state.rules);
	}
	function setAutomationEnabled(id, wantEnabled) {
		return setResourceEnabled('automations', id, wantEnabled, state.automations);
	}

	function updateSchedule(id, name, localtime) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		var item = state.schedules.find(function (x) { return x.id === id; });
		var body = {};
		if (name != null) body.name = String(name);
		if (localtime != null) body.localtime = String(localtime);
		if (!Object.keys(body).length) return Promise.reject(new HueApi.HueError('EMPTY', 'Nothing to change'));
		if (item) {
			if (name != null) item.name = String(name);
			if (localtime != null) item.localtime = String(localtime);
		}
		emit('state');
		return HueApi.updateSchedule(state.creds, id, body)
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	// Edit a schedule-type automation. The time field shape varies by automation
	// type, so we only send `starttime` when the fetched automation already has one
	// (caller skips it otherwise). Name is always editable.
	function updateAutomation(id, name, starttime) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		var item = state.automations.find(function (x) { return x.id === id; });
		var body = {};
		if (name != null) body.name = String(name);
		if (starttime != null && item && item.starttime != null) body.starttime = String(starttime);
		if (!Object.keys(body).length) return Promise.reject(new HueApi.HueError('EMPTY', 'Nothing to change'));
		if (item) {
			if (name != null) item.name = String(name);
			if (starttime != null && item.starttime != null) item.starttime = String(starttime);
		}
		emit('state');
		return HueApi.updateAutomation(state.creds, id, body)
			.then(reconcile)
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				reconcile();
				throw err;
			});
	}

	// Toggle a native (v2) behavior instance. Refetches the list afterwards since
	// reconcile() only covers v1 core resources.
	function setBehaviorInstanceEnabled(id, enabled) {
		if (!state.creds) return Promise.reject(new HueApi.HueError('NO_CREDS', 'Not connected'));
		var item = state.behaviorInstances.find(function (x) { return x.id === id; });
		if (item) item.enabled = !!enabled;
		emit('state');
		return HueApi.setBehaviorInstanceEnabled(state.creds, id, enabled)
			.then(function () { return refreshBehaviors(); })
			.then(function () { emit('state'); })
			.catch(function (err) {
				emit('error', { code: err.code || 'ERROR', message: err.message, source: 'mutation' });
				maybeSetCertError(err, state.creds.ip);
				throw err;
			});
	}

	global.HueCore = {
		// state
		getState: getState,
		getGroups: getGroups,
		getLights: getLights,
		getScenes: getScenes,
		getSchedules: getSchedules,
		getRules: getRules,
		getAutomations: getAutomations,
		getSensors: getSensors,
		getBehaviorInstances: getBehaviorInstances,
		getBehaviorScripts: getBehaviorScripts,
		getBridgeTime: getBridgeTime,
		getSelectedRoomId: getSelectedRoomId,
		setSelectedRoomId: setSelectedRoomId,
		// lifecycle
		tryRestoreSession: tryRestoreSession,
		importCreds: importCreds,
		connectAndPair: connectAndPair,
		testBridge: testBridge,
		disconnect: disconnect,
		// mutations
		toggleLight: toggleLight,
		setLightBri: setLightBri,
		toggleGroup: toggleGroup,
		setGroupBri: setGroupBri,
		activateScene: activateScene,
		setScheduleEnabled: setScheduleEnabled,
		setRuleEnabled: setRuleEnabled,
		setAutomationEnabled: setAutomationEnabled,
		updateSchedule: updateSchedule,
		updateAutomation: updateAutomation,
		setBehaviorInstanceEnabled: setBehaviorInstanceEnabled,
		importV2Behaviors: importV2Behaviors,
		clearV2Import: clearV2Import,
		refreshAll: refreshAll,
		// cert error
		clearCertError: clearCertError,
		// events
		on: on
	};
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
