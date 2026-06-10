# Hue Controller

A zero-dependency app for controlling Philips Hue lights through a local Hue Bridge. Open `index.html` in your browser — no server, no install, no build, no internet required after pairing.

## What it does

- View all rooms/zones configured in the Hue app
- Toggle rooms and individual lights on/off
- Per-light brightness slider; per-room master brightness slider
- Color picker (Hue / Saturation / Brightness sliders) for color-capable lights
- Color temperature slider (mired) for CT-capable lights
- Activate any GroupScene for a room
- Export / import credentials as JSON (move a working connection to another browser or device without re-pairing)
- Live color swatch preview on lights and rooms using CIE 1931 xy→RGB

## Mobile

`mobile.html` has the same feature set, styled for a mobile device, and can be installed as a PWA on Android Chrome. To install, serve the `hue/` directory over HTTP from a computer on the same Wi-Fi as the bridge, then visit `http://<your-computer-ip>:8000/mobile.html` on the phone. From one directory above `hue/`, run:

```
bunx serve hue/
# or:  python3 -m http.server 8000 --directory hue/
```

## If you see "Could not reach the bridge"

The bridge uses a self-signed HTTPS certificate that the browser doesn't trust. Open `https://<ip>/` in a browser, accept the cert warning once, then try the app again.
