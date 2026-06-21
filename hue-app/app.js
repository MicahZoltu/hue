/*
 * Hue Controller - unified UI.
 *
 * One renderer for both mobile (view-based navigation with History API)
 * and desktop (sidebar + panel dashboard). The active layout is detected
 * from the viewport on every render and whenever the window resizes
 * across the 900px breakpoint.
 *
 * Layouts:
 *   mobile  - sequential views (connect | groups | group | error | cert-error)
 *             with history-based back navigation.
 *   desktop - single dashboard: rooms sidebar + panel for selected room.
 *             Selecting a room does not change the view; it's a state update.
 *
 * Features in both layouts:
 *   - per-light brightness slider
 *   - per-room/group brightness slider + on/off toggle
 *   - expandable color picker (H/S/B for color lights, CT for CT lights)
 *   - scene activation
 *   - export credentials modal
 *   - cert-error view (HTTPS + self-signed bridge cert)
 *
 * State model (renderer-only):
 *   { expanded: { lightId: true } }   // which lights have color picker open
 *
 * All state, persistence, and protocol logic lives in core.js / hue.js / color.js.
 * HueCore handles optimistic updates and 400ms reconcile-after-mutation for us.
 */

(function () {
	'use strict';

	var rendererState = { expanded: {} };
	var view = 'connect';
	var errorMessage = null;
	var lastAttemptedIp = null;
	var menuOpen = false;

	// --- DOM helpers -------------------------------------------------------

	function $(id) { return document.getElementById(id); }

	function el(tag, attrs, children) {
		var n = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				var v = attrs[k];
				if (v == null || v === false) return;
				if (k === 'class') n.className = v;
				else if (k === 'text') n.textContent = v;
				else if (k === 'style') n.setAttribute('style', v);
				else if (k.indexOf('on') === 0 && typeof v === 'function') {
					n.addEventListener(k.slice(2).toLowerCase(), v);
				} else if (v === true) {
					n.setAttribute(k, '');
				} else {
					n.setAttribute(k, String(v));
				}
			});
		}
		if (children) {
			(Array.isArray(children) ? children : [children]).forEach(function (c) {
				if (c == null) return;
				n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
			});
		}
		return n;
	}

	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

	function debounceEvent(fn, ms) {
		var t = null;
		return function (e) {
			var self = this, args = arguments;
			clearTimeout(t);
			t = setTimeout(function () { fn.apply(self, args); }, ms);
		};
	}

	// --- Layout detection --------------------------------------------------

	function isDesktop() { return window.matchMedia('(min-width: 900px)').matches; }

	// --- Toast ------------------------------------------------------------

	var toastTimer = null;
	function toast(msg, type) {
		var t = $('toast');
		if (!t) return;
		t.textContent = msg;
		t.className = type || 'info';
		t.style.display = 'block';
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { t.style.display = 'none'; }, 4500);
	}

	// --- Navigation (History API) ------------------------------------------

	function goToView(name, extra) {
		if (name === view) {
			if (name === 'group' && extra && extra.groupId &&
					HueCore.getSelectedRoomId() !== extra.groupId) {
				// fall through to push
			} else {
				return;
			}
		}
		view = name;
		if (name === 'group' && extra && extra.groupId) {
			HueCore.setSelectedRoomId(extra.groupId);
		}
		try { history.pushState(Object.assign({ view: name }, extra || {}), ''); }
		catch (e) { /* history API unavailable; in-app back still works */ }
		render();
	}

	function goBack() {
		try { history.back(); }
		catch (e) {
			view = 'groups';
			render();
		}
	}

	// --- Connect flow ------------------------------------------------------

	function setConnectStatus(msg) {
		var s = $('connect-status');
		if (s) s.textContent = msg || '';
	}

	function handleConnect() {
		var ipInput = $('ip-input');
		var ip = ipInput ? ipInput.value.trim() : '';
		if (!ip) { setConnectStatus('Enter the bridge IP address.'); return; }
		var btn = $('connect-btn');
		if (btn) btn.disabled = true;
		setConnectStatus('Testing ' + ip + '\u2026');
		lastAttemptedIp = ip;
		HueCore.connectAndPair(ip, function (attempt, max) {
			var remaining = Math.max(0, Math.ceil((max - attempt) * 1.5));
			setConnectStatus('Waiting for link button press\u2026 ' + remaining + 's left');
		}).then(function () {
			errorMessage = null;
			view = 'groups';
			try { history.replaceState({ view: 'groups' }, ''); } catch (e) {}
			render();
		}).catch(function (err) {
			setConnectStatus(err.message || 'Could not reach the bridge.');
			if (btn) btn.disabled = false;
		});
	}

	function handleImport() {
		var rawEl = $('import-input');
		var raw = rawEl ? rawEl.value.trim() : '';
		if (!raw) { setConnectStatus('Paste credentials JSON first.'); return; }
		HueCore.importCreds(raw).then(function () {
			errorMessage = null;
			view = 'groups';
			try { history.replaceState({ view: 'groups' }, ''); } catch (e) {}
			render();
		}).catch(function (err) {
			setConnectStatus(err.message || 'Credentials did not work.');
		});
	}

	function handleRefresh() {
		if (!HueCore.getState().creds) return;
		HueCore.refreshAll().catch(function (err) { toast(err.message || 'Refresh failed', 'error'); });
	}

	// --- Color helpers for swatches ---------------------------------------

	function swatchForLight(light) {
		var s = light.state || {};
		if (s.xy) return HueColor.xyBriToRgb(s.xy[0], s.xy[1], s.bri != null ? s.bri : 254);
		if (s.ct) return HueColor.miredToRgb(s.ct);
		if (s.on) return '255,233,191';
		return '50,50,50';
	}

	function lightsInGroup(g, lights) {
		return lights.filter(function (l) { return g.lights.indexOf(String(l.id)) >= 0; });
	}

	function renderSwatchStrip(lights) {
		if (!lights.length) return null;
		var strip = el('div', { class: 'swatch-strip' });
		lights.slice(0, 4).forEach(function (l) {
			strip.appendChild(el('div', { style: 'background: rgb(' + swatchForLight(l) + ');' }));
		});
		return strip;
	}

	// --- Menu --------------------------------------------------------------

	function toggleMenu() {
		menuOpen = !menuOpen;
		var m = $('menu');
		if (m) m.classList.toggle('open', menuOpen);
	}
	function closeMenu() {
		menuOpen = false;
		var m = $('menu');
		if (m) m.classList.remove('open');
	}

	// --- Mutations through HueCore ----------------------------------------

	function pushLightColor(lightId, b) {
		HueApi.setLight(HueCore.getState().creds, lightId, {
			on: true, hue: b.hue, sat: b.sat, bri: b.bri, transitiontime: 4
		}).catch(function (err) { toast(err.message || 'Color change failed', 'error'); });
	}
	function pushLightCT(lightId, mired) {
		HueApi.setLight(HueCore.getState().creds, lightId, {
			on: true, ct: mired, transitiontime: 4
		}).catch(function (err) { toast(err.message || 'Color temp change failed', 'error'); });
	}

	// --- Modal -------------------------------------------------------------

	function showModal(opts) {
		var backdrop = el('div', {
			class: 'modal-backdrop',
			onclick: function (e) { if (e.target === backdrop) document.body.removeChild(backdrop); }
		});
		var m = el('div', { class: 'modal' }, [
			el('h3', { text: opts.title }),
			opts.body ? el('p', { text: opts.body }) : null
		]);
		if (!opts.hideTextarea) {
			var ta = el('textarea', { readonly: true });
			ta.value = opts.text || '';
			m.appendChild(ta);
		}
		var actions = el('div', { class: 'actions' });
		opts.actions.forEach(function (a) {
			actions.appendChild(el('button', {
				class: (a.primary ? 'primary' : '') + (a.danger ? 'danger' : ''),
				text: a.label,
				onclick: function () { a.onclick(m); }
			}));
		});
		m.appendChild(actions);
		backdrop.appendChild(m);
		document.body.appendChild(backdrop);
	}
	function closeModal(modal) {
		var bd = modal.parentNode;
		if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
	}
	function copyToClipboard(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text);
			return;
		}
		var ta = document.createElement('textarea');
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); } catch (e) { /* ignore */ }
		document.body.removeChild(ta);
	}

	function openExport() {
		closeMenu();
		showModal({
			title: 'Export credentials',
			body: 'Copy this JSON to use the same bridge connection from another browser or device.',
			text: JSON.stringify(HueCore.getState().creds, null, 2),
			actions: [
				{ label: 'Copy', primary: true, onclick: function (m) {
					copyToClipboard(m.querySelector('textarea').value);
					toast('Copied.', 'info');
				} },
				{ label: 'Close', onclick: function (m) { closeModal(m); } }
			]
		});
	}

	// --- Header rendering --------------------------------------------------

	function renderRefreshButton() {
		var refresh = el('button', { id: 'refresh-btn', title: 'Refresh' });
		refresh.textContent = isDesktop() ? 'Refresh' : '\u21BB';
		refresh.addEventListener('click', handleRefresh);
		return refresh;
	}

	function renderMenuButton() {
		var wrap = el('div', { id: 'menu-wrap' });
		var btn = el('button', { id: 'menu-btn', class: 'ghost', title: 'Menu' });
		btn.innerHTML = '&#8943;';
		btn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
		var menu = el('div', { id: 'menu' });
		var exportBtn = el('button', { text: 'Export credentials' });
		exportBtn.addEventListener('click', openExport);
		menu.appendChild(exportBtn);
		wrap.appendChild(btn);
		wrap.appendChild(menu);
		return wrap;
	}

	function renderHeader(opts) {
		opts = opts || {};
		var header = el('header', { id: 'header' });

		if (opts.showBack) {
			var back = el('button', { id: 'back-btn-header', type: 'button' });
			back.innerHTML = '<span class="chev">&#x2039;</span>';
			back.addEventListener('click', goBack);
			header.appendChild(back);
		}

		header.appendChild(el('h1', { text: opts.title || 'Hue' }));

		if (opts.showIp) {
			var ip = HueCore.getState().creds && HueCore.getState().creds.ip;
			if (ip) header.appendChild(el('span', { class: 'ip', text: ip }));
		}

		header.appendChild(el('span', { class: 'spacer' }));
		header.appendChild(renderRefreshButton());

		if (opts.showMenu) {
			header.appendChild(renderMenuButton());
		}

		return header;
	}

	// --- Render: connect screen -------------------------------------------

	function renderConnect() {
		view = 'connect';
		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({ title: 'Hue' }));

		var main = el('main');
		var section = el('section', { id: 'connect-view' });
		var card = el('div', { class: 'connect-card' });

		card.appendChild(el('h2', { text: 'Connect to your Hue Bridge' }));
		card.appendChild(el('p', { text: 'Enter the IP address of your Philips Hue Bridge. You can find it in the Hue mobile app under Settings \u2192 Hue Bridges, or in your router\u2019s DHCP table (Philips MACs start with 00:17:88).' }));
		card.appendChild(el('p', { text: 'After clicking Connect, press the round link button on the bridge within 30 seconds. The app will pick up the new username automatically.' }));

		var ipInput = el('input', { id: 'ip-input', type: 'text', placeholder: '192.168.1.42', spellcheck: 'false', autocomplete: 'off' });
		if (lastAttemptedIp) ipInput.value = lastAttemptedIp;
		card.appendChild(ipInput);

		var connectBtn = el('button', { id: 'connect-btn', class: 'primary', text: 'Connect & pair' });
		connectBtn.addEventListener('click', handleConnect);
		card.appendChild(el('div', { class: 'row' }, [connectBtn]));

		var status = el('div', { id: 'connect-status', class: 'status' });
		card.appendChild(status);

		var details = el('details');
		details.appendChild(el('summary', { text: 'Have existing credentials? Import them' }));
		details.appendChild(el('p', { text: 'Paste the JSON below (from this app\u2019s Export credentials option).' }));
		var importInput = el('textarea', { id: 'import-input', placeholder: '{"ip":"192.168.1.42","token":"..."}', spellcheck: 'false' });
		details.appendChild(importInput);
		var importBtn = el('button', { id: 'import-btn', text: 'Import & connect' });
		importBtn.addEventListener('click', handleImport);
		details.appendChild(el('div', { class: 'row' }, [importBtn]));
		card.appendChild(details);

		section.appendChild(card);
		main.appendChild(section);
		app.appendChild(main);

		ipInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleConnect(); });
		ipInput.focus();
	}

	// --- Render: error view ------------------------------------------------

	function renderError(msg) {
		view = 'error';
		errorMessage = msg;
		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({ title: 'Hue' }));

		var main = el('main');
		var section = el('section', { id: 'error-view' });
		section.appendChild(el('div', { class: 'icon', text: '\u26A0' }));
		section.appendChild(el('h2', { text: 'Could not connect' }));
		section.appendChild(el('p', { text: msg || 'Something went wrong reaching the bridge.' }));
		section.appendChild(el('p', { style: 'margin-top:16px;', text: 'Clear your browser data to start over and re-pair.' }));
		main.appendChild(section);
		app.appendChild(main);
	}

	// --- Render: cert error view ------------------------------------------

	function renderCertError() {
		view = 'cert-error';
		var s = HueCore.getState();
		var ip = (s.certError && s.certError.ip) || (s.creds && s.creds.ip) || lastAttemptedIp || '';

		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({ title: 'Hue' }));

		var main = el('main');
		var section = el('section', { id: 'cert-view' });
		section.appendChild(el('div', { class: 'icon', text: '\u26A0' }));
		section.appendChild(el('h2', { text: 'Bridge certificate needed' }));
		section.appendChild(el('p', { text: 'The Hue Bridge uses a self-signed HTTPS certificate that this app doesn\u2019t recognize. The connection can\u2019t complete until the certificate is trusted.' }));

		if (ip) {
			var openBtn = el('button', { class: 'primary', text: 'Open bridge page' });
			openBtn.addEventListener('click', function () {
				window.open(HueApi.scheme + '//' + ip + '/', '_blank');
			});
			section.appendChild(openBtn);
			section.appendChild(el('p', { class: 'muted', style: 'margin-top:12px;', text: 'A new tab will open to the bridge. Your browser will show a "Your connection is not private" warning \u2014 click through it (Advanced \u2192 Proceed to ' + ip + '). Then come back here and tap Retry.' }));
		}

		section.appendChild(el('p', { style: 'margin-top:20px;', text: 'If Retry still fails, install the bridge\u2019s certificate on this device as a trusted CA:' }));
		var ol = el('ol');
		ol.appendChild(el('li', { text: 'Open the bridge page (button above) and accept the cert warning.' }));
		if (ip) {
			ol.appendChild(el('li', {}, [
				document.createTextNode('In that tab, go to '),
				el('span', { class: 'ip', text: HueApi.scheme + '//' + ip + '/certificate' }),
				document.createTextNode(' and save the file.')
			]));
		} else {
			ol.appendChild(el('li', { text: 'In that tab, navigate to the bridge\u2019s certificate endpoint and save the file.' }));
		}
		ol.appendChild(el('li', { text: 'On Android: Settings \u2192 Security \u2192 Encryption & credentials \u2192 Install a certificate \u2192 CA certificate. Pick the saved file.' }));
		ol.appendChild(el('li', { text: 'Come back here and tap Retry.' }));
		section.appendChild(ol);

		var retryBtn = el('button', { id: 'cert-retry-btn', text: 'Retry' });
		retryBtn.addEventListener('click', function () {
			if (!ip) { toast('No bridge IP available', 'error'); return; }
			retryBtn.disabled = true;
			retryBtn.textContent = 'Testing\u2026';
			HueCore.testBridge(ip).then(function () {
				HueCore.clearCertError();
				view = 'connect';
				render();
			}).catch(function (err) {
				retryBtn.disabled = false;
				retryBtn.textContent = 'Retry';
				toast(err.message || 'Still unreachable', 'error');
			});
		});
		section.appendChild(retryBtn);

		main.appendChild(section);
		app.appendChild(main);
	}

	// --- Render: desktop dashboard ----------------------------------------

	function renderRoomTile(g, lights) {
		var inGroup = lightsInGroup(g, lights);
		var anyOn = g.state && g.state.any_on;
		var selected = HueCore.getSelectedRoomId() === g.id;

		return el('div', {
			class: 'room-tile' + (selected ? ' selected' : ''),
			onclick: function () { HueCore.setSelectedRoomId(g.id); }
		}, [
			el('div', { class: 'row1' }, [
				el('span', { class: 'name', text: g.name }),
				el('span', { class: 'dot' + (anyOn ? ' on' : '') })
			]),
			renderSwatchStrip(inGroup)
		]);
	}

	function renderDesktopPanel(groups, lights, scenes, selectedRoomId) {
		var panel = el('section', { id: 'panel' });
		if (!selectedRoomId) {
			panel.appendChild(el('div', { id: 'empty', text: 'Select a room on the left.' }));
			return panel;
		}
		var g = groups.find(function (x) { return x.id === selectedRoomId; });
		if (!g) {
			panel.appendChild(el('div', { id: 'empty', text: 'Room not found.' }));
			return panel;
		}
		var inGroup = lightsInGroup(g, lights);
		var inGroupScenes = scenes.filter(function (s) { return s.group === g.id; });

		panel.appendChild(el('div', { id: 'panel-header' }, [
			el('h2', { text: g.name }),
			el('span', { class: 'meta', text: inGroup.length + ' lights' })
		]));

		// Scenes
		var scenesSection = el('div', { class: 'section' });
		scenesSection.appendChild(el('h3', { text: 'Scenes' }));
		if (inGroupScenes.length === 0) {
			scenesSection.appendChild(el('div', { class: 'empty', text: 'No scenes for this room.' }));
		} else {
			var scenesRow = el('div', { id: 'scenes-row' });
			inGroupScenes.forEach(function (s) {
				var pill = el('button', {
					class: 'scene-pill', type: 'button', text: s.name,
					onclick: function () { HueCore.activateScene(g.id, s.id); }
				});
				scenesRow.appendChild(pill);
			});
			scenesSection.appendChild(scenesRow);
		}
		panel.appendChild(scenesSection);

		// Group controls
		var anyOn = g.state && g.state.any_on;
		var bri = g.action && g.action.bri != null ? g.action.bri : 254;
		var ctrlSection = el('div', { class: 'section' });
		ctrlSection.appendChild(el('h3', { text: 'All lights' }));
		var ctrl = el('div', { id: 'group-controls' });
		var toggle = el('input', { type: 'checkbox', class: 'toggle', checked: !!anyOn });
		toggle.addEventListener('change', function () { HueCore.toggleGroup(g.id, toggle.checked); });
		ctrl.appendChild(toggle);
		var briInput = el('input', { type: 'range', min: 0, max: 254, value: bri });
		briInput.addEventListener('input', debounceEvent(function () {
			HueCore.setGroupBri(g.id, Number(briInput.value));
		}, 150));
		ctrl.appendChild(briInput);
		ctrlSection.appendChild(ctrl);
		panel.appendChild(ctrlSection);

		// Lights
		var lightsSection = el('div', { class: 'section' });
		lightsSection.appendChild(el('h3', { text: 'Lights' }));
		if (inGroup.length === 0) {
			lightsSection.appendChild(el('div', { id: 'empty', text: 'No lights in this room.' }));
		} else {
			var grid = el('div', { class: 'lights-grid' });
			inGroup.forEach(function (l) { grid.appendChild(renderLightCard(l)); });
			lightsSection.appendChild(grid);
		}
		panel.appendChild(lightsSection);

		return panel;
	}

	function renderDesktopDashboard() {
		var s = HueCore.getState();
		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({
			title: 'Hue Controller',
			showIp: true,
			showMenu: true
		}));

		var dashboard = el('div', { id: 'dashboard' });

		var rooms = el('aside', { id: 'rooms' }, [
			el('h2', { text: 'Rooms' })
		]);
		var roomsList = el('div', { id: 'rooms-list' });
		if (s.groups.length === 0) {
			roomsList.appendChild(el('div', { class: 'empty', text: 'No rooms. Create one in the Hue app first.' }));
		} else {
			s.groups.forEach(function (g) { roomsList.appendChild(renderRoomTile(g, s.lights)); });
		}
		rooms.appendChild(roomsList);
		dashboard.appendChild(rooms);

		dashboard.appendChild(renderDesktopPanel(s.groups, s.lights, s.scenes, s.selectedRoomId));

		app.appendChild(dashboard);
	}

	// --- Render: mobile groups list ---------------------------------------

	function renderGroupCard(g, lights) {
		var inGroup = lightsInGroup(g, lights);
		var anyOn = g.state && g.state.any_on;

		var card = el('button', { class: 'group-card', type: 'button' });
		card.addEventListener('click', function () {
			goToView('group', { groupId: g.id });
		});

		card.appendChild(el('span', { class: 'name', text: g.name }));
		if (inGroup.length) card.appendChild(renderSwatchStrip(inGroup));
		card.appendChild(el('span', { class: 'dot' + (anyOn ? ' on' : '') }));

		return card;
	}

	function renderMobileGroups() {
		var s = HueCore.getState();
		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({ title: 'Hue', showMenu: true }));

		var main = el('main');
		var viewEl = el('div', { id: 'view' });

		if (s.groups.length === 0) {
			viewEl.appendChild(el('div', { id: 'empty', text: 'No rooms yet. Create one in the Hue app first.' }));
		} else {
			var list = el('div', { id: 'groups-list' });
			s.groups.forEach(function (g) { list.appendChild(renderGroupCard(g, s.lights)); });
			viewEl.appendChild(list);
		}

		main.appendChild(viewEl);
		app.appendChild(main);
	}

	// --- Render: mobile group detail --------------------------------------

	function renderMobileGroup() {
		var s = HueCore.getState();
		var g = s.groups.find(function (x) { return x.id === s.selectedRoomId; });
		if (!g) {
			goToView('groups');
			return;
		}
		var lights = lightsInGroup(g, s.lights);
		var scenes = s.scenes.filter(function (sc) { return sc.group === g.id; });

		var app = $('app');
		clear(app);

		app.appendChild(renderHeader({ title: g.name, showBack: true }));

		var main = el('main');
		var viewDiv = el('div', { id: 'view' });

		// Scenes
		var scenesSection = el('div', { class: 'section' });
		scenesSection.appendChild(el('h3', { text: 'Scenes' }));
		if (scenes.length === 0) {
			scenesSection.appendChild(el('div', { class: 'empty', text: 'No scenes for this room.' }));
		} else {
			var scenesRow = el('div', { id: 'scenes-row' });
			scenes.forEach(function (sc) {
				var pill = el('button', { class: 'scene-pill', type: 'button', text: sc.name });
				pill.addEventListener('click', function () { HueCore.activateScene(g.id, sc.id); });
				scenesRow.appendChild(pill);
			});
			scenesSection.appendChild(scenesRow);
		}
		viewDiv.appendChild(scenesSection);

		// Group controls
		var anyOn = g.state && g.state.any_on;
		var bri = g.action && g.action.bri != null ? g.action.bri : 254;
		var ctrlSection = el('div', { class: 'section' });
		ctrlSection.appendChild(el('h3', { text: 'All lights' }));
		var ctrl = el('div', { id: 'group-controls' });
		var toggle = el('input', { type: 'checkbox', class: 'toggle', checked: !!anyOn });
		toggle.addEventListener('change', function () { HueCore.toggleGroup(g.id, toggle.checked); });
		ctrl.appendChild(toggle);
		var briInput = el('input', { type: 'range', min: 0, max: 254, value: bri });
		briInput.addEventListener('input', debounceEvent(function () {
			HueCore.setGroupBri(g.id, Number(briInput.value));
		}, 150));
		ctrl.appendChild(briInput);
		ctrlSection.appendChild(ctrl);
		viewDiv.appendChild(ctrlSection);

		// Lights
		var lightsSection = el('div', { class: 'section' });
		lightsSection.appendChild(el('h3', { text: 'Lights' }));
		if (lights.length === 0) {
			lightsSection.appendChild(el('div', { id: 'empty', text: 'No lights in this room.' }));
		} else {
			var list = el('div', { id: 'lights-list' });
			lights.forEach(function (l) { list.appendChild(renderLightCard(l)); });
			lightsSection.appendChild(list);
		}
		viewDiv.appendChild(lightsSection);

		main.appendChild(viewDiv);
		app.appendChild(main);
	}

	// --- Shared: light card + color picker -------------------------------

	function renderLightCard(light) {
		var s = light.state || {};
		var on = !!s.on;
		var bri = s.bri != null ? s.bri : 254;
		var reachable = s.reachable !== false;
		var supportsXY = !!s.xy;
		var supportsCT = !!s.ct && !supportsXY;

		var briInput = el('input', { type: 'range', min: 0, max: 254, value: bri });
		briInput.addEventListener('input', debounceEvent(function () {
			HueCore.setLightBri(light.id, Number(briInput.value));
		}, 150));

		var card = el('div', { class: 'light-card' + (reachable ? '' : ' unreachable') }, [
			el('div', { class: 'row1' }, [
				el('div', { class: 'swatch', style: 'background: rgb(' + swatchForLight(light) + ');' }),
				el('div', { class: 'name', text: light.name }),
				!reachable ? el('span', { class: 'badge', text: 'unreachable' }) : null,
				el('input', {
					type: 'checkbox',
					checked: on,
					onclick: function (e) { HueCore.toggleLight(light.id, e.target.checked); }
				})
			]),
			briInput
		]);

		if (supportsXY || supportsCT) {
			var isOpen = !!rendererState.expanded[light.id];
			var toggle = el('button', {
				class: 'toggle-details',
				text: isOpen ? 'Hide color' : 'Show color',
				onclick: function () {
					rendererState.expanded[light.id] = !isOpen;
					render();
				}
			});
			card.appendChild(toggle);
			if (isOpen) card.appendChild(renderLightDetails(light, supportsXY, supportsCT));
		}

		return card;
	}

	function renderLightDetails(light, supportsXY, supportsCT) {
		var s = light.state || {};
		var details = el('div', { class: 'details' });

		if (supportsXY) {
			var hsb = HueColor.bridgeToHsb(s.hue || 0, s.sat || 0, s.bri || 254);
			var preview = el('div', {
				class: 'swatch',
				style: 'width:28px; height:28px; background: rgb(' + HueColor.hsvToRgb(hsb.h, hsb.s, hsb.b) + ');'
			});
			details.appendChild(el('div', { style: 'display:flex; align-items:center; gap:8px;' }, [preview]));

			details.appendChild(makeSliderRow('H', 0, 360, hsb.h, function (v) {
				var cur = HueColor.bridgeToHsb(s.hue || 0, s.sat || 0, s.bri || 254);
				var b = HueColor.hsbToBridge(v, cur.s, cur.b);
				s.hue = b.hue; s.sat = b.sat; s.bri = b.bri;
				preview.style.background = 'rgb(' + HueColor.hsvToRgb(v, cur.s, cur.b) + ')';
				pushLightColor(light.id, b);
			}));
			details.appendChild(makeSliderRow('S', 0, 100, hsb.s, function (v) {
				var cur = HueColor.bridgeToHsb(s.hue || 0, s.sat || 0, s.bri || 254);
				var b = HueColor.hsbToBridge(cur.h, v, cur.b);
				s.hue = b.hue; s.sat = b.sat; s.bri = b.bri;
				preview.style.background = 'rgb(' + HueColor.hsvToRgb(cur.h, v, cur.b) + ')';
				pushLightColor(light.id, b);
			}));
			details.appendChild(makeSliderRow('B', 0, 100, hsb.b, function (v) {
				var cur = HueColor.bridgeToHsb(s.hue || 0, s.sat || 0, s.bri || 254);
				var b = HueColor.hsbToBridge(cur.h, cur.s, v);
				s.hue = b.hue; s.sat = b.sat; s.bri = b.bri;
				preview.style.background = 'rgb(' + HueColor.hsvToRgb(cur.h, cur.s, v) + ')';
				pushLightColor(light.id, b);
			}));
		} else if (supportsCT) {
			var mired = s.ct || 366;
			var preview = el('div', {
				class: 'swatch',
				style: 'width:28px; height:28px; background: rgb(' + HueColor.miredToRgb(mired) + ');'
			});
			details.appendChild(el('div', { style: 'display:flex; align-items:center; gap:8px;' }, [preview]));
			details.appendChild(makeSliderRow('CT', 153, 500, mired, function (v) {
				preview.style.background = 'rgb(' + HueColor.miredToRgb(v) + ')';
				pushLightCT(light.id, v);
			}));
		}

		return details;
	}

	function makeSliderRow(label, min, max, value, onCommit) {
		var display = el('span', { text: String(value) });
		var input = el('input', { type: 'range', min: min, max: max, value: value });
		input.addEventListener('input', debounceEvent(function () {
			var v = Number(input.value);
			display.textContent = String(v);
			onCommit(v);
		}, 150));
		return el('div', { class: 'slider-row' }, [
			el('span', { text: label }),
			input,
			display
		]);
	}

	// --- Shared: scenes row -----------------------------------------------

	function renderScenesRow(g, scenes) {
		var inGroup = scenes.filter(function (s) { return s.group === g.id; });
		var row = el('div', null, [
			el('h3', { text: 'Scenes' })
		]);
		row.id = 'scenes-row';
		if (inGroup.length === 0) {
			row.appendChild(el('div', { class: 'empty', text: 'No scenes for this room.' }));
		} else {
			inGroup.forEach(function (s) {
				row.appendChild(el('button', {
					class: 'scene-pill',
					type: 'button',
					text: s.name,
					onclick: function () { HueCore.activateScene(g.id, s.id); }
				}));
			});
		}
		return row;
	}

	// --- Render dispatch ---------------------------------------------------

	function render() {
		menuOpen = false;

		var s = HueCore.getState();

		if (view === 'cert-error') return renderCertError();
		if (view === 'error') return renderError(errorMessage);
		if (!s.creds) return renderConnect();

		if (isDesktop()) return renderDesktopDashboard();

		if (view === 'group' && s.selectedRoomId) return renderMobileGroup();
		return renderMobileGroups();
	}

	// --- Bootstrap ---------------------------------------------------------

	function init() {
		// Close menu on outside click
		document.addEventListener('click', function (e) {
			if (!e.target.closest('#menu-wrap')) closeMenu();
		});

		HueCore.on('state', function () {
			if (view === 'error') return;
			if (!HueCore.getState().creds) {
				view = 'connect';
				try { history.replaceState({ view: 'connect' }, ''); } catch (e) {}
				render();
				return;
			}
			render();
		});
		HueCore.on('error', function (e) { toast(e.message || 'Error', 'error'); });
		HueCore.on('cert-error', function (e) {
			if (e && e.ip) lastAttemptedIp = e.ip;
			view = 'cert-error';
			try { history.pushState({ view: 'cert-error' }, ''); } catch (err) {}
			render();
		});

		// Hardware back / browser forward
		window.addEventListener('popstate', function (e) {
			var state = e.state;
			if (!state) {
				view = HueCore.getState().creds ? 'groups' : 'connect';
			} else {
				view = state.view;
				if (state.groupId) HueCore.setSelectedRoomId(state.groupId);
			}
			render();
		});

		// Re-render on viewport crossing the 900px breakpoint
		var mql = window.matchMedia('(min-width: 900px)');
		var prevDesktop = mql.matches;
		function onMqChange() {
			var nowDesktop = mql.matches;
			if (nowDesktop !== prevDesktop) {
				prevDesktop = nowDesktop;
				render();
			}
		}
		if (mql.addEventListener) mql.addEventListener('change', onMqChange);
		else if (mql.addListener) mql.addListener(onMqChange); // older browsers

		HueCore.tryRestoreSession().then(function () {
			view = 'groups';
			try { history.replaceState({ view: 'groups' }, ''); } catch (e) {}
			render();
		}).catch(function (err) {
			if (HueCore.getState().certError) return;
			if (err && err.code === 'NO_CREDS') {
				view = 'connect';
				try { history.replaceState({ view: 'connect' }, ''); } catch (e) {}
				render();
			} else {
				renderError('Saved credentials are no longer valid. Clear your browser data to reconnect.');
			}
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();