# Hue Controller

A zero-dependency single-page app for controlling Philips Hue lights through a local Hue Bridge. Open `index.html` in your browser — no server, no install, no build, no internet required after pairing.

## What it does

- View all rooms/zones configured in the Hue app
- Toggle rooms and individual lights on/off
- Per-light brightness slider; per-room master brightness slider
- Color picker (Hue / Saturation / Brightness sliders) for color-capable lights
- Color temperature slider (mired) for CT-capable lights
- Activate any GroupScene for a room
- Export / import credentials as JSON (move a working connection to another browser or device without re-pairing)
- Live color swatch preview on lights and rooms using CIE 1931 xy→RGB

## How to run

Just double-click `index.html`. It opens via the `file://` protocol and works fully offline once paired. No web server required.

## Finding your bridge IP

The app needs the IP address of your Hue Bridge on the local network.

- **Hue mobile app** → Settings → My Hue System → the bridge → IP address.
- **Router admin** → DHCP client list, look for a device whose MAC starts with `00:17:88` (Philips).
- **mDNS** (macOS/Linux): `dns-sd -B _hue._tcp` or `avahi-browse -art _hue._tcp`.

## First-time pairing

1. Open `index.html`.
2. Type the bridge IP and click **Connect**. The bridge should respond.
3. Within 30 seconds, press the round **link button** on top of the physical bridge.
4. Click **Pair**. The app will poll the bridge once a second and pick up the new username as soon as the button is registered.
5. The credentials are stored in `localStorage` and you're in.

## Re-using credentials on another device

Use the **&#8943; menu → Export credentials** option. Copy the JSON, open the app in another browser, and paste it into **Import credentials** on the connect screen. No need to press the link button again.

## Single-file bundle

`build.js` is a Bun script that inlines `style.css`, `color.js`, `hue.js`, and `app.js` into a single self-contained `hue.html`, handy for emailing the app to someone. Run it with `bun build.js`. The script asks whether to bake in your bridge IP and token so the recipient can skip the connect flow: answer `y` and paste the JSON from the app's **Export credentials** option. The resulting `hue.html` still works offline via `file://` and is gitignored.

## Mobile variant

Open `mobile.html` on a phone. It uses the same protocol layer (`color.js`, `hue.js`) and the same shared `core.js` as the desktop, but renders a mobile-first UI: a list of room cards you tap into, then a per-room view with scenes at the top, a master on/off + brightness, and per-light on/off + brightness. No color picker per light — use scenes to set color. The in-app back button (round `<` in the top-left of the group view) and the device's hardware back button both work, via the History API. Once paired, the only way to reset is to clear your browser data; there is no Disconnect button. Pair and import-credentials work the same as on desktop.

## Browser / CORS notes

- All traffic to the bridge is plain HTTP. Modern Hue Bridge firmware (most bridges from ~2020 onward) sends CORS headers, so `fetch()` from this app works directly. If you see *"Could not reach the bridge"* but the IP is correct, your bridge's firmware may not be sending CORS headers — in that case try a different browser, or use the Hue app's remote API.
- HTTPS to the bridge is intentionally not supported (the bridge uses a self-signed certificate, which would require an extra "accept the cert" step on first use). If your bridge has HTTP disabled, see the Hue app's developer settings.
- No auto-discovery: the app does not phone home and does not call any cloud service. You must enter the bridge IP yourself.

## File structure

| File           | Purpose                                                          |
|----------------|------------------------------------------------------------------|
| `index.html`   | Desktop page shell, loads scripts as classic `<script>`          |
| `style.css`    | Desktop dark theme, flat class names, native form controls       |
| `color.js`     | CIE 1931 xy↔RGB, mired↔RGB, slider mapping                       |
| `hue.js`       | Bridge v1 ("CLIP") protocol layer (fetch wrappers)               |
| `core.js`      | Shared state, persistence, mutation logic, event bus             |
| `app.js`       | Desktop UI rendering and event wiring                            |
| `mobile.html`  | Mobile page shell                                                |
| `mobile.css`   | Mobile-first dark theme, fat-finger tap targets                 |
| `mobile.js`    | Mobile UI: groups list → group detail with scenes and lights     |
| `build.js`     | Optional: bundles desktop files into `hue.html`                 |

No build step required to run the app. `build.js` is optional and only used to produce the single-file bundle.

## Privacy

The app makes requests only to the IP address you enter (your local bridge). It does not call any other network endpoint. Credentials are stored in your browser's `localStorage` only.
