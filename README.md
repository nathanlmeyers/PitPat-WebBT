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

In Chrome (or Edge / Brave / Arc), open the live demo and click the **install** icon in the address bar — or open the ⋮ menu and pick **Cast, save, and share → Install page as app…**. You'll get a real app icon in your Dock / Start Menu / Activities with its own window. Web Bluetooth still works inside the installed app, and your session history is the same `localStorage` data the browser uses.
