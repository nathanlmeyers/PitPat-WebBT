# PitPat Treadmill Web Dashboard

A web-based dashboard to control and monitor a PitPat treadmill via Bluetooth. Forked from [KeiranY/PitPat-WebBT](https://github.com/KeiranY/PitPat-WebBT) with a refreshed UI and a few quality-of-life additions.

## Features

- Connect, start/stop, pause, and adjust speed over Web Bluetooth
- Minimal dark instrument UI with an electric lime accent
- **KPH/MPH toggle** — re-bounds the slider and converts the readout. The treadmill's speed command is always metric internally, so the controller converts your chosen pace to the treadmill's native units before sending it
- **0% / 7% / Auto incline** — the deck's manual riser isn't reported over Bluetooth, but the motor works measurably less uphill. Set the toggle by hand for a minute or so at each setting and the app learns the motor load for that speed; **Auto** then detects the grade within ~30 s of walking. Calories and climb use the detected grade
- **Steps from the treadmill's real counter** — some firmware (37, for one) never fills the classic step field; the app reads the motor-side counter instead and only falls back to a height-based estimate when there is nothing to read
- **Monthly history calendar** — per-day distance and calories, click a day to see and delete individual sessions
- Import / export session history as JSON (import **merges**, so it never deletes what's already there)
- **Keyboard control** — ←/→ (or ↑) adjust speed, ↓ or Space pauses and resumes
- **Auto-reconnect** — if the Bluetooth link drops mid-workout, the app keeps the session open and reconnects rather than losing the run
- **Screen stays awake** while the belt is moving
- **Works offline** — nothing is fetched at runtime, and the installed app keeps working with no network
- **Data tab** — records every raw Bluetooth frame the treadmill sends, with a live hex view that highlights the bytes that change, and exports the capture for offline analysis

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

## Auto incline: how it works and how to calibrate

The pad has no tilt sensor. What it does send, twice a second, is a motor-current byte, and that byte sits lower on the 7% riser because gravity helps pull the belt uphill. Measured at 3.7 kph on one unit: about 40 on the flat versus 27 uphill, far too noisy per frame but a 30-second average separates the two cleanly.

The level depends on speed and on who is walking, so there is no fixed threshold. Instead:

1. Leave the incline toggle on **0%** or **7%**, matching where the deck really is, and walk at your usual speed for at least 30 seconds at each setting. The status line under the toggle shows what is being learned.
2. Switch the toggle to **Auto**. On the next walk the app listens for about 20 seconds after the belt settles, then shows the detected grade and uses it for calories and climb. Baselines live in **Settings → Incline calibration**, which also has a reset.

In manual mode the toggle is the label the calibration learns from, so keep it honest. Auto only works at speeds that have both baselines; the status line says when it doesn't.

## Data tab: capturing the raw stream

The treadmill sends far more per frame than the dashboard shows (target speed, an incline byte, firmware version, max speed, and on some firmware a tail of motor diagnostics). The **Data** tab records all of it so questions like "does this pad report its grade?" and "which step counter is closest to reality?" can be answered from data.

1. Connect, open **Data**, press **Record**. Frames stream in at whatever rate the treadmill sends them; the hex view shows the latest frame with changed bytes in bold.
2. Walk. Use the **Mark** box to label what you're doing (`counted 100 steps` at the end of a hand-counted stretch is the most useful marker). Flipping the incline or unit toggle writes a marker automatically.
3. Press **Export**. The capture is in memory only, so export before closing the tab.
4. Analyze it offline:

```sh
npm run analyze -- ~/Downloads/treadmill_capture_….json
```

The report lists the stream facts, every byte that moves, how far apart the 0% and 7% readings sit for each field at matched speeds, and how each step source compares against your hand count. Nothing is sent anywhere; the capture never leaves your machine unless you share the file.

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
| `lib/incline.js` | Motor-current grade detector and per-speed calibration |
| `lib/dates.js` | The slice of date-fns the calendar needed |
| `sw.js` | Service worker — offline shell |
| `tools/` | `analyze-capture.mjs` — offline report on a Data-tab export |
| `test/` | Unit tests for everything under `lib/` |

The `lib/` modules are pure — no DOM, no storage — which is what makes them testable. A unit-conversion bug once reached the hardware, so anything touching speed units, the packet checksum, or session records belongs there with a test.

Bumping the shell: the service worker serves from cache first and refreshes in the background, so a deploy lands on the *next* launch. Bump `CACHE_VERSION` in `sw.js` when a change must not be mixed with an older copy.
