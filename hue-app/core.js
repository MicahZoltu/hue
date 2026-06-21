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
		certError: null          // { ip, timestamp } | null
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

	// --- state read/write --------------------------------------------------

	function getState() {
		return {
			creds: state.creds,
			groups: state.groups.slice(),
			lights: state.lights.slice(),
			scenes: state.scenes.slice(),
			selectedRoomId: state.selectedRoomId,
			certError: state.certError
		};
	}
	function getGroups()  { return state.groups.slice(); }
	function getLights()  { return state.lights.slice(); }
	function getScenes()  { return state.scenes.slice(); }
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

	function loadAll() {
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
			emit('state');
			return { groups: state.groups, lights: state.lights, scenes: state.scenes };
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
		state.creds = null;
		state.groups = [];
		state.lights = [];
		state.scenes = [];
		state.selectedRoomId = null;
		clearCredsFromStorage();
		localStorage.removeItem(STORAGE_ROOM);
		emit('disconnected');
	}

	// --- mutations ---------------------------------------------------------

	function refreshAll() {
		return loadAll();
	}

	function reconcile(delay) {
		setTimeout(function () { loadAll().catch(function () {}); }, delay != null ? delay : 400);
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

	global.HueCore = {
		// state
		getState: getState,
		getGroups: getGroups,
		getLights: getLights,
		getScenes: getScenes,
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
		refreshAll: refreshAll,
		// cert error
		clearCertError: clearCertError,
		// events
		on: on
	};
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
