/*
 * Color helpers for the Hue SPA.
 *
 * - xyBriToRgb: CIE 1931 xy + brightness -> sRGB (for tile preview swatches).
 * - miredToRgb: color temperature in mireds -> sRGB (for CT-only lights).
 * - hsvToRgb:   simple H/S/V -> sRGB (for live preview as the user drags sliders).
 * - hsbToBridge: maps the 0-360 / 0-100 / 0-100 slider values to the Hue
 *               bridge's hue (0-65535), sat (0-254), bri (0-254).
 *
 * Gamut clamping uses Gamut C, which covers all current Philips color bulbs
 * (Living Colors Bloom, Iris, LightStrip Plus, Hue color bulbs). The
 * per-modelid lookup table is intentionally omitted for v1.
 *
 * All "rgb" return values are plain "R,G,B" strings ready to drop into
 * `rgb(...)` CSS color values.
 */

(function (global) {
  'use strict';

  var GAMUT_C = {
    red:   [0.692, 0.308],
    green: [0.17,  0.700],
    blue:  [0.153, 0.048]
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function pad(n) {
    var s = String(Math.round(n));
    return s.length < 2 ? '0' + s : s;
  }

  function rgbToCss(r, g, b) {
    return Math.round(clamp(r, 0, 255)) + ','
         + Math.round(clamp(g, 0, 255)) + ','
         + Math.round(clamp(b, 0, 255));
  }

  // --- HSV -> sRGB (for live slider preview) -------------------------------

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100) / 100;
    v = clamp(v, 0, 100) / 100;
    var c = v * s;
    var hh = h / 60;
    var x = c * (1 - Math.abs((hh % 2) - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if      (hh < 1) { r1 = c; g1 = x; b1 = 0; }
    else if (hh < 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hh < 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hh < 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hh < 5) { r1 = x; g1 = 0; b1 = c; }
    else             { r1 = c; g1 = 0; b1 = x; }
    var m = v - c;
    return rgbToCss((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
  }

  // --- mired -> sRGB (Tanner Helland's approximation of black-body color) -

  function miredToRgb(mired) {
    if (mired == null || isNaN(mired)) return '255,233,191';
    var kelvin = 1000000 / mired;
    var t = kelvin / 100;
    var r, g, b;

    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(t) - 161.1195681661;
      if (t <= 19) {
        b = 0;
      } else {
        b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
      }
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }

    return rgbToCss(r, g, b);
  }

  // --- CIE 1931 xy + Y -> sRGB --------------------------------------------
  // Reference: https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/

  function reverseGamma(v) {
    return v <= 0.0031308 ? 12.92 * v : (1 + 0.055) * Math.pow(v, 1 / 2.4) - 0.055;
  }

  function xyInGamut(x, y, gamut) {
    var v0 = [gamut.blue[0] - gamut.red[0], gamut.blue[1] - gamut.red[1]];
    var v1 = [gamut.green[0] - gamut.red[0], gamut.green[1] - gamut.red[1]];
    var v2 = [x - gamut.red[0], y - gamut.red[1]];
    var d00 = v0[0]*v0[0] + v0[1]*v0[1];
    var d01 = v0[0]*v1[0] + v0[1]*v1[1];
    var d02 = v0[0]*v2[0] + v0[1]*v2[1];
    var d11 = v1[0]*v1[0] + v1[1]*v1[1];
    var d12 = v1[0]*v2[0] + v1[1]*v2[1];
    var inv = 1 / (d00 * d11 - d01 * d01);
    var u = (d11 * d02 - d01 * d12) * inv;
    var v = (d00 * d12 - d01 * d02) * inv;
    return u >= 0 && v >= 0 && (u + v) < 1;
  }

  function closestPointOnSegment(xy, a, b) {
    var ax = xy.x - a[0], ay = xy.y - a[1];
    var bx = b[0] - a[0], by = b[1] - a[1];
    var len2 = bx*bx + by*by;
    var t = (ax*bx + ay*by) / len2;
    t = clamp(t, 0, 1);
    return { x: a[0] + bx * t, y: a[1] + by * t };
  }

  function clampToGamut(x, y, gamut) {
    var pts = [
      closestPointOnSegment({x:x,y:y}, gamut.green, gamut.red),
      closestPointOnSegment({x:x,y:y}, gamut.green, gamut.blue),
      closestPointOnSegment({x:x,y:y}, gamut.red,   gamut.blue)
    ];
    var best = pts[0], bestD = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i].x - x, dy = pts[i].y - y;
      var d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = pts[i]; }
    }
    return [best.x, best.y];
  }

  function xyBriToRgb(x, y, bri) {
    if (x == null || y == null) return '255,233,191';
    if (!xyInGamut(x, y, GAMUT_C)) {
      var c = clampToGamut(x, y, GAMUT_C);
      x = c[0]; y = c[1];
    }
    var Y = clamp(bri, 0, 254) / 254;
    var z = 1.0 - x - y;
    var X = (Y / y) * x;
    var Z = (Y / y) * z;
    var r =  X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    var g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    var b =  X * 0.051713 - Y * 0.121364 + Z * 1.011530;
    r = reverseGamma(r);
    g = reverseGamma(g);
    b = reverseGamma(b);
    return rgbToCss(r * 255, g * 255, b * 255);
  }

  // --- Slider <-> bridge value mapping ------------------------------------

  function hsbToBridge(h, s, bri) {
    var H = Math.round(clamp(h, 0, 360) * 65535 / 360);
    var S = Math.round(clamp(s, 0, 100) * 254 / 100);
    var B = Math.round(clamp(bri, 0, 100) * 254 / 100);
    return { hue: H, sat: S, bri: B };
  }

  function bridgeToHsb(hue, sat, bri) {
    return {
      h: Math.round(hue * 360 / 65535),
      s: Math.round(sat * 100 / 254),
      b: Math.round(bri * 100 / 254)
    };
  }

  global.HueColor = {
    hsvToRgb:    hsvToRgb,
    xyBriToRgb:  xyBriToRgb,
    miredToRgb:  miredToRgb,
    hsbToBridge: hsbToBridge,
    bridgeToHsb: bridgeToHsb
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
