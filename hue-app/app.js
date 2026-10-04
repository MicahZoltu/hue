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

	var rendererState = { expanded: {}, autoExpanded: {}, clusterExpanded: {} };
	var view = 'connect';
	var errorMessage = null;
	var lastAttemptedIp = null;
	var menuOpen = false;
	// Desktop-only subview selection for the dashboard panel ('rooms' | 'automations').
	var desktopSub = 'rooms';

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
		if (opts.fields) {
			opts.fields.forEach(function (f) {
				var label = el('label', { class: 'field' });
				label.appendChild(document.createTextNode(f.label));
				var input = el('input', { type: f.type || 'text', value: f.value != null ? f.value : '' });
				if (f.id) input.id = f.id;
				if (f.placeholder) input.placeholder = f.placeholder;
				label.appendChild(input);
				m.appendChild(label);
			});
		}
		if (!opts.hideTextarea && !opts.fields) {
			var ta = el('textarea', opts.editableText ? { id: 'modal-text', placeholder: opts.placeholder || '' } : { readonly: true });
			ta.value = opts.text || '';
			m.appendChild(ta);
		}
		if (opts.pre) {
			var pre = el('pre', { class: 'modal-pre' });
			pre.textContent = opts.pre;
			m.appendChild(pre);
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

	// Parse a bridge UTC timestamp like "2024-01-01T12:34:56" (sometimes missing
	// seconds) into epoch ms. Returns null if unparseable.
	function parseBridgeUtc(s) {
		if (!s) return null;
		var t = String(s);
		if (!/Z$|[+-]\d{2}:\d{2}$/.test(t)) {
			var hasSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t);
			t = t + (hasSeconds ? '' : ':00') + 'Z';
		}
		var ms = Date.parse(t);
		return isNaN(ms) ? null : ms;
	}

	// Small header indicator showing the bridge's own clock (config.localtime) plus,
	// when we can parse the bridge UTC, the skew in minutes against the browser.
	// Colored when the skew is large enough to flag a time-sync failure.
	function renderBridgeClock() {
		var s = HueCore.getState();
		if (!s.creds) return null;
		var bt = HueCore.getBridgeTime();
		var span = el('span', { class: 'bridge-clock', title: 'Bridge clock' });
		if (bt && bt.localtime) {
			var local = bt.localtime;
			var hhmm = local.length >= 16 ? local.slice(11, 16) : local;
			var skew = null;
			var utcMs = parseBridgeUtc(bt.utc);
			if (utcMs != null) skew = Math.round((utcMs - Date.now()) / 60000);
			span.textContent = '\u23F1 ' + hhmm + (skew != null ? ' (' + (skew >= 0 ? '+' : '') + skew + 'm)' : '');
			if (skew != null && Math.abs(skew) >= 5) span.classList.add('drift');
		} else {
			span.textContent = '\u23F1 --:--';
			span.classList.add('muted');
		}
		return span;
	}

	function renderMenuButton() {
		var wrap = el('div', { id: 'menu-wrap' });
		var btn = el('button', { id: 'menu-btn', class: 'ghost', title: 'Menu' });
		btn.innerHTML = '&#8943;';
		btn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
		var menu = el('div', { id: 'menu' });
		var autoBtn = el('button', { text: 'Automations' });
		autoBtn.addEventListener('click', function () { closeMenu(); openAutomations(); });
		menu.appendChild(autoBtn);
		var exportBtn = el('button', { text: 'Export credentials' });
		exportBtn.addEventListener('click', openExport);
		menu.appendChild(exportBtn);
		wrap.appendChild(btn);
		wrap.appendChild(menu);
		return wrap;
	}

	function openAutomations() {
		if (isDesktop()) {
			desktopSub = 'automations';
			view = 'groups';
			render();
		} else {
			goToView('automations');
		}
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

		if (opts.showClock !== false) {
			var clock = renderBridgeClock();
			if (clock) header.appendChild(clock);
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
			onclick: function () { desktopSub = 'rooms'; HueCore.setSelectedRoomId(g.id); }
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

		if (desktopSub === 'automations') {
			dashboard.appendChild(renderDesktopAutomations());
		} else {
			dashboard.appendChild(renderDesktopPanel(s.groups, s.lights, s.scenes, s.selectedRoomId));
		}

		app.appendChild(dashboard);
	}

	// --- Render: automations (shared body for desktop + mobile) ------------

	function renderDesktopAutomations() {
		var panel = el('section', { id: 'panel' });
		panel.appendChild(el('div', { id: 'panel-header' }, [
			el('h2', { text: 'Automations' }),
			el('span', { class: 'meta', text: 'Manage automations, schedules, and rules' })
		]));
		panel.appendChild(renderAutomationsBody());
		return panel;
	}

	// --- Human-readable summaries -----------------------------------------

	// Parse an address like "/groups/1/action" or "/lights/2/state" (or a scene /
	// sensor address) into { kind, id }. Returns null if unrecognized.
	function addrTarget(addr) {
		if (!addr) return null;
		var m = /^\/(groups|lights|scenes|sensors|rules|schedules)\/([^\/]+)/.exec(String(addr));
		return m ? { kind: m[1], id: m[2] } : null;
	}

	function nameForTarget(kind, id) {
		var s = HueCore.getState();
		if (kind === 'groups') {
			var g = s.groups.find(function (x) { return x.id === String(id); });
			if (g) return g.name;
		} else if (kind === 'lights') {
			var l = s.lights.find(function (x) { return x.id === String(id); });
			if (l) return l.name;
		} else if (kind === 'scenes') {
			var sc = s.scenes.find(function (x) { return x.id === String(id); });
			if (sc) return sc.name;
		} else if (kind === 'sensors') {
			var sn = s.sensors.find(function (x) { return x.id === String(id); });
			if (sn) return sn.name;
		}
		return null;
	}

	function describeTarget(addr) {
		var t = addrTarget(addr);
		if (!t) return null;
		var name = nameForTarget(t.kind, t.id);
		if (name) return name;
		var label = { groups: 'room', lights: 'light', scenes: 'scene', sensors: 'sensor', rules: 'rule', schedules: 'schedule' }[t.kind] || t.kind;
		return label + ' #' + t.id;
	}

	// --- Bridge-local time helpers ----------------------------------------
	//
	// Hue schedule/automation times are already in the bridge's local timezone,
	// so we only need to format them — no browser timezone math. Formats:
	//   2016-08-21T22:50:49   absolute one-shot
	//   W124/T07:00:00        weekly recurring (day mask: Mon=64 ... Sun=1)
	//   PTHH:MM:SS / R<n>/PT  timers
	//   ...AHH:MM:SS          randomized suffix on any of the above

	var DAY_BITS = [['Mon', 64], ['Tue', 32], ['Wed', 16], ['Thu', 8], ['Fri', 4], ['Sat', 2], ['Sun', 1]];

	function humanizeHueTime(t) {
		if (!t) return null;
		var s = String(t);
		if (s === 'none') return null;
		var rand = '';
		var am = /A(\d{2}:\d{2}:\d{2})$/.exec(s);
		if (am) { s = s.slice(0, s.length - am[0].length); rand = ' (±' + am[1].slice(0, 5) + ')'; }

		var w = /^W(\d+)\/T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
		if (w) {
			var mask = parseInt(w[1], 10);
			var days = [];
			DAY_BITS.forEach(function (d) { if (mask & d[1]) days.push(d[0]); });
			var dayText = mask === 127 ? 'Daily' : (days.length ? days.join(', ') : 'weekly');
			return dayText + ' at ' + w[2] + ':' + w[3] + rand;
		}

		var a = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
		if (a) return 'On ' + a[3] + '.' + a[2] + '.' + a[1] + ' at ' + a[4] + ':' + a[5] + rand;

		var p = /^(?:R(\d*)\/)?PT(\d{2}):(\d{2}):(\d{2})$/.exec(s);
		if (p) {
			var dur = [];
			if (parseInt(p[2], 10)) dur.push(parseInt(p[2], 10) + 'h');
			if (parseInt(p[3], 10)) dur.push(parseInt(p[3], 10) + 'm');
			if (parseInt(p[4], 10)) dur.push(parseInt(p[4], 10) + 's');
			var rep = p[1] === '' ? 'repeating' : (p[1] ? 'repeats ' + p[1] + '×' : 'once');
			return 'Timer ' + (dur.join(' ') || '0s') + ' (' + rep + ')' + rand;
		}

		return s;
	}

	function isTimerTime(t) { return /^(?:R\d*\/)?PT/.test(String(t || '')); }

	// "HH:MM" extracted from a weekly or absolute Hue time string, for <input type=time>.
	function extractHHMM(t) {
		var m = /T(\d{2}):(\d{2})(?::\d{2})?/.exec(String(t || ''));
		return m ? m[1] + ':' + m[2] : null;
	}

	// Replace the time portion of a weekly/absolute Hue time string with "HH:MM",
	// preserving the date/day-mask prefix, seconds and randomization suffix.
	function withNewTime(orig, hhmm) {
		var s = String(orig || '');
		if (!/T\d{2}:\d{2}(:\d{2})?/.test(s)) return hhmm + ':00';
		return s.replace(/T\d{2}:\d{2}(:\d{2})?/, 'T' + hhmm + ':00');
	}

	function humanizeLastTriggered(t) {
		if (!t || t === 'none') return 'never';
		var h = humanizeHueTime(t);
		return h || t;
	}

	function findSchedule(id) {
		var s = HueCore.getState();
		return s.schedules.find(function (x) { return x.id === String(id); }) || null;
	}

	// Schedules on real bridges are often named with bare numbers; in that case a
	// reference reads better as "#id (Timer 5m)" than "'7'".
	function scheduleLabel(id) {
		var sc = findSchedule(id);
		if (!sc) return 'schedule #' + id;
		var n = sc.name;
		if (n && !/^\d+:?$/.test(String(n).trim()) && String(n) !== String(sc.id)) return "'" + n + "'";
		var t = humanizeHueTime(sc.localtime);
		return '#' + sc.id + (t ? ' (' + t + ')' : '');
	}

	// Build a proper sentence for a Hue command/action object { address, method, body }.
	function describeAction(cmd) {
		if (!cmd) return null;
		var t = addrTarget(cmd.address);
		var target = describeTarget(cmd.address);
		var body = cmd.body || {};
		var q = target ? " '" + target + "'" : '';

		// Actions that start/stop schedules (rules commonly enable/disable timers).
		if (t && t.kind === 'schedules') {
			var sched = findSchedule(t.id);
			var isTimer = sched && isTimerTime(sched.localtime);
			var what = isTimer ? 'timer' : 'schedule';
			if (body.status === 'enabled') return 'Start ' + what + ' ' + scheduleLabel(t.id);
			if (body.status === 'disabled') return 'Stop ' + what + ' ' + scheduleLabel(t.id);
			return 'Send action to ' + what + ' ' + scheduleLabel(t.id);
		}
		// Actions that set a variable sensor's value (CLIPGenericStatus flags).
		if (t && t.kind === 'sensors' && body.status != null) {
			return "Set '" + (target || ('sensor #' + t.id)) + "' to " + body.status;
		}
		// Actions that enable/disable other rules.
		if (t && t.kind === 'rules' && body.status != null) {
			return (body.status === 'enabled' ? 'Enable rule ' : 'Disable rule ') + q;
		}
		if (body.scene != null) {
			var sc = nameForTarget('scenes', body.scene) || body.scene;
			return "Activate scene '" + sc + "'" + (target ? ' in' + q : '');
		}
		if (body.storelightstate) {
			return 'Save current light state to' + (target ? q : ' a scene');
		}
		var out;
		if (body.on === false) out = 'Turn off' + q;
		else if (body.on === true) out = 'Turn on' + q;
		if (body.bri != null && body.on !== false) {
			var pct = Math.round(body.bri / 254 * 100);
			out = out ? out + ' at ' + pct + '%' : 'Set brightness of' + q + ' to ' + pct + '%';
		}
		if (!out) out = 'Send action to' + q;
		return out;
	}

	// Render a rule condition as readable text, resolving the target and mapping
	// the state attribute (presence/any_on/daylight/...) to plain words.
	function describeCondition(c) {
		if (!c) return null;
		var t = addrTarget(c.address);
		var name = t ? (nameForTarget(t.kind, t.id) || describeTarget(c.address)) : 'device';
		var am = /\/state\/([^\/]+)$/.exec(String(c.address || ''));
		var attrMap = {
			presence: 'motion detected', daylight: 'daylight', any_on: 'any light on',
			all_on: 'all lights on', status: 'status', buttonevent: 'button event',
			lightlevel: 'light level', dark: 'dark', temperature: 'temperature',
			flag: 'flag', open: 'open', humidity: 'humidity', localtime: 'time'
		};
		var attrText = (am && (attrMap[am[1]] || am[1])) || 'state';
		var ops = { eq: 'is', ne: 'is not', gt: 'is above', lt: 'is below', dx: 'changed', ddx: 'changed', stable: 'stable at', in: 'in', out: 'not in' };
		var op = ops[c.operator] || c.operator;
		if (c.operator === 'dx' || c.operator === 'ddx') return "'" + name + "' " + attrText + ' changed';
		var val = c.value;
		if (val === 'true') val = 'yes';
		else if (val === 'false') val = 'no';
		return "'" + name + "' " + attrText + (val != null ? ' ' + op + ' ' + val : '');
	}

	function summarizeAutomationArgs(item) {
		var args = item.args;
		if (!args || typeof args !== 'object') return null;
		var bits = [];
		if (args.scene != null) {
			bits.push("scene: '" + (nameForTarget('scenes', args.scene) || args.scene) + "'");
		}
		if (args.group != null) {
			bits.push("room: '" + (nameForTarget('groups', args.group) || args.group) + "'");
		}
		if (args.light != null) bits.push('light: ' + args.light);
		if (args.on != null) bits.push('on: ' + args.on);
		if (args.bri != null) bits.push('brightness: ' + args.bri);
		if (args.brightness != null) bits.push('brightness: ' + args.brightness);
		if (args.fade_in_time != null) bits.push('fade in: ' + args.fade_in_time);
		if (args.randomize != null) bits.push('randomize: ' + args.randomize);
		if (args.recurrence != null) bits.push('recurrence: ' + args.recurrence);
		return bits.length ? bits.join(' \u00B7 ') : null;
	}

	// Some bridges name schedules/rules with bare numbers (often equal to the id).
	// Those aren't meaningful names, so derive one from what the item does.
	function displayName(item, kind) {
		var n = item.name;
		if (n && !/^\d+:?$/.test(String(n).trim()) && String(n) !== String(item.id)) return n;
		if (kind === 'schedule') {
			var a = describeAction(item.command);
			if (a) return a;
		}
		if (kind === 'rule') {
			var acts = (item.actions || []).map(describeAction).filter(Boolean);
			if (acts.length) return acts[0];
		}
		if (item.description) return item.description;
		return '(unnamed)';
	}

	function describeItem(item, kind) {
		var lines = [];
		if (kind === 'schedule') {
			if (item.description) lines.push(item.description);
			var act = describeAction(item.command);
			if (act && act !== displayName(item, kind)) lines.push(act);
			if (item.localtime) lines.push('When: ' + (humanizeHueTime(item.localtime) || item.localtime));
		} else if (kind === 'rule') {
			var conds = (item.conditions || []).map(describeCondition).filter(Boolean);
			var acts = (item.actions || []).map(describeAction).filter(Boolean);
			if (conds.length) {
				lines.push('When');
				conds.forEach(function (c) { lines.push('\u2022 ' + c); });
			}
			if (acts.length) {
				lines.push('Then');
				acts.forEach(function (a) { lines.push('\u2022 ' + a); });
			}
			lines.push('Last triggered: ' + humanizeLastTriggered(item.lasttriggered));
		} else {
			// automation
			if (item.description) lines.push(item.description);
			lines.push('Type: ' + (item.type || 'unknown') + (item.template ? ' \u00B7 template: ' + item.template : ''));
			if (item.starttime) lines.push('When: ' + (humanizeHueTime(item.starttime) || item.starttime));
			lines.push('Last triggered: ' + humanizeLastTriggered(item.lasttriggered));
			var argText = summarizeAutomationArgs(item);
			if (argText) lines.push('Details: ' + argText);
		}
		if (!lines.length) lines.push('No descriptive detail available.');
		return lines;
	}

	function renderAutomationRow(item, opts) {
		var expandKey = (opts.kind || 'item') + ':' + item.id;
		var expanded = !!rendererState.autoExpanded[expandKey];
		function toggleExpand() {
			rendererState.autoExpanded[expandKey] = !rendererState.autoExpanded[expandKey];
			render();
		}

		var on = item.status !== 'disabled';
		var row = el('div', { class: 'auto-row' + (on ? '' : ' off') });
		// Click anywhere on the row (except the controls) to expand/collapse.
		row.addEventListener('click', function (e) {
			if (e.target.closest('.auto-edit') || e.target.closest('.toggle') || e.target.closest('.auto-expand')) return;
			toggleExpand();
		});

		var info = el('div', { class: 'auto-info' });
		info.appendChild(el('div', { class: 'auto-name', text: displayName(item, opts.kind) }));
		var metaParts = [];
		var when = humanizeHueTime(item.localtime || item.starttime);
		if (when) metaParts.push(when);
		if (item.type) metaParts.push(item.type);
		metaParts.push(item.status || 'unknown');
		info.appendChild(el('div', { class: 'auto-meta', text: metaParts.join(' \u00B7 ') }));
		row.appendChild(info);

		var chev = el('button', { class: 'auto-expand' + (expanded ? ' open' : ''), type: 'button', title: 'Details' });
		chev.innerHTML = '\u203A';
		chev.addEventListener('click', toggleExpand);
		row.appendChild(chev);

		var toggle = el('input', { type: 'checkbox', class: 'toggle', checked: on });
		toggle.addEventListener('change', function () {
			if (opts.onToggle) opts.onToggle(item, toggle.checked);
		});
		row.appendChild(toggle);

		if (opts.editable && opts.onEdit) {
			var editBtn = el('button', { class: 'auto-edit', text: 'Edit' });
			editBtn.addEventListener('click', function () { opts.onEdit(item); });
			row.appendChild(editBtn);
		}

		if (expanded) {
			var details = el('div', { class: 'auto-details' });
			describeItem(item, opts.kind).forEach(function (ln) {
				var cls = 'auto-line' + (/^\u2022 /.test(ln) ? ' bullet' : (ln === 'When' || ln === 'Then' ? ' subhead' : ''));
				details.appendChild(el('div', { class: cls, text: ln }));
			});
			// Automations expose undocumented, type-specific args. Always include the
			// raw object so any unknown automation can be reviewed and turned into a
			// proper template later.
			if (opts.kind === 'automation' && item.raw) {
				details.appendChild(el('div', { class: 'auto-raw-label', text: 'Raw data' }));
				var pre = el('pre', { class: 'auto-raw' });
				pre.textContent = JSON.stringify(item.raw, null, 2);
				details.appendChild(pre);
			}
			row.appendChild(details);
		}
		return row;
	}

	function renderResourceSection(title, list, opts) {
		opts = opts || {};
		var section = el('div', { class: 'section' });
		section.appendChild(el('h3', { text: title + (list.length ? ' (' + list.length + ')' : '') }));
		if (!list.length) {
			section.appendChild(el('div', { class: 'auto-empty', text: opts.emptyText || 'None.' }));
			return section;
		}
		var container = el('div', { class: 'auto-list' });
		list.forEach(function (item) { container.appendChild(renderAutomationRow(item, opts)); });
		section.appendChild(container);
		return section;
	}

	// Sorting: schedules chronologically by time-of-day (timers last), rules and
	// automations alphabetically by their display name.
	function timeSortKey(item) {
		var t = item.localtime || item.starttime;
		if (!t) return '\uffff';
		if (isTimerTime(t)) return '\ufffe';
		var hm = extractHHMM(t);
		return hm || '\ufffd';
	}

	function sortedItems(list, kind) {
		var arr = list.slice();
		if (kind === 'schedule') {
			arr.sort(function (a, b) { return timeSortKey(a).localeCompare(timeSortKey(b)); });
		} else {
			arr.sort(function (a, b) {
				return displayName(a, kind).toLowerCase().localeCompare(displayName(b, kind).toLowerCase());
			});
		}
		return arr;
	}

	// --- Composite automation detection -------------------------------------
	//
	// Third-party apps build rich automations out of bridge primitives: variable
	// sensors as state flags, storage scenes as memory, schedules as timers, and
	// rules as glue. Detect those composite automations by linking rules that
	// reference the same sensor / scene / schedule / rule (connected components).
	// Groups and lights are deliberately excluded from linking — they are targets,
	// not glue, and linking on them would merge every same-room rule into one blob.

	var LINK_KINDS = ['sensors', 'scenes', 'schedules', 'rules'];

	function ruleRefs(rule) {
		var refs = { groups: [], lights: [], scenes: [], sensors: [], schedules: [], rules: [] };
		(rule.conditions || []).concat(rule.actions || []).forEach(function (x) {
			var t = addrTarget(x.address);
			if (t && refs[t.kind] && refs[t.kind].indexOf(t.id) < 0) refs[t.kind].push(t.id);
		});
		// Scene activations reference the scene in the body, not the address.
		(rule.actions || []).forEach(function (a) {
			if (a.body && a.body.scene != null && refs.scenes.indexOf(String(a.body.scene)) < 0) {
				refs.scenes.push(String(a.body.scene));
			}
		});
		return refs;
	}

	function clusterRules(rules) {
		var byRef = {};
		rules.forEach(function (r, i) {
			var refs = ruleRefs(r);
			LINK_KINDS.forEach(function (kind) {
				refs[kind].forEach(function (id) {
					var k = kind + ':' + id;
					(byRef[k] = byRef[k] || []).push(i);
				});
			});
		});
		var parent = rules.map(function (_, i) { return i; });
		function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
		function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
		Object.keys(byRef).forEach(function (k) {
			var idxs = byRef[k];
			for (var j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);
		});
		var groups = {};
		rules.forEach(function (r, i) {
			var root = find(i);
			(groups[root] = groups[root] || []).push(r);
		});
		return Object.keys(groups).map(function (k) { return groups[k]; });
	}

	// Name a cluster after its most-referenced shared glue resource: prefer the
	// variable sensor (these are usually named after the automation, e.g.
	// "Main Area, Vibrant"), then scenes and rules; fall back to the room.
	function clusterName(rules) {
		var best = null, bestN = 0;
		['sensors', 'scenes', 'rules'].forEach(function (kind) {
			var counts = {};
			rules.forEach(function (r) {
				ruleRefs(r)[kind].forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
			});
			Object.keys(counts).forEach(function (id) {
				if (counts[id] > bestN) {
					var nm = nameForTarget(kind, id);
					if (nm) { bestN = counts[id]; best = nm; }
				}
			});
		});
		if (best) return best;
		var gcounts = {};
		rules.forEach(function (r) {
			ruleRefs(r).groups.forEach(function (id) {
				var n = nameForTarget('groups', id);
				if (n) gcounts[n] = (gcounts[n] || 0) + 1;
			});
		});
		var gbest = null, gn = 0;
		Object.keys(gcounts).forEach(function (n) { if (gcounts[n] > gn) { gn = gcounts[n]; gbest = n; } });
		return gbest ? gbest + ' automation' : 'Linked rules';
	}

	// Small labeled chips describing the composite automation's building blocks.
	function clusterChips(rules) {
		var sensors = {}, scenes = {}, snapshots = {}, schedules = {}, rooms = {};
		rules.forEach(function (r) {
			var refs = ruleRefs(r);
			refs.sensors.forEach(function (id) { sensors[id] = true; });
			refs.schedules.forEach(function (id) { schedules[id] = true; });
			refs.groups.forEach(function (id) { rooms[id] = true; });
			(r.actions || []).forEach(function (a) {
				var t = addrTarget(a.address);
				if (t && t.kind === 'scenes' && a.body && a.body.storelightstate) snapshots[t.id] = true;
			});
			refs.scenes.forEach(function (id) { if (!snapshots[id]) scenes[id] = true; });
		});
		var chips = [];
		Object.keys(sensors).forEach(function (id) { chips.push({ role: 'var', label: 'variable: ' + (nameForTarget('sensors', id) || ('#' + id)) }); });
		Object.keys(snapshots).forEach(function (id) { chips.push({ role: 'snapshot', label: 'snapshot: ' + (nameForTarget('scenes', id) || ('#' + id)) }); });
		Object.keys(scenes).forEach(function (id) { chips.push({ role: 'scene', label: 'scene: ' + (nameForTarget('scenes', id) || ('#' + id)) }); });
		Object.keys(schedules).forEach(function (id) {
			var sc = findSchedule(id);
			chips.push({ role: 'timer', label: (sc && isTimerTime(sc.localtime) ? 'timer: ' : 'schedule: ') + scheduleLabel(id) });
		});
		Object.keys(rooms).forEach(function (id) { chips.push({ role: 'room', label: 'room: ' + (nameForTarget('groups', id) || ('#' + id)) }); });
		return chips.slice(0, 12);
	}

	function renderRuleCluster(rules, key, opts) {
		var expanded = rendererState.clusterExpanded[key] !== false; // default open
		var card = el('div', { class: 'auto-cluster' });

		var head = el('div', { class: 'cluster-head' });
		head.addEventListener('click', function () {
			rendererState.clusterExpanded[key] = !expanded;
			render();
		});
		var titleWrap = el('div', { class: 'cluster-title' }, [
			el('div', { class: 'cluster-name', text: clusterName(rules) }),
			el('div', { class: 'cluster-meta', text: rules.length + ' linked rules' })
		]);
		head.appendChild(titleWrap);

		// Master toggle: enable/disable the whole automation (all member rules).
		var allOn = rules.every(function (r) { return r.status !== 'disabled'; });
		var master = el('input', { type: 'checkbox', class: 'toggle', checked: allOn, title: 'Enable/disable all rules in this automation' });
		master.addEventListener('click', function (e) { e.stopPropagation(); });
		master.addEventListener('change', function () {
			rules.forEach(function (r) {
				if ((r.status !== 'disabled') !== master.checked) HueCore.setRuleEnabled(r.id, master.checked);
			});
		});
		head.appendChild(master);

		var chev = el('button', { class: 'auto-expand' + (expanded ? ' open' : ''), type: 'button' });
		chev.innerHTML = '\u203A';
		head.appendChild(chev);
		card.appendChild(head);

		if (expanded) {
			var chips = clusterChips(rules);
			if (chips.length) {
				var chipRow = el('div', { class: 'cluster-chips' });
				chips.forEach(function (ch) { chipRow.appendChild(el('span', { class: 'chip ' + ch.role, text: ch.label })); });
				card.appendChild(chipRow);
			}
			var list = el('div', { class: 'auto-list cluster-rules' });
			rules.forEach(function (r) { list.appendChild(renderAutomationRow(r, opts)); });
			card.appendChild(list);
		}
		return card;
	}

	function renderRulesSection(rules, opts) {
		var section = el('div', { class: 'section' });
		section.appendChild(el('h3', { text: 'Rules' + (rules.length ? ' (' + rules.length + ')' : '') }));
		if (!rules.length) {
			section.appendChild(el('div', { class: 'auto-empty', text: 'No rules.' }));
			return section;
		}
		var clusters = clusterRules(rules);
		// Composite automations (multi-rule clusters) first, largest first, then
		// standalone rules as regular rows.
		var multis = clusters.filter(function (c) { return c.length > 1; })
			.sort(function (a, b) { return b.length - a.length; });
		var singles = clusters.filter(function (c) { return c.length === 1; });
		var container = el('div', { class: 'auto-list' });
		multis.forEach(function (c) {
			var key = 'cluster:' + c.map(function (r) { return r.id; }).sort().join(',');
			container.appendChild(renderRuleCluster(c, key, opts));
		});
		singles.forEach(function (c) { container.appendChild(renderAutomationRow(c[0], opts)); });
		section.appendChild(container);
		return section;
	}

	// --- Native (v2) behavior instances -------------------------------------

	function scriptNameFor(scriptId) {
		var s = HueCore.getState();
		var sc = s.behaviorScripts.find(function (x) { return x.id === scriptId; });
		return sc ? sc.name : null;
	}

	function formatV2Days(days) {
		if (!days || !days.length) return '';
		var set = {};
		days.forEach(function (d) { set[d] = true; });
		var all = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
		if (all.every(function (d) { return set[d]; })) return 'daily';
		var wd = all.slice(0, 5), we = all.slice(5);
		if (wd.every(function (d) { return set[d]; }) && !we.some(function (d) { return set[d]; })) return 'weekdays';
		if (we.every(function (d) { return set[d]; }) && !wd.some(function (d) { return set[d]; })) return 'weekends';
		return days.map(function (d) { return d.charAt(0).toUpperCase() + d.slice(1, 3); }).join(', ');
	}

	function pad2(n) { n = parseInt(n, 10); return (n < 10 ? '0' : '') + n; }

	function sortedBehaviorInstances(list) {
		return list.slice().sort(function (a, b) {
			var an = (a.name || scriptNameFor(a.scriptId) || '').toLowerCase();
			var bn = (b.name || scriptNameFor(b.scriptId) || '').toLowerCase();
			return an.localeCompare(bn);
		});
	}

	// Walk a behavior configuration for clock times, fade durations and target
	// resources. The common shape is cfg.when_extended { recurrence_days,
	// start_at.time_point.time, transition.minutes } with targets in where/what;
	// schemas vary per script, so generic walking is the fallback and the raw
	// config is always shown too.
	function v2Summarize(cfg, names) {
		var times = [], fades = [], targets = [];
		function walkTimes(o) {
			if (!o || typeof o !== 'object') return;
			if (Array.isArray(o)) { o.forEach(walkTimes); return; }
			if (o.time && typeof o.time === 'object' && o.time.hour != null) {
				var hhmm = pad2(o.time.hour) + ':' + pad2(o.time.minute || 0);
				var d = formatV2Days(o.recurrence_days);
				var text = d ? hhmm + ' (' + d + ')' : hhmm;
				if (times.indexOf(text) < 0) times.push(text);
			} else if (o.sun_time_type) {
				var st = String(o.sun_time_type).replace(/_/g, ' ');
				if (times.indexOf(st) < 0) times.push(st);
			}
			Object.keys(o).forEach(function (k) { walkTimes(o[k]); });
		}
		function walkTargets(o) {
			if (!o || typeof o !== 'object') return;
			if (Array.isArray(o)) { o.forEach(walkTargets); return; }
			if (o.rid && o.rtype && ['room', 'zone', 'scene', 'light', 'bridge_home', 'recipe'].indexOf(o.rtype) >= 0) {
				var nm = names[o.rid];
				var label = nm ? "'" + nm + "'" : (o.rtype === 'bridge_home' ? 'whole home' : o.rtype);
				if (targets.indexOf(label) < 0) targets.push(label);
			}
			Object.keys(o).forEach(function (k) { walkTargets(o[k]); });
		}
		if (cfg && typeof cfg === 'object') {
			// Structured when_extended shape (native Hue routines).
			var we = cfg.when_extended;
			if (we && typeof we === 'object') {
				var startAt = we.start_at || {};
				var tod = startAt.time_point && startAt.time_point.time;
				if (tod && tod.hour != null) {
					var hhmm = pad2(tod.hour) + ':' + pad2(tod.minute || 0);
					var d = formatV2Days(we.recurrence_days);
					times.push(d ? hhmm + ' (' + d + ')' : hhmm);
				}
				var tr = (startAt.transition && startAt.transition.minutes != null) ? startAt.transition
					: (we.transition && we.transition.minutes != null) ? we.transition : null;
				if (tr) fades.push('fade ' + tr.minutes + 'm');
			}
			if (!times.length) walkTimes(cfg.when != null ? cfg.when : cfg);
			walkTargets(cfg.where != null ? cfg.where : cfg);
			if (cfg.what != null) walkTargets(cfg.what);
		}
		return { times: times, fades: fades, targets: targets };
	}

	function describeBehavior(b) {
		var s = HueCore.getState();
		var lines = [];
		var script = scriptNameFor(b.scriptId);
		if (script) lines.push('Type: ' + script);
		var sum = v2Summarize(b.configuration, s.v2Names);
		var when = sum.times.concat(sum.fades);
		if (when.length) lines.push('When: ' + when.join(', '));
		if (sum.targets.length) lines.push('Where: ' + sum.targets.join(', '));
		if (b.status) lines.push('Status: ' + b.status);
		if (!lines.length) lines.push('No descriptive detail available.');
		return lines;
	}

	function renderBehaviorRow(b, opts) {
		opts = opts || {};
		var expandKey = 'behavior:' + b.id;
		var expanded = !!rendererState.autoExpanded[expandKey];
		function toggleExpand() {
			rendererState.autoExpanded[expandKey] = !rendererState.autoExpanded[expandKey];
			render();
		}
		var s = HueCore.getState();
		var row = el('div', { class: 'auto-row' + (b.enabled ? '' : ' off') });
		row.addEventListener('click', function (e) {
			if (e.target.closest('.toggle') || e.target.closest('.auto-expand')) return;
			toggleExpand();
		});

		var info = el('div', { class: 'auto-info' });
		var name = b.name || scriptNameFor(b.scriptId) || 'Automation';
		info.appendChild(el('div', { class: 'auto-name', text: name }));
		var metaParts = [];
		var sum = v2Summarize(b.configuration, s.v2Names);
		if (sum.times.length) metaParts.push(sum.times.join(', '));
		if (sum.fades.length) metaParts.push(sum.fades.join(', '));
		if (sum.targets.length) metaParts.push(sum.targets.join(', '));
		metaParts.push(b.enabled ? 'enabled' : 'disabled');
		info.appendChild(el('div', { class: 'auto-meta', text: metaParts.join(' \u00B7 ') }));
		row.appendChild(info);

		var chev = el('button', { class: 'auto-expand' + (expanded ? ' open' : ''), type: 'button', title: 'Details' });
		chev.innerHTML = '\u203A';
		chev.addEventListener('click', toggleExpand);
		row.appendChild(chev);

		var toggle = el('input', { type: 'checkbox', class: 'toggle', checked: b.enabled });
		if (opts.readonly) {
			toggle.disabled = true;
			toggle.title = 'Read-only (manual import) — the browser can\u2019t reach the v2 API to change this';
		} else {
			toggle.addEventListener('change', function () {
				HueCore.setBehaviorInstanceEnabled(b.id, toggle.checked)
					.catch(function (e) { toast(e.message || 'Toggle failed', 'error'); });
			});
		}
		row.appendChild(toggle);

		if (expanded) {
			var details = el('div', { class: 'auto-details' });
			describeBehavior(b).forEach(function (ln) {
				details.appendChild(el('div', { class: 'auto-line', text: ln }));
			});
			details.appendChild(el('div', { class: 'auto-raw-label', text: 'Raw data' }));
			var pre = el('pre', { class: 'auto-raw' });
			pre.textContent = JSON.stringify(b.raw, null, 2);
			details.appendChild(pre);
			row.appendChild(details);
		}
		return row;
	}

	function openV2ImportModal() {
		var creds = HueCore.getState().creds;
		var ip = creds && creds.ip;
		var token = creds && creds.token;
		var curlCmd = 'curl -k https://' + (ip || '<bridge-ip>') + '/clip/v2/resource/behavior_instance -H "hue-application-key: ' + (token || '<your-token>') + '"';
		showModal({
			title: 'Import Hue app automations',
			body: 'This bridge only serves its v2 API over HTTPS with a self-signed certificate, and it answers browser CORS preflight requests with 405 \u2014 so no browser page can call it directly. Run this command, then paste its JSON output below:',
			pre: curlCmd,
			editableText: true,
			placeholder: '{"errors":[],"data":[{"id":"...","type":"behavior_instance", ...}]}',
			actions: [
				{ label: 'Copy curl command', onclick: function () {
					copyToClipboard(curlCmd);
					toast('Curl command copied.', 'info');
				} },
				{ label: 'Import', primary: true, onclick: function (m) {
					var text = m.querySelector('#modal-text').value.trim();
					if (!text) { toast('Paste the curl output first.', 'error'); return; }
					HueCore.importV2Behaviors(text)
						.then(function (n) { toast('Imported ' + n + ' automation' + (n === 1 ? '' : 's') + '.', 'info'); })
						.catch(function (e) { toast(e.message || 'Import failed', 'error'); });
					closeModal(m);
				} },
				{ label: 'Cancel', onclick: function (m) { closeModal(m); } }
			]
		});
	}

	function renderBehaviorSection() {
		var s = HueCore.getState();
		var section = el('div', { class: 'section' });
		section.appendChild(el('h3', { text: 'Hue app automations' + (s.behaviorInstances.length ? ' (' + s.behaviorInstances.length + ')' : '') }));

		if (s.v2Status === 'manual') {
			var note = el('div', { class: 'auto-note' }, [
				document.createTextNode('Showing automations imported from curl (read-only) \u2014 the browser can\u2019t reach this bridge\u2019s v2 API directly. '),
				el('button', { class: 'auto-edit', text: 'Re-import', onclick: openV2ImportModal }),
				document.createTextNode(' '),
				el('button', { class: 'auto-edit', text: 'Clear', onclick: function () {
					HueCore.clearV2Import().catch(function (e) { toast(e.message || 'Clear failed', 'error'); });
				} })
			]);
			section.appendChild(note);
			var manualList = el('div', { class: 'auto-list' });
			sortedBehaviorInstances(s.behaviorInstances).forEach(function (b) {
				manualList.appendChild(renderBehaviorRow(b, { readonly: true }));
			});
			section.appendChild(manualList);
			return section;
		}

		if (s.v2Status === 'cert') {
			var ip = s.creds && s.creds.ip;
			var note = el('div', { class: 'auto-note' });
			if (HueApi.scheme === 'https:') {
				// Secure page: v2 went over https and the self-signed cert was rejected.
				note.appendChild(document.createTextNode('Native Hue-app routines (daily dim/brighten, Wake up, Natural light\u2026) live behind the bridge\u2019s v2 API, and the browser blocked the connection because of the bridge\u2019s self-signed certificate. '));
				if (ip) {
					var link = el('button', { class: 'auto-edit', text: 'Open bridge page' });
					link.addEventListener('click', function () { window.open('https://' + ip + '/', '_blank'); });
					note.appendChild(link);
					note.appendChild(document.createTextNode(' Accept the certificate there, then tap Refresh. '));
				}
			} else {
				// file:// or http page: v2 was tried over plain http, so this is the
				// bridge refusing (CORS preflight 405) or not serving v2 on port 80.
				note.appendChild(document.createTextNode('Native Hue-app routines (daily dim/brighten, Wake up, Natural light\u2026) live behind the bridge\u2019s v2 API, which this bridge doesn\u2019t serve over HTTP and protects over HTTPS with a self-signed certificate plus CORS preflight rejection \u2014 the browser can\u2019t reach it either way. '));
			}
			note.appendChild(el('button', { class: 'auto-edit', text: 'Import from curl', onclick: openV2ImportModal }));
			section.appendChild(note);
			return section;
		}
		if (s.v2Status === 'unavailable') {
			var note2 = el('div', { class: 'auto-note' }, [
				document.createTextNode('Native Hue-app automations didn\u2019t load (v2 API unreachable from the browser). '),
				el('button', { class: 'auto-edit', text: 'Import from curl', onclick: openV2ImportModal })
			]);
			section.appendChild(note2);
			return section;
		}
		if (s.v2Status !== 'ok') return null;

		if (!s.behaviorInstances.length) {
			section.appendChild(el('div', { class: 'auto-empty', text: 'No native automations.' }));
			return section;
		}
		var container = el('div', { class: 'auto-list' });
		sortedBehaviorInstances(s.behaviorInstances).forEach(function (b) {
			container.appendChild(renderBehaviorRow(b));
		});
		section.appendChild(container);
		return section;
	}

	function renderAutomationsBody() {
		var s = HueCore.getState();
		var body = el('div', { id: 'automations-view' });
		var behaviorSection = renderBehaviorSection();
		if (behaviorSection) body.appendChild(behaviorSection);
		if (s.automationsSupported === false) {
			body.appendChild(el('p', { class: 'auto-note', text: 'The /automations endpoint is not available on this bridge firmware. Routines created in the Hue app appear below as schedules and rules.' }));
		} else {
			body.appendChild(renderResourceSection('Automations', sortedItems(s.automations, 'automation'), {
				kind: 'automation',
				emptyText: 'No automations.',
				onToggle: function (item, on) { HueCore.setAutomationEnabled(item.id, on); },
				editable: true,
				onEdit: function (item) { openEditAutomation(item); }
			}));
		}
		body.appendChild(renderResourceSection('Schedules', sortedItems(s.schedules, 'schedule'), {
			kind: 'schedule',
			emptyText: 'No schedules.',
			onToggle: function (item, on) { HueCore.setScheduleEnabled(item.id, on); },
			editable: true,
			onEdit: function (item) { openEditSchedule(item); }
		}));
		body.appendChild(renderRulesSection(sortedItems(s.rules, 'rule'), {
			kind: 'rule',
			onToggle: function (item, on) { HueCore.setRuleEnabled(item.id, on); }
		}));
		return body;
	}

	function openEditSchedule(item) {
		closeMenu();
		// Weekly/absolute times get a proper time picker (bridge-local); timers
		// (PT...) aren't a clock time, so keep a text field for those.
		var usePicker = !!(item.localtime && !isTimerTime(item.localtime) && extractHHMM(item.localtime));
		var timeField = usePicker
			? { id: 'edit-localtime', label: 'Start time (bridge local)', type: 'time', value: extractHHMM(item.localtime) }
			: { id: 'edit-localtime', label: 'Schedule time (localtime)', value: item.localtime || '', placeholder: 'e.g. W127/T07:00:00' };
		showModal({
			title: 'Edit schedule',
			body: 'Edit the schedule name and start time. Times are the bridge\u2019s local time.',
			fields: [
				{ id: 'edit-name', label: 'Name', value: item.name || '' },
				timeField
			],
			actions: [
				{ label: 'Save', primary: true, onclick: function (m) {
					var raw = m.querySelector('#edit-localtime').value;
					var newTime = usePicker ? (raw ? withNewTime(item.localtime, raw) : null) : raw;
					HueCore.updateSchedule(item.id,
						m.querySelector('#edit-name').value,
						newTime
					).then(function () { toast('Saved.', 'info'); })
					.catch(function (e) { toast(e.message || 'Save failed', 'error'); });
					closeModal(m);
				} },
				{ label: 'Cancel', onclick: function (m) { closeModal(m); } }
			]
		});
	}

	function openEditAutomation(item) {
		closeMenu();
		var fields = [{ id: 'edit-name', label: 'Name', value: item.name || '' }];
		var usePicker = false;
		if (item.starttime != null) {
			usePicker = !!(!isTimerTime(item.starttime) && extractHHMM(item.starttime));
			fields.push(usePicker
				? { id: 'edit-starttime', label: 'Start time (bridge local)', type: 'time', value: extractHHMM(item.starttime) }
				: { id: 'edit-starttime', label: 'Start time', value: item.starttime });
		}
		showModal({
			title: 'Edit automation',
			body: 'Edit the automation name' + (item.starttime != null ? ' and start time. Times are the bridge\u2019s local time.' : '.'),
			fields: fields,
			actions: [
				{ label: 'Save', primary: true, onclick: function (m) {
					var start = null;
					var timeInput = m.querySelector('#edit-starttime');
					if (item.starttime != null && timeInput) {
						start = usePicker ? (timeInput.value ? withNewTime(item.starttime, timeInput.value) : null) : timeInput.value;
					}
					HueCore.updateAutomation(item.id, m.querySelector('#edit-name').value, start)
					.then(function () { toast('Saved.', 'info'); })
					.catch(function (e) { toast(e.message || 'Save failed', 'error'); });
					closeModal(m);
				} },
				{ label: 'Cancel', onclick: function (m) { closeModal(m); } }
			]
		});
	}

	function renderMobileAutomations() {
		var app = $('app');
		clear(app);
		app.appendChild(renderHeader({ title: 'Automations', showBack: true }));
		var main = el('main');
		var viewDiv = el('div', { id: 'view' });
		viewDiv.appendChild(renderAutomationsBody());
		main.appendChild(viewDiv);
		app.appendChild(main);
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

		if (view === 'automations') return renderMobileAutomations();
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