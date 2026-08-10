# PitPat Treadmill Web Dashboard

A web-based dashboard to control and monitor a PitPat treadmill via Bluetooth. Forked from [KeiranY/PitPat-WebBT](https://github.com/KeiranY/PitPat-WebBT) with a refreshed UI and a few quality-of-life additions.

## Features

- Connect, start/stop, pause, and adjust speed over Web Bluetooth
- Minimal, modern UI with automatic light/dark mode
- **KPH/MPH toggle** — re-bounds the slider and converts the readout. The treadmill's speed command is always metric internally, so the controller converts your chosen pace to the treadmill's native units before sending it
- **0% / 7% incline mode** — bumps calorie totals by ~80% at 7% (the treadmill itself doesn't adjust for the manual incline switch)
- **Monthly history calendar** — per-day distance and calories, click a day to see and delete individual sessions
- Import / export session history as JSON (import **merges**, so it never deletes what's already there)
- **Keyboard control** — ←/→ (or ↑) adjust speed, ↓ or Space pauses and resumes
- **Auto-reconnect** — if the Bluetooth link drops mid-workout, the app keeps the session open and reconnects rather than losing the run
- **Screen stays awake** while the belt is moving
- **Works offline** — nothing is fetched at runtime, and the installed app keeps working with no network

## Prerequisites

- A browser supporting the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API#browser_compatibility) (Chrome, Edge, Opera, or other Chromium-based browsers)

Other browsers can still open the app to read and manage saved history; they just can't connect to the treadmill.

## Live Demo

[https://nathanlmeyers.github.io/PitPat-WebBT/](https://nathanlmeyers.github.io/PitPat-WebBT/)

## Install as a desktop app (macOS / Windows / Linux)

The dashboard is a PWA, so any Chromium-based browser can install it as a real desktop app with its own Dock / Start Menu icon and window.

1. Open the [live demo](https://nathanlmeyers.github.io/PitPat-WebBT/) in **Chrome**, **Edge**, **Brave**, or **Arc**.
2. Click the **install** icon at the right end of the address bar (a small monitor with a down-arrow). If you don't see it, open the **⋮** menu → **Cast, save, and share** → **Install page as app…**
3. Confirm. The app shows up in `/Applications` on macOS (or the Start Menu / Activities on Windows / Linux) and can be pinned to the Dock.

Web Bluetooth works inside the installed app exactly as it does in the browser. To uninstall: open the app → **⋮** menu → **Uninstall**.

## Session history & backup

Workout sessions are stored locally in your browser's `localStorage` under the origin `nathanlmeyers.github.io`. Nothing is sent to a server. The installed PWA shares this storage with Chrome, so history you build up in the browser shows up in the app and vice versa.

**Back up your history** (recommended periodically):

1. Open the **History** tab.
2. Click **Export** — saves `treadmill_sessions.json` to your Downloads folder.

**Restore from a backup** (e.g. after clearing site data, switching machines, or reinstalling the browser):

1. Open the **History** tab.
2. Click **Import** and pick the `treadmill_sessions.json` you previously exported.

Import merges into whatever is already stored, matching sessions on their timestamp. Anything you recorded since the backup was taken survives, and re-importing the same file twice is harmless. The toast reports how many were added versus already present.

> Note: clearing site data for `nathanlmeyers.github.io` in Chrome will wipe history. Importing the JSON restores it.

## Development

No build step and no runtime dependencies — the app is plain ES modules served as static files.

```sh
npm test          # node --test, no dependencies to install
npm run serve     # http://localhost:8000 (Web Bluetooth needs localhost or https)
```

Layout:

| Path | What's in it |
| --- | --- |
| `index.html`, `styles.css` | Markup and styles |
| `treadmill.js` | App shell — DOM refs, state, event wiring |
| `lib/protocol.js` | BLE UUIDs, notification decoding, command frames |
| `lib/units.js` | Conversions, slider ranges, ACSM / stride math |
| `lib/sessions.js` | Session sanitizing, merging, aggregation |
| `lib/dates.js` | The slice of date-fns the calendar needed |
| `sw.js` | Service worker — offline shell |
| `test/` | Unit tests for everything under `lib/` |

The `lib/` modules are pure — no DOM, no storage — which is what makes them testable. A unit-conversion bug once reached the hardware, so anything touching speed units, the packet checksum, or session records belongs there with a test.

Bumping the shell: the service worker serves from cache first and refreshes in the background, so a deploy lands on the *next* launch. Bump `CACHE_VERSION` in `sw.js` when a change must not be mixed with an older copy.
