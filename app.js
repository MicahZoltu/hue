/*
 * Hue SPA - desktop UI. Renders state from HueCore and wires up DOM events.
 * All state, persistence, and protocol logic lives in core.js / hue.js / color.js.
 *
 * State model (renderer-only):
 *   { expanded: { lightId: true } }   // which lights have color picker open
 *
 * On every HueCore 'state' event, renderAll() rebuilds the rooms column
 * and the selected-room panel. HueCore handles optimistic updates and
 * 400ms reconcile-after-mutation for us.
 */

(function () {
  'use strict';

  var rendererState = { expanded: {} };

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
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 4500);
  }

  // --- screen switching -------------------------------------------------

  function showConnect() {
    $('connect').style.display = 'block';
    $('dashboard').style.display = 'none';
    $('topbar').style.display = 'none';
  }
  function showDashboard(creds) {
    $('connect').style.display = 'none';
    $('dashboard').style.display = 'flex';
    $('topbar').style.display = 'flex';
    $('ip-indicator').textContent = creds.ip;
  }

  // --- connect flow (desktop) -------------------------------------------

  function setConnectStatus(msg) { $('connect-status').textContent = msg || ''; }

  function handleConnect() {
    var ip = $('ip-input').value.trim();
    if (!ip) { setConnectStatus('Enter the bridge IP address.'); return; }
    var btn = $('connect-btn');
    btn.disabled = true;
    setConnectStatus('Testing ' + ip + '…');
    HueCore.connectAndPair(ip, function (attempt, max) {
      var remaining = Math.max(0, Math.ceil((max - attempt) * 1.5));
      setConnectStatus('Waiting for link button press… ' + remaining + 's left');
    }).then(function () {
      setConnectStatus('');
      showDashboard(HueCore.getState().creds);
    }).catch(function (err) {
      setConnectStatus(err.message || 'Could not reach the bridge.');
    }).then(function () { btn.disabled = false; });
  }

  function handleImport() {
    var raw = $('import-input').value.trim();
    if (!raw) { setConnectStatus('Paste credentials JSON first.'); return; }
    HueCore.importCreds(raw).then(function () {
      setConnectStatus('');
      showDashboard(HueCore.getState().creds);
    }).catch(function (err) {
      setConnectStatus(err.message || 'Credentials did not work.');
    });
  }

  // --- color helpers for swatches ---------------------------------------

  function swatchForLight(light) {
    var s = light.state || {};
    if (s.xy) return HueColor.xyBriToRgb(s.xy[0], s.xy[1], s.bri != null ? s.bri : 254);
    if (s.ct) return HueColor.miredToRgb(s.ct);
    if (s.on) return '255,233,191';
    return '50,50,50';
  }

  // --- rendering --------------------------------------------------------

  function lightsInGroup(g, lights) {
    return lights.filter(function (l) { return g.lights.indexOf(String(l.id)) >= 0; });
  }

  function renderRooms(groups, lights) {
    var root = $('rooms-list');
    clear(root);
    if (groups.length === 0) {
      root.appendChild(el('div', { class: 'empty', text: 'No rooms. Create one in the Hue app first.' }));
      return;
    }
    groups.forEach(function (g) { root.appendChild(renderRoomTile(g, lights)); });
  }

  function renderSwatchStrip(lights) {
    if (!lights.length) return null;
    var strip = el('div', { class: 'swatch-strip' });
    lights.slice(0, 4).forEach(function (l) {
      strip.appendChild(el('div', { style: 'background: rgb(' + swatchForLight(l) + ');' }));
    });
    return strip;
  }

  function renderRoomTile(g, lights) {
    var inGroup = lightsInGroup(g, lights);
    var anyOn = g.state && g.state.any_on;
    var bri = g.action && g.action.bri != null ? g.action.bri : 254;
    var selected = HueCore.getSelectedRoomId() === g.id;

    var briInput = el('input', {
      type: 'range', min: 0, max: 254, value: bri,
      onclick: function (e) { e.stopPropagation(); }
    });
    briInput.addEventListener('input', debounceEvent(function () {
      HueCore.setGroupBri(g.id, Number(briInput.value));
    }, 150));

    return el('div', {
      class: 'room-tile' + (selected ? ' selected' : ''),
      onclick: function () { HueCore.setSelectedRoomId(g.id); }
    }, [
      el('div', { class: 'row1' }, [
        el('span', { class: 'name', text: g.name }),
        el('input', {
          type: 'checkbox',
          checked: !!anyOn,
          onclick: function (e) {
            e.stopPropagation();
            HueCore.toggleGroup(g.id, e.target.checked);
          }
        })
      ]),
      renderSwatchStrip(inGroup),
      el('div', { class: 'bri-row' }, [briInput])
    ]);
  }

  function renderPanel(groups, lights, scenes, selectedRoomId) {
    var root = $('panel');
    clear(root);
    if (!selectedRoomId) {
      root.appendChild(el('div', { id: 'empty', text: 'Select a room on the left.' }));
      return;
    }
    var g = groups.find(function (x) { return x.id === selectedRoomId; });
    if (!g) {
      root.appendChild(el('div', { id: 'empty', text: 'Room not found.' }));
      return;
    }
    var inGroup = lightsInGroup(g, lights);
    root.appendChild(el('div', { id: 'panel-header' }, [
      el('h2', { text: g.name }),
      el('span', { class: 'meta', text: inGroup.length + ' lights' })
    ]));
    if (inGroup.length === 0) {
      root.appendChild(el('div', { id: 'empty', text: 'No lights in this room.' }));
    } else {
      var grid = el('div', { class: 'lights-grid' });
      inGroup.forEach(function (l) { grid.appendChild(renderLightCard(l)); });
      root.appendChild(grid);
    }
    root.appendChild(renderScenesRow(g, scenes));
  }

  function renderLightCard(light) {
    var s = light.state || {};
    var on = !!s.on;
    var bri = s.bri != null ? s.bri : 254;
    var reachable = s.reachable !== false;
    var supportsXY = !!s.xy;
    var supportsCT = !!s.ct && !supportsXY;

    var briInput = el('input', {
      type: 'range', min: 0, max: 254, value: bri
    });
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
      el('div', { class: 'bri' }, [briInput])
    ]);

    if (supportsXY || supportsCT) {
      var isOpen = !!rendererState.expanded[light.id];
      var toggle = el('button', {
        class: 'toggle-details',
        text: isOpen ? 'Hide color' : 'Show color',
        onclick: function () {
          rendererState.expanded[light.id] = !isOpen;
          renderPanel(HueCore.getGroups(), HueCore.getLights(), HueCore.getScenes(), HueCore.getSelectedRoomId());
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

  function renderScenesRow(g, scenes) {
    var inGroup = scenes.filter(function (s) { return s.group === g.id; });
    var row = el('div', { id: 'scenes-row' }, [el('h3', { text: 'Scenes' })]);
    if (inGroup.length === 0) {
      row.appendChild(el('div', { class: 'empty', text: 'No scenes for this room.' }));
    } else {
      var list = el('div', { class: 'scenes-list' });
      inGroup.forEach(function (s) {
        list.appendChild(el('button', {
          class: 'scene-btn',
          text: s.name,
          onclick: function () { HueCore.activateScene(g.id, s.id); }
        }));
      });
      row.appendChild(list);
    }
    return row;
  }

  // --- mutations through HueCore (optimistic updates live in core) -----

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

  // --- menu / modal -----------------------------------------------------

  function toggleMenu() { $('menu').classList.toggle('open'); }
  function closeMenu() { $('menu').classList.remove('open'); }

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

  // --- bootstrap --------------------------------------------------------

  function renderAll() {
    var s = HueCore.getState();
    renderRooms(s.groups, s.lights);
    renderPanel(s.groups, s.lights, s.scenes, s.selectedRoomId);
  }

  function init() {
    $('connect-btn').addEventListener('click', handleConnect);
    $('import-btn').addEventListener('click', handleImport);
    $('ip-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') handleConnect();
    });

    $('refresh-btn').addEventListener('click', function () {
      if (!HueCore.getState().creds) return;
      HueCore.refreshAll().catch(function (err) { toast(err.message || 'Refresh failed', 'error'); });
    });
    $('menu-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    $('export-btn').addEventListener('click', openExport);
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#menu-wrap')) closeMenu();
    });

    HueCore.on('state', renderAll);
    HueCore.on('error', function (e) { toast(e.message || 'Error', 'error'); });

    HueCore.tryRestoreSession().then(function () {
      showDashboard(HueCore.getState().creds);
    }).catch(function () {
      showConnect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
