# PitPat Treadmill Web Dashboard

A web-based dashboard to control and monitor a PitPat treadmill via Bluetooth. Forked from [KeiranY/PitPat-WebBT](https://github.com/KeiranY/PitPat-WebBT) with a refreshed UI and a few quality-of-life additions.

## Features

- Connect, start/stop, pause, and adjust speed over Web Bluetooth
- Minimal, modern UI with automatic light/dark mode
- **KPH/MPH toggle** — re-bounds the slider, converts the target speed, and switches the treadmill's display unit
- **0% / 3% incline mode** — bumps calorie totals by ~30% at 3% (the treadmill itself doesn't adjust for the manual incline switch)
- **Monthly history calendar** — per-day distance and calories, click a day to see and delete individual sessions
- Import / export session history as JSON

## Prerequisites

- A browser supporting the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API#browser_compatibility) (Chrome, Edge, Opera, or other Chromium-based browsers)

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

> Note: clearing site data for `nathanlmeyers.github.io` in Chrome will wipe history. Importing the JSON restores it.
