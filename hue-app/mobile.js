/*
 * Hue Mobile UI. Renders state from HueCore and wires up DOM events.
 *
 * Views (mobile-internal, not in HueCore):
 *   'connect' | 'groups' | 'group' | 'error' | 'cert-error'
 *
 * Once HueCore has creds, the user cannot navigate back to the connect screen from inside the app.
 * If creds become invalid, we show a full-screen error and instruct the user to clear browser data.
 * The 'cert-error' view handles HTTPS-context TLS errors specifically and is non-terminal: it has a Retry button that re-tests the bridge after the user accepts the cert in the address bar.
 */

(function () {
  'use strict';

  var view = 'connect';
  var errorMessage = null;
  var lastAttemptedIp = null;  // remembered for pre-filling the input after a cert-error retry

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

  // --- toast ------------------------------------------------------------

  var toastTimer = null;
  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = type || 'info';
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }

  // --- navigation (History API for device back button) ------------------

  // Every user-driven view change goes through goToView, which pushes
  // a history entry. The browser back button (hardware on Android,
  // gesture where supported) fires popstate, which our handler catches
  // and uses to navigate. Forward works symmetrically.
  //
  // The popstate handler is the only place that sets `view` without
  // calling history.pushState. init() seeds the initial entry with
  // replaceState so the first pop also has a state object to read.

  function goToView(name, extra) {
    if (name === view) {
      // Same view, but the groupId may differ. If so, push.
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
    // The browser's pop will fire our popstate handler, which is what
    // actually navigates. We don't set view here.
    try { history.back(); }
    catch (e) {
      // Fallback: no history available, just go to groups directly.
      view = 'groups';
      render();
    }
  }

  // --- connect view -----------------------------------------------------

  function renderConnect() {
    view = 'connect';
    var app = $('app');
    clear(app);
    app.appendChild(renderGroupsHeader());

    var main = el('main');
    var section = el('section', { id: 'connect-view' });

    var card = el('div', { class: 'connect-card' });
    card.appendChild(el('h2', { text: 'Connect to your Hue Bridge' }));
    card.appendChild(el('p', { text: 'Enter the IP address of your Philips Hue Bridge.' }));
    card.appendChild(el('p', { text: 'After tapping Connect, press the round link button on the bridge within 30 seconds. The app will pick up the new username automatically.' }));

    var ipInput = el('input', { id: 'ip-input', type: 'text', placeholder: '192.168.1.42', spellcheck: 'false', autocomplete: 'off' });
    if (lastAttemptedIp) ipInput.value = lastAttemptedIp;
    card.appendChild(ipInput);

    var connectBtn = el('button', { id: 'connect-btn', class: 'primary', text: 'Connect & pair' });
    connectBtn.addEventListener('click', handleConnect);
    card.appendChild(el('div', { class: 'row' }, [connectBtn]));

    var status = el('div', { id: 'connect-status', class: 'status' });
    card.appendChild(status);

    var details = el('details');
    var summary = el('summary', { text: 'Have existing credentials? Import them' });
    var importP = el('p', { text: 'Paste the JSON from the desktop app\u2019s Export credentials option.' });
    var importInput = el('textarea', { id: 'import-input', placeholder: '{"ip":"192.168.1.42","token":"..."}', spellcheck: 'false' });
    var importBtn = el('button', { id: 'import-btn', text: 'Import & connect' });
    importBtn.addEventListener('click', handleImport);
    details.appendChild(summary);
    details.appendChild(importP);
    details.appendChild(importInput);
    details.appendChild(el('div', { class: 'row' }, [importBtn]));
    card.appendChild(details);

    section.appendChild(card);
    main.appendChild(section);
    app.appendChild(main);

    ipInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleConnect(); });
    ipInput.focus();
  }

  function setConnectStatus(msg) {
    var s = $('connect-status');
    if (s) s.textContent = msg || '';
  }

  function handleConnect() {
    var ipInput = $('ip-input');
    var ip = ipInput.value.trim();
    if (!ip) { setConnectStatus('Enter the bridge IP address.'); return; }
    var btn = $('connect-btn');
    btn.disabled = true;
    setConnectStatus('Testing ' + ip + '\u2026');
    lastAttemptedIp = ip;
    HueCore.connectAndPair(ip, function (attempt, max) {
      var remaining = Math.max(0, Math.ceil((max - attempt) * 1.5));
      setConnectStatus('Waiting for link button press\u2026 ' + remaining + 's left');
    }).then(function () {
      errorMessage = null;
      goToView('groups');
    }).catch(function (err) {
      setConnectStatus(err.message || 'Could not reach the bridge.');
      btn.disabled = false;
    });
  }

  function handleImport() {
    var raw = $('import-input').value.trim();
    if (!raw) { setConnectStatus('Paste credentials JSON first.'); return; }
    HueCore.importCreds(raw).then(function () {
      errorMessage = null;
      goToView('groups');
    }).catch(function (err) {
      setConnectStatus(err.message || 'Credentials did not work.');
    });
  }

  // --- error view (post-failure, no way back) ---------------------------

  function renderError(msg) {
    view = 'error';
    errorMessage = msg;
    var app = $('app');
    clear(app);
    app.appendChild(renderGroupsHeader());
    var main = el('main');
    var section = el('section', { id: 'error-view' });
    section.appendChild(el('div', { class: 'icon', text: '\u26A0' }));
    section.appendChild(el('h2', { text: 'Could not connect' }));
    section.appendChild(el('p', { text: msg || 'Something went wrong reaching the bridge.' }));
    section.appendChild(el('p', { style: 'margin-top:16px;', text: 'Clear your browser data to start over and re-pair.' }));
    main.appendChild(section);
    app.appendChild(main);
  }

  // --- cert error view (HTTPS + self-signed cert) -----------------------

  function renderCertError() {
    view = 'cert-error';
    var s = HueCore.getState();
    var ip = (s.certError && s.certError.ip) || (s.creds && s.creds.ip) || lastAttemptedIp || '';

    var app = $('app');
    clear(app);
    app.appendChild(renderGroupsHeader());

    var main = el('main');
    var section = el('section', { id: 'cert-view' });
    section.appendChild(el('div', { class: 'icon', text: '\u26A0' }));
    section.appendChild(el('h2', { text: 'Bridge certificate needed' }));
    section.appendChild(el('p', { text: 'The Hue Bridge uses a self-signed HTTPS certificate that this app doesn\u2019t recognize. The connection can\u2019t complete until the certificate is trusted.' }));

    if (ip) {
      var openBtn = el('button', { class: 'primary', text: 'Open bridge page' });
      openBtn.addEventListener('click', function () {
        window.open('https://' + ip + '/', '_blank');
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
        el('span', { class: 'ip', text: 'https://' + ip + '/certificate' }),
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

  // --- header (groups / group views) -----------------------------------

  function makeRefreshButton() {
    var refresh = el('button', { id: 'refresh-btn', title: 'Refresh' });
    refresh.innerHTML = '&#x21bb;';
    refresh.addEventListener('click', function () {
      if (!HueCore.getState().creds) return;
      HueCore.refreshAll().catch(function (err) { toast(err.message || 'Refresh failed', 'error'); });
    });
    return refresh;
  }

  function renderGroupsHeader() {
    var header = el('header', { id: 'header' });
    header.appendChild(el('h1', { text: 'Hue' }));
    header.appendChild(makeRefreshButton());
    return header;
  }

  function renderGroupHeader(groupName) {
    var header = el('header', { id: 'header' });
    var back = el('button', { id: 'back-btn-header', type: 'button' });
    back.innerHTML = '<span class="chev">&#x2039;</span>';
    back.addEventListener('click', goBack);
    header.appendChild(back);
    header.appendChild(el('h1', { class: 'left', text: groupName }));
    header.appendChild(makeRefreshButton());
    return header;
  }

  // --- groups list view -------------------------------------------------

  function renderGroupsView() {
    view = 'groups';
    var app = $('app');
    clear(app);
    app.appendChild(renderGroupsHeader());
    var main = el('main');
    var view2 = el('div', { id: 'view' });

    var state = HueCore.getState();
    if (state.groups.length === 0) {
      view2.appendChild(el('div', { id: 'empty', text: 'No rooms yet. Create one in the Hue app first.' }));
    } else {
      var list = el('div', { id: 'groups-list' });
      state.groups.forEach(function (g) { list.appendChild(renderGroupCard(g, state.lights)); });
      view2.appendChild(list);
    }

    main.appendChild(view2);
    app.appendChild(main);
  }

  function renderGroupCard(g, lights) {
    var inGroup = lightsInGroup(g, lights);
    var anyOn = g.state && g.state.any_on;

    var card = el('button', { class: 'group-card', type: 'button' });
    card.addEventListener('click', function () {
      goToView('group', { groupId: g.id });
    });

    card.appendChild(el('span', { class: 'name', text: g.name }));

    // Small swatch strip of the room's light colors (purely visual, non-interactive)
    if (inGroup.length) {
      var strip = el('div', { class: 'swatch-strip' });
      inGroup.slice(0, 4).forEach(function (l) {
        strip.appendChild(el('div', { style: 'background: rgb(' + swatchForLight(l) + ');' }));
      });
      card.appendChild(strip);
    }

    // Non-interactive status dot
    card.appendChild(el('span', { class: 'dot' + (anyOn ? ' on' : '') }));

    return card;
  }

  // --- group detail view -----------------------------------------------

  function renderGroupView() {
    view = 'group';
    var state = HueCore.getState();
    var g = state.groups.find(function (x) { return x.id === state.selectedRoomId; });
    if (!g) {
      // Selected group was deleted, fall back
      goToView('groups');
      return;
    }
    var lights = lightsInGroup(g, state.lights);
    var scenes = state.scenes.filter(function (s) { return s.group === g.id; });

    var app = $('app');
    clear(app);
    app.appendChild(renderGroupHeader(g.name));

    var main = el('main');
    var viewDiv = el('div', { id: 'view' });

    // Scenes
    var scenesSection = el('div', { class: 'section' });
    scenesSection.appendChild(el('h3', { text: 'Scenes' }));
    var scenesRow = el('div', { id: 'scenes-row' });
    if (scenes.length === 0) {
      scenesRow.appendChild(el('div', { class: 'empty', text: 'No scenes for this room.' }));
    } else {
      scenes.forEach(function (s) {
        var pill = el('button', { class: 'scene-pill', type: 'button', text: s.name });
        pill.addEventListener('click', function () {
          HueCore.activateScene(g.id, s.id);
        });
        scenesRow.appendChild(pill);
      });
    }
    scenesSection.appendChild(scenesRow);
    viewDiv.appendChild(scenesSection);

    // Group controls (on/off + brightness)
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

    // Lights list
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

  function renderLightCard(light) {
    var s = light.state || {};
    var on = !!s.on;
    var bri = s.bri != null ? s.bri : 254;
    var reachable = s.reachable !== false;

    var briInput = el('input', { type: 'range', min: 0, max: 254, value: bri });
    briInput.addEventListener('input', debounceEvent(function () {
      HueCore.setLightBri(light.id, Number(briInput.value));
    }, 150));

    var card = el('div', { class: 'light-card' + (reachable ? '' : ' unreachable') });
    card.appendChild(el('div', { class: 'row1' }, [
      el('div', { class: 'name', text: light.name }),
      !reachable ? el('span', { class: 'badge', text: 'unreachable' }) : null,
      el('input', { type: 'checkbox', checked: on, onchange: function (e) { HueCore.toggleLight(light.id, e.target.checked); } })
    ]));
    card.appendChild(briInput);
    return card;
  }

  // --- helpers ---------------------------------------------------------

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

  // --- render dispatch --------------------------------------------------

  function render() {
    if (view === 'cert-error') return renderCertError();
    if (view === 'connect') return renderConnect();
    if (view === 'error')   return renderError(errorMessage);
    var s = HueCore.getState();
    if (!s.creds) return renderConnect();
    if (view === 'group' && s.selectedRoomId) return renderGroupView();
    return renderGroupsView();
  }

  // --- bootstrap --------------------------------------------------------

  function init() {
    HueCore.on('state', function () {
      // Re-render on any state change. If we're on the error screen, stay.
      if (view === 'error') return;
      // If creds disappeared (shouldn't happen on mobile, but be safe), go to connect
      if (!HueCore.getState().creds) { view = 'connect'; try { history.replaceState({ view: 'connect' }, ''); } catch (e) {} render(); return; }
      render();
    });
    HueCore.on('error', function (e) { toast(e.message || 'Error', 'error'); });
    HueCore.on('cert-error', function (e) {
      // Switch to the cert-error view whenever HueCore flags a cert problem. The Retry button on that view will clear it.
      if (e && e.ip) lastAttemptedIp = e.ip;
      view = 'cert-error';
      try { history.pushState({ view: 'cert-error' }, ''); } catch (err) {}
      render();
    });

    // Hardware back button + browser forward: popstate fires for both.
    window.addEventListener('popstate', function (e) {
      var state = e.state;
      if (!state) {
        // First/oldest entry has no state. Fall back to a sensible view.
        view = HueCore.getState().creds ? 'groups' : 'connect';
      } else {
        view = state.view;
        if (state.groupId) HueCore.setSelectedRoomId(state.groupId);
      }
      render();
    });

    HueCore.tryRestoreSession().then(function () {
      view = 'groups';
      try { history.replaceState({ view: 'groups' }, ''); } catch (e) {}
      render();
    }).catch(function (err) {
      // If HueCore already flagged a cert error, the cert-error listener has switched the view. Otherwise fall through to normal handling.
      if (HueCore.getState().certError) return;
      if (err && err.code === 'NO_CREDS') {
        view = 'connect';
        try { history.replaceState({ view: 'connect' }, ''); } catch (e) {}
        render();
      } else {
        // Saved creds were rejected or bridge unreachable
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
