// =============================================================================
// PitPat Treadmill Web Dashboard
//
// Loaded as `<script type="module">` from index.html. This file is the shell:
// DOM refs, mutable app state, and event wiring. The logic worth testing lives
// in ./lib as pure modules:
//
//   lib/protocol.js  — BLE UUIDs, notification decoding, command frames
//   lib/units.js     — conversions, slider ranges, ACSM / stride math
//   lib/sessions.js  — session sanitizing, merging, aggregation
//   lib/dates.js     — the slice of date-fns the calendar needed
//
// Sections in this file:
//   1.  Config & DOM refs
//   2.  State
//   3.  Storage
//   4.  Unit-bound wrappers
//   5.  Bluetooth (connect, reconnect, notifications)
//   6.  Session tracking
//   7.  Display (dashboard, chart, slider, status)
//   8.  History (calendar, day detail, import/export)
//   9.  Wake lock
//  10.  Wiring & init
// =============================================================================

import {
    SERVICE_UUID, NOTIFY_CHAR_UUID, WRITE_CHAR_UUID,
    STATE, HEARTBEAT, decodeNotification, makePacket,
} from './lib/protocol.js';

import {
    KM_PER_MI, LB_PER_KG, CM_PER_IN, FT_PER_M,
    INCLINE_GRADE, SPEED_RANGE,
    unitOfDistance as unitOfDistanceFor,
    convertDistance, userToKU as userToKUFor, kuToUser as kuToUserFor,
    formatDuration, adjustCalories as adjustCaloriesFor,
    estimateKcalPerMin, strideMeters,
} from './lib/units.js';

import {
    normalizeSession as normalizeSessionFor, mergeSessions,
    isJunkSession, aggregateByDay, lifetimeTotals,
} from './lib/sessions.js';

import {
    format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths,
    dayKey, startOfThisMonth,
} from './lib/dates.js';


// ---- 1. Config & DOM refs -------------------------------------------------

const PREF_UNIT    = 'treadmill_unit';
const PREF_INCLINE = 'treadmill_incline';
const SESSIONS_KEY = 'treadmill_sessions';
const PROFILE_KEY  = 'treadmill_profile';

/** How often the in-progress session is written to localStorage. The dashboard
 *  still updates every notification (~1 Hz) from in-memory state; only the
 *  persist + calendar rebuild are throttled, since both are O(history). */
const PERSIST_INTERVAL_MS = 10_000;

/** Backoff schedule for reconnecting after an unexpected BLE drop (~30s). */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

const $ = id => document.getElementById(id);

const connectBtn         = $('connectBtn');
const distanceDiv        = $('distance');
const caloriesDiv        = $('calories');
const stepsDiv           = $('steps');
const durationDiv        = $('duration');
const startBtn           = $('startBtn');
const stopBtn            = $('stopBtn');
const speedUpBtn         = $('speedUpBtn');
const speedDownBtn       = $('speedDownBtn');
const speedSlider        = $('speedSlider');
const sliderValue        = $('sliderValue');
const sliderUnit         = $('sliderUnit');
const statusChip         = $('statusChip');
const unsupportedNotice  = $('unsupportedNotice');
const loadingOverlay     = $('loadingOverlay');
const countdownOverlay   = $('countdownOverlay');
const countdownNumber    = $('countdownNumber');
const importHistoryBtn   = $('importHistoryBtn');
const exportHistoryBtn   = $('exportHistoryBtn');
const importHistoryInput = $('importHistoryInput');
const toastEl            = $('toast');
const unitToggles        = document.querySelectorAll('[data-role="unitToggle"]');
const inclineToggle      = $('inclineToggle');
const calGrid            = $('calGrid');
const calMonth           = $('calMonth');
const prevMonthBtn       = $('prevMonthBtn');
const nextMonthBtn       = $('nextMonthBtn');
const dayDetail          = $('dayDetail');
const settingsBtn        = $('settingsBtn');
const settingsModal      = $('settingsModal');
const weightInput        = $('weightInput');
const heightInput        = $('heightInput');
const weightUnitToggle   = $('weightUnitToggle');
const heightUnitToggle   = $('heightUnitToggle');
const settingsCancelBtn  = $('settingsCancelBtn');
const settingsSaveBtn    = $('settingsSaveBtn');
const tileChecks = {
    distance: $('tileDistance'),
    calories: $('tileCalories'),
    steps:    $('tileSteps'),
    duration: $('tileDuration'),
};
const sessionChart       = $('sessionChart');
const presetRow          = $('presetRow');
const lifeDistance       = $('lifeDistance');
const lifeClimb          = $('lifeClimb');
const lifeSteps          = $('lifeSteps');
const tabs   = document.querySelectorAll('.tab');
const panels = { controls: $('controls-panel'), history: $('history-panel') };


// ---- 2. State -------------------------------------------------------------

let unitMode    = localStorage.getItem(PREF_UNIT)    === 'mph' ? 'mph' : 'kph';
let inclineMode = localStorage.getItem(PREF_INCLINE) === String(INCLINE_GRADE) ? INCLINE_GRADE : 0;

let device = null, server = null, notifyChar = null, writeChar = null;
let connected = false;
let runningState = STATE.STOPPED;
let curTargetSpeed = 1000;  // treadmill speed command — kph × 1000 (unit-independent)

let pendingCommand = null;  // queued packet, sent on next notification tick

let userDisconnect = false; // true while a disconnect the user asked for is in flight
let reconnectTimer = null;

/**
 * The in-progress session, or null.
 *
 * `baseline` is captured at the first running notification and never changes;
 * `latest` is overwritten every tick. All session totals are latest − baseline.
 * The treadmill's duration counter is cumulative across runs, and the other
 * counters may be too — subtracting a baseline is correct either way, and
 * clamping at zero covers the case where the firmware resets a counter
 * mid-session. (Previously only duration was baselined, while distance / steps
 * / calories were stored raw under start-sounding names.)
 *
 * @type {{ date: number,
 *          baseline: {duration:number, distance:number, steps:number, calories:number},
 *          latest:   {duration:number, distance:number, steps:number, calories:number},
 *          prevDuration: number, speedSum: number, speedCount: number,
 *          estKcal: number, estSteps: number,
 *          samples: Array<{kph:number, incline:number, steps:number}> } | null}
 */
let session = null;

/** The most recent completed session, kept so the dashboard keeps showing its
 *  totals after Stop instead of falling back to the treadmill's cumulative
 *  lifetime counters. */
let lastFinished = null;

let lastPersistAt = 0;
let historyDirty = false;

let calViewDate = startOfThisMonth();
let selectedDayKey = null;

let profile = loadProfile();
let wakeLock = null;
let toastTimer = null;

const bluetoothSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth;


// ---- 3. Storage -----------------------------------------------------------

function loadSessions() {
    try {
        const s = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
        return Array.isArray(s) ? s : [];
    } catch { return []; }
}

/** @returns {boolean} whether the write actually landed — callers must not
 *  report success without checking. */
function saveSessions(sessions) {
    try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        return true;
    } catch (err) {
        // Quota exceeded or storage disabled — don't take the session down with it.
        console.error('Could not save sessions:', err);
        showToast('Could not save history (storage full?)');
        return false;
    }
}

function deleteSessionByDate(dateTs) {
    saveSessions(loadSessions().filter(s => s.date !== dateTs));
    if (lastFinished?.date === dateTs) {
        // Don't leave the dashboard showing totals the user just deleted.
        lastFinished = null;
        updateDashboard();
    }
    flushHistoryRender();
}

/**
 * User body profile for calorie/step estimates. `weightKg`/`heightCm` are
 * null until the user enters them (firmware numbers shown until then);
 * `weightUnit`/`heightUnit` only remember the last input unit for redisplay.
 */
function loadProfile() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}; } catch {}
    const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
    const t = p.tiles && typeof p.tiles === 'object' ? p.tiles : {};
    const onByDefault = k => t[k] !== false;   // missing → shown
    return {
        weightKg:   num(p.weightKg),
        heightCm:   num(p.heightCm),
        weightUnit: p.weightUnit === 'lb' ? 'lb' : 'kg',
        heightUnit: p.heightUnit === 'in' ? 'in' : 'cm',
        tiles: {
            distance: onByDefault('distance'),
            calories: onByDefault('calories'),
            steps:    onByDefault('steps'),
            duration: onByDefault('duration'),
        },
    };
}

function saveProfile(p) {
    profile = p;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}


// ---- 4. Unit-bound wrappers -----------------------------------------------
// The lib functions are pure and take the unit explicitly; these bind the
// current `unitMode` so call sites stay readable.

const unitOfDistance   = ()    => unitOfDistanceFor(unitMode);
const userToKU         = v     => userToKUFor(v, unitMode);
const kuToUser         = ku    => kuToUserFor(ku, unitMode);
const adjustCalories   = kcal  => adjustCaloriesFor(kcal, inclineMode);
const normalizeSession = s     => normalizeSessionFor(s, unitOfDistance());

/** Notification speed → kph. The treadmill always reports metric. */
const rawKph = raw => raw.current_speed / 1000;

/** Command frame in the current screen unit. Pause/stop keep the protocol's
 *  default speed field, as they always have. */
const packet = (type, speed = 1000) => makePacket(type, speed, unitMode);


// ---- 5. Bluetooth ---------------------------------------------------------

async function connectBluetooth() {
    if (!bluetoothSupported) return;
    cancelReconnect();
    setStatus('connecting');
    loadingOverlay.hidden = false;
    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            services: [SERVICE_UUID]
        });
        // Re-adding on every connect would stack duplicate handlers, since the
        // browser hands back the same BluetoothDevice for the same hardware.
        device.removeEventListener('gattserverdisconnected', onDisconnected);
        device.addEventListener('gattserverdisconnected', onDisconnected);
        await openGatt();
    } catch (err) {
        console.error('Bluetooth connection error:', err);
        showToast('Bluetooth error: ' + err.message);
        connected = false;
        connectBtn.textContent = 'Connect';
        setStatus('disconnected');
    } finally {
        loadingOverlay.hidden = true;
    }
}

/** Open GATT on the already-chosen `device` and wire up notifications.
 *  Shared by the initial connect and by reconnect attempts. */
async function openGatt() {
    server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
    writeChar  = await service.getCharacteristic(WRITE_CHAR_UUID);
    await notifyChar.startNotifications();
    notifyChar.removeEventListener('characteristicvaluechanged', handleNotification);
    notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
    connected = true;
    userDisconnect = false;
    connectBtn.textContent = 'Disconnect';
    updateRunningState(STATE.STOPPED);
    // Push the user's chosen unit to the treadmill on connect.
    pendingCommand = packet('set_speed', curTargetSpeed);
}

function disconnectBluetooth() {
    userDisconnect = true;
    cancelReconnect();
    if (device?.gatt?.connected) device.gatt.disconnect();
    loadingOverlay.hidden = true;
}

function onDisconnected() {
    connected = false;
    notifyChar = null;
    writeChar = null;
    connectBtn.textContent = 'Connect';
    releaseWakeLock();

    // Deliberate disconnect, or nothing in flight: just close out.
    if (userDisconnect || !session) {
        userDisconnect = false;
        if (session) finishSession();
        updateRunningState(STATE.STOPPED);
        return;
    }

    // Dropped mid-workout. The belt is still moving; keep the session open and
    // try to get back before writing it off.
    setStatus('reconnecting');
    enableControls(false);
    scheduleReconnect(0);
}

function scheduleReconnect(attempt) {
    if (attempt >= RECONNECT_DELAYS_MS.length) {
        showToast('Lost connection — session saved');
        finishSession();
        updateRunningState(STATE.STOPPED);
        return;
    }
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            await openGatt();
            showToast('Reconnected');
        } catch {
            scheduleReconnect(attempt + 1);
        }
    }, RECONNECT_DELAYS_MS[attempt]);
}

function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

function handleNotification(event) {
    const raw = decodeNotification(event.target.value);
    if (!raw) {
        // Runt frame — treat as "no reliable data" but don't tear down a live
        // session over one bad packet; the next tick usually recovers.
        return;
    }
    trackSession(raw);
    updateDashboard();
    updateRunningState(raw.running_state);
    sendQueuedOrHeartbeat();
}

function sendQueuedOrHeartbeat() {
    if (!writeChar) return;
    if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = null;
        writeChar.writeValue(cmd).catch(err => console.error('Command failed:', err));
    } else {
        writeChar.writeValue(HEARTBEAT).catch(err => console.error('Heartbeat failed:', err));
    }
}


// ---- 6. Session tracking --------------------------------------------------

function trackSession(raw) {
    const running = raw.running_state === STATE.RUNNING;

    if (running && !session) {
        const snapshot = {
            duration: raw.duration, distance: raw.distance,
            steps: raw.steps, calories: raw.calories,
        };
        session = {
            date: Date.now(),
            baseline: { ...snapshot },
            latest:   { ...snapshot },
            prevDuration: raw.duration,
            speedSum: raw.current_speed, speedCount: 1,
            estKcal: 0, estSteps: 0,
            samples: [],
        };
        lastFinished = null;
        recordSample(raw);
        persistSession({ force: true });
        return;
    }

    if (running) {
        const dt = Math.max(0, raw.duration - session.prevDuration);
        if (dt > 0 && profile.weightKg != null) {
            session.estKcal +=
                estimateKcalPerMin(rawKph(raw), inclineMode / 100, profile.weightKg) * (dt / 60);
        }
        if (dt > 0 && profile.heightCm != null) {
            // Integrate speed×time so the count rises every tick instead of
            // jumping with the treadmill's coarse distance field.
            const metres = rawKph(raw) * 1000 * (dt / 3600);
            session.estSteps += metres / strideMeters(profile.heightCm);
        }
        session.latest = {
            duration: raw.duration, distance: raw.distance,
            steps: raw.steps, calories: raw.calories,
        };
        session.prevDuration = raw.duration;
        session.speedSum += raw.current_speed;
        session.speedCount += 1;
        recordSample(raw);
        persistSession();
        return;
    }

    if (session) {
        // This stop/pause frame may be the first thing we see after a
        // reconnect gap, in which case it carries the counters for the stretch
        // we missed — the run auto-reconnect exists to preserve. Take them,
        // but only where they moved forward: if the firmware zeroes a counter
        // on stop, keeping what we already have beats wiping the session.
        adoptAdvancedCounters(raw);
        finishSession();
    }
}

/**
 * Merge in any counter that advanced past what we last saw, and extend the
 * profile-based estimates over the same stretch.
 *
 * A stop frame reports the belt at 0, so it can't tell us how fast the missed
 * stretch was walked; the session's average pace is the best available stand-in.
 * Reconnect gives up after ~30s, which bounds how much this can invent.
 */
function adoptAdvancedCounters(raw) {
    const dt = Math.max(0, raw.duration - session.prevDuration);
    if (dt > 0) {
        const avgKph = (session.speedSum / session.speedCount) / 1000;
        if (profile.weightKg != null) {
            session.estKcal +=
                estimateKcalPerMin(avgKph, inclineMode / 100, profile.weightKg) * (dt / 60);
        }
        if (profile.heightCm != null) {
            session.estSteps += (avgKph * 1000 * (dt / 3600)) / strideMeters(profile.heightCm);
        }
        session.prevDuration = raw.duration;
    }
    for (const k of ['duration', 'distance', 'steps', 'calories']) {
        if (raw[k] > session.latest[k]) session.latest[k] = raw[k];
    }
}

/** Record the minute slot for the chart. We store the LAST sample of each
 *  minute (the belt's actual speed/incline at that point) rather than the
 *  minute average — averaging dragged the line above the live treadmill
 *  reading whenever the speed had been changed within the minute. Speed is
 *  kept in canonical kph so a mid-session unit toggle re-scales correctly. */
function recordSample(raw) {
    const minute = Math.max(0, Math.floor((raw.duration - session.baseline.duration) / 60));
    const slot = session.samples[minute] ||
        (session.samples[minute] = { kph: 0, incline: inclineMode, steps: 0 });
    slot.kph = rawKph(raw);
    slot.incline = inclineMode;
    slot.steps = sessionTotals().steps;
}

/** Totals for whichever session the dashboard should be showing (live, else
 *  the last completed one), or null if there's nothing to show yet. */
function sessionTotals() {
    const s = session || lastFinished;
    if (!s) return null;
    const delta = k => Math.max(0, s.latest[k] - s.baseline[k]);
    return {
        duration:   delta('duration'),
        distanceKm: delta('distance') / 1000,
        steps:      profile.heightCm != null ? Math.round(s.estSteps) : delta('steps'),
        calories:   profile.weightKg != null ? Math.round(s.estKcal) : adjustCalories(delta('calories')),
        rawCalories: delta('calories'),
        avgKph:     (s.speedSum / s.speedCount) / 1000,
    };
}

/** The current session as a storable record. */
function buildSessionRecord() {
    const t = sessionTotals();
    if (!session || !t) return null;
    return {
        date: session.date,
        duration: t.duration,
        steps: t.steps,
        calories: t.calories,
        rawCalories: t.rawCalories,
        distance: t.distanceKm,
        distanceUnit: 'km',
        avgSpeed: t.avgKph,
        speedUnit: 'kph',
        inclineApplied: inclineMode,
    };
}

/** Write the live session through to storage, at most every
 *  PERSIST_INTERVAL_MS unless forced. */
function persistSession({ force = false } = {}) {
    if (!session) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < PERSIST_INTERVAL_MS) return;
    lastPersistAt = now;
    writeSessionRecord();
}

function writeSessionRecord() {
    const record = buildSessionRecord();
    if (!record) return;
    const sessions = loadSessions();
    const i = sessions.findIndex(s => s && s.date === record.date);
    if (i >= 0) sessions[i] = record;
    else sessions.unshift(record);
    saveSessions(sessions);
    markHistoryDirty();
}

function finishSession() {
    if (!session) return;
    const finished = session;

    if (isJunkSession(buildSessionRecord())) {
        // An accidental start/stop tap isn't a workout. A record already exists
        // (we persist on the first running tick), so take it back out.
        saveSessions(loadSessions().filter(s => s && s.date !== finished.date));
        lastFinished = null;
    } else {
        writeSessionRecord();              // final flush, unthrottled
        lastFinished = finished;
    }

    session = null;
    lastPersistAt = 0;
    releaseWakeLock();
    markHistoryDirty();
    updateDashboard();
}


// ---- 7. Display -----------------------------------------------------------

const STATUS = {
    connecting:   { label: 'Connecting',   cls: 'chip-connecting' },
    reconnecting: { label: 'Reconnecting', cls: 'chip-connecting' },
    running:      { label: 'Running',      cls: 'chip-connected' },
    paused:       { label: 'Paused',       cls: 'chip-paused' },
    stopped:      { label: 'Stopped',      cls: 'chip-paused' },
    disconnected: { label: 'Disconnected', cls: 'chip-disconnected' },
    unsupported:  { label: 'Unsupported',  cls: 'chip-disconnected' },
};

function setStatus(state) {
    const { label, cls } = STATUS[state] || STATUS.disconnected;
    statusChip.textContent = label;
    statusChip.className = 'chip ' + cls;
}

function updateDashboard() {
    const t = sessionTotals();
    if (!t) {
        distanceDiv.textContent = '—';
        caloriesDiv.textContent = '—';
        stepsDiv.textContent    = '—';
        durationDiv.textContent = '—';
    } else {
        const unit = unitOfDistance();
        distanceDiv.textContent = convertDistance(t.distanceKm, 'km', unit).toFixed(2) + ' ' + unit;
        caloriesDiv.textContent = t.calories + ' kcal';
        stepsDiv.textContent    = String(t.steps);
        durationDiv.textContent = formatDuration(t.duration);
    }
    renderChart();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs, cls) {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (cls) el.setAttribute('class', cls);
    return el;
}

/**
 * Hand-rolled SVG chart of the current session: per-minute speed on the left
 * axis, cumulative steps on the right axis, plus a faint stepped incline band.
 * 30-minute window, extended by 30 once the user reaches minute 29 (then 59,
 * …). Steps axis starts at 2000, grows by 1000 past 75% full.
 */
function renderChart() {
    if (!sessionChart) return;
    const samples = (session || lastFinished)?.samples || [];

    // Match the viewBox to the element's real pixel size (1 unit = 1 px) so
    // text isn't stretched — preserveAspectRatio default keeps it 1:1.
    const VB_H = 160;
    const VB_W = Math.round(sessionChart.clientWidth) || 320;
    const x0 = 30, x1 = VB_W - 30, yTop = 10, yBot = 140;  // right margin = steps axis
    const plotW = x1 - x0, plotH = yBot - yTop;

    const lastMinute = samples.length - 1;                   // -1 if empty
    let windowMin = 30;
    while (lastMinute >= windowMin - 1) windowMin += 30;

    const speedMax = SPEED_RANGE[unitMode].max;
    const inclineScaleMax = INCLINE_GRADE * 4;               // 7% → 25% height

    // Secondary (right) axis: cumulative steps. Starts at 2000, grows by 1000
    // once the count passes 75% of the current top.
    let maxSteps = 0;
    for (const s of samples) if (s && s.steps > maxSteps) maxSteps = s.steps;
    let stepMax = 2000;
    while (maxSteps > 0.75 * stepMax) stepMax += 1000;

    const xFor  = m => x0 + (m / windowMin) * plotW;
    const ySpd  = v => yBot - (Math.min(Math.max(v, 0), speedMax) / speedMax) * plotH;
    const yInc  = i => yBot - (Math.min(i, inclineScaleMax) / inclineScaleMax) * plotH;
    const yStep = v => yBot - (Math.min(v, stepMax) / stepMax) * plotH;

    const frag = document.createDocumentFragment();

    // axes (left = speed, right = steps)
    frag.appendChild(svgEl('line', { x1: x0, y1: yBot, x2: x1, y2: yBot }, 'chart-axis'));
    frag.appendChild(svgEl('line', { x1: x0, y1: yTop, x2: x0, y2: yBot }, 'chart-axis'));
    frag.appendChild(svgEl('line', { x1: x1, y1: yTop, x2: x1, y2: yBot }, 'chart-axis'));

    // x gridlines + minute labels every 5 min
    for (let m = 0; m <= windowMin; m += 5) {
        const x = xFor(m);
        if (m > 0) frag.appendChild(svgEl('line', { x1: x, y1: yTop, x2: x, y2: yBot }, 'chart-grid'));
        // Keep the first/last labels from overflowing the plot edges.
        const anchor = m === 0 ? 'start' : (m >= windowMin ? 'end' : 'middle');
        const t = svgEl('text', { x, y: yBot + 11, 'text-anchor': anchor }, 'chart-tick-text');
        t.textContent = String(m);
        frag.appendChild(t);
    }
    // left y labels: 0 / mid / max speed
    for (const v of [0, speedMax / 2, speedMax]) {
        const t = svgEl('text', { x: x0 - 4, y: ySpd(v) + 3, 'text-anchor': 'end' }, 'chart-tick-text');
        t.textContent = (Number.isInteger(v) ? v : v.toFixed(1));
        frag.appendChild(t);
    }
    // right y labels: 0 / mid / max steps (compact, e.g. 2k)
    const stepLabel = v => v >= 1000 ? (v / 1000) + 'k' : String(v);
    for (const v of [0, stepMax / 2, stepMax]) {
        const t = svgEl('text', { x: x1 + 4, y: yStep(v) + 3, 'text-anchor': 'start' }, 'chart-tick-text');
        t.textContent = stepLabel(v);
        frag.appendChild(t);
    }

    // incline stepped area (only where we have samples)
    if (lastMinute >= 0) {
        let dPath = `M ${x0} ${yBot}`;
        for (let m = 0; m <= lastMinute; m++) {
            const inc = samples[m] ? samples[m].incline : 0;
            dPath += ` L ${xFor(m)} ${yInc(inc)} L ${xFor(m + 1)} ${yInc(inc)}`;
        }
        dPath += ` L ${xFor(lastMinute + 1)} ${yBot} Z`;
        frag.appendChild(svgEl('path', { d: dPath }, 'chart-incline'));
    }

    // speed polyline: last sample of each minute, plotted at the minute centre
    const pts = [];
    for (let m = 0; m <= lastMinute; m++) {
        const s = samples[m];
        if (!s) continue;
        const disp = unitMode === 'mph' ? s.kph / KM_PER_MI : s.kph;
        pts.push(`${xFor(m + 0.5).toFixed(1)},${ySpd(disp).toFixed(1)}`);
    }
    if (pts.length >= 2) {
        frag.appendChild(svgEl('polyline', { points: pts.join(' ') }, 'chart-speed'));
    } else if (pts.length === 1) {
        const [cx, cy] = pts[0].split(',');
        frag.appendChild(svgEl('circle', { cx, cy, r: 3 }, 'chart-speed'));
    }

    // cumulative steps polyline on the right axis
    const stepPts = [];
    for (let m = 0; m <= lastMinute; m++) {
        const s = samples[m];
        if (!s) continue;
        stepPts.push(`${xFor(m + 0.5).toFixed(1)},${yStep(s.steps).toFixed(1)}`);
    }
    if (stepPts.length >= 2) {
        frag.appendChild(svgEl('polyline', { points: stepPts.join(' ') }, 'chart-steps'));
    } else if (stepPts.length === 1) {
        const [cx, cy] = stepPts[0].split(',');
        frag.appendChild(svgEl('circle', { cx, cy, r: 3 }, 'chart-steps'));
    }

    sessionChart.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    sessionChart.replaceChildren(frag);
}

function enableControls(enable) {
    for (const el of [startBtn, stopBtn, speedUpBtn, speedDownBtn, speedSlider]) {
        el.disabled = !enable;
    }
}

function updateRunningState(state) {
    runningState = state;
    if (!connected) {
        enableControls(false);
        startBtn.textContent = 'Start';
        if (!reconnectTimer) setStatus(bluetoothSupported ? 'disconnected' : 'unsupported');
        return;
    }
    enableControls(state !== STATE.STARTING);             // disable during "Starting"
    startBtn.textContent = state === STATE.RUNNING ? 'Pause' : 'Start';
    if      (state === STATE.RUNNING) setStatus('running');
    else if (state === STATE.PAUSED)  setStatus('paused');
    else if (state === STATE.STOPPED) setStatus('stopped');
    // STARTING: leave chip as-is (typically "Stopped" → "Starting" briefly)

    if (state === STATE.RUNNING) requestWakeLock();
    else releaseWakeLock();
}

function applyUnitToSlider() {
    const r = SPEED_RANGE[unitMode];
    speedSlider.min  = String(r.min);
    speedSlider.max  = String(r.max);
    speedSlider.step = '0.1';
    sliderUnit.textContent = ' ' + r.label;
    // Clamp the displayed value into range and resync curTargetSpeed so the
    // slider and the queued command never diverge.
    const v = Math.min(r.max, Math.max(r.min, kuToUser(curTargetSpeed)));
    curTargetSpeed = userToKU(v);
    setSliderDisplay(v);
    renderPresets();
}

function setSliderDisplay(v) {
    speedSlider.value = v.toFixed(1);
    sliderValue.textContent = v.toFixed(1);
    // Without this a screen reader announces a bare "1.0" with no unit.
    speedSlider.setAttribute('aria-valuetext', `${v.toFixed(1)} ${SPEED_RANGE[unitMode].label}`);
}

function setTargetSpeed(userValue) {
    const r = SPEED_RANGE[unitMode];
    const clamped = Math.min(r.max, Math.max(r.min, userValue));
    curTargetSpeed = userToKU(clamped);
    setSliderDisplay(clamped);
    renderPresets();
}

/** Keep every unit toggle (Controls + History) in sync with unitMode. */
function syncUnitToggles() {
    unitToggles.forEach(g => updateSegmentedActive(g, unitMode));
}

function setUnit(newUnit) {
    if (newUnit !== 'kph' && newUnit !== 'mph') return;
    if (newUnit === unitMode) return;
    unitMode = newUnit;
    localStorage.setItem(PREF_UNIT, unitMode);
    syncUnitToggles();
    // curTargetSpeed is in native units (unit-independent); only the
    // slider/readout presentation changes — the physical target is unchanged,
    // so there's no need to resend a command.
    applyUnitToSlider();
    updateDashboard();
    flushHistoryRender();
}

function setIncline(newIncline) {
    const n = Number(newIncline) === INCLINE_GRADE ? INCLINE_GRADE : 0;
    if (n === inclineMode) return;
    inclineMode = n;
    localStorage.setItem(PREF_INCLINE, String(inclineMode));
    updateSegmentedActive(inclineToggle, String(inclineMode));
    updateDashboard();
    flushHistoryRender();
}

function updateSegmentedActive(group, value) {
    group.querySelectorAll('.seg').forEach(b => {
        const active = b.dataset.value === String(value);
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}


// ---- 8. History (calendar, day detail, import/export) --------------------

function isHistoryVisible() {
    return panels.history.classList.contains('is-active');
}

/** Note that stored history changed. Re-rendering the calendar means
 *  re-reading and re-aggregating every session ever recorded, so while the
 *  History tab is hidden we only set a flag and redraw when it's shown. */
function markHistoryDirty() {
    historyDirty = true;
    if (isHistoryVisible()) flushHistoryRender();
}

function flushHistoryRender() {
    historyDirty = false;
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

/** All-time totals: distance and steps, plus vertical climb on the 7% grade
 *  (metric in kph mode, imperial in mph mode — follows the unit toggle). */
function renderLifetime(sessions) {
    const unit = unitOfDistance();
    const { distance, steps, climbM } = lifetimeTotals(sessions, unit);
    lifeDistance.textContent = distance.toFixed(2) + ' ' + unit;
    lifeSteps.textContent = Math.round(steps).toLocaleString();
    lifeClimb.textContent = unit === 'mi'
        ? Math.round(climbM * FT_PER_M).toLocaleString() + ' ft'
        : Math.round(climbM).toLocaleString() + ' m';
}

function renderCalendar() {
    const sessions = loadSessions();
    renderLifetime(sessions);
    calMonth.textContent = format(calViewDate, 'MMMM yyyy');

    const monthStart = startOfMonth(calViewDate);
    const days = eachDayOfInterval({ start: monthStart, end: endOfMonth(calViewDate) });
    const leadingPadding = (monthStart.getDay() + 6) % 7;  // Mon=0
    const unit = unitOfDistance();
    const totals = aggregateByDay(sessions, unit);
    const todayKey = dayKey(new Date());

    calGrid.replaceChildren();
    for (let i = 0; i < leadingPadding; i++) {
        const pad = document.createElement('div');
        pad.className = 'cal-day is-outside is-empty';
        calGrid.appendChild(pad);
    }
    for (const d of days) {
        const key = dayKey(d);
        const t = totals.get(key);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day' + (t ? '' : ' is-empty');
        if (key === todayKey)        cell.classList.add('is-today');
        if (key === selectedDayKey)  cell.classList.add('is-selected');
        cell.dataset.day = key;

        const num = document.createElement('div');
        num.className = 'cal-day-num';
        num.textContent = String(d.getDate());
        cell.appendChild(num);

        if (t) {
            const tot = document.createElement('div');
            tot.className = 'cal-day-totals';
            const dist = document.createElement('div');
            dist.className = 'dist';
            dist.textContent = t.distance.toFixed(2) + ' ' + unit;
            const kcal = document.createElement('div');
            kcal.className = 'kcal';
            kcal.textContent = Math.round(t.calories) + ' kcal';
            tot.append(dist, kcal);
            cell.appendChild(tot);
            cell.setAttribute('aria-label',
                `${format(d, 'EEEE, MMM d')}: ${t.distance.toFixed(2)} ${unit}, ${Math.round(t.calories)} kcal`);
            cell.addEventListener('click', () => {
                selectedDayKey = (selectedDayKey === key) ? null : key;
                renderCalendar();
                if (selectedDayKey) renderDayDetail(selectedDayKey);
                else clearDayDetail();
            });
        } else {
            cell.disabled = true;
        }
        calGrid.appendChild(cell);
    }
}

function renderDayDetail(key) {
    const sessions = loadSessions().filter(s =>
        s && typeof s.date === 'number' && dayKey(s.date) === key
    );
    dayDetail.replaceChildren();
    if (sessions.length === 0) {
        dayDetail.hidden = true;
        return;
    }
    sessions.sort((a, b) => b.date - a.date);
    const unit = unitOfDistance();

    const header = document.createElement('div');
    header.className = 'day-detail-header';
    header.textContent = `${format(new Date(sessions[0].date), 'EEEE, MMM d')} — ${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
    dayDetail.appendChild(header);

    for (const s of sessions) {
        const n = normalizeSession(s);
        if (!n) continue;
        const time = format(new Date(n.date), 'h:mm a');
        const row = document.createElement('div');
        row.className = 'session-row';
        row.append(
            makeField('Time',     time),
            makeField('Distance', `${n.distance.toFixed(2)} ${unit}`),
            makeField('Calories', `${n.calories} kcal`),
        );
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.title = 'Delete';
        del.setAttribute('aria-label', `Delete the ${time} session`);
        del.textContent = '×';
        del.addEventListener('click', () => deleteSessionByDate(s.date));
        row.appendChild(del);
        dayDetail.appendChild(row);
    }
    dayDetail.hidden = false;
}

function makeField(label, value) {
    const wrap = document.createElement('div');
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'v';     v.textContent = value;
    wrap.append(l, v);
    return wrap;
}

function clearDayDetail() {
    selectedDayKey = null;
    dayDetail.hidden = true;
    dayDetail.replaceChildren();
}

function navigateMonth(delta) {
    calViewDate = addMonths(calViewDate, delta);
    clearDayDetail();
    renderCalendar();
}

function exportHistory() {
    const blob = new Blob([JSON.stringify(loadSessions(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'treadmill_sessions.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    showToast('History exported');
}

/**
 * Import merges into the existing log rather than replacing it — a "restore
 * from backup" that deletes everything recorded since the export is data loss,
 * and there's no undo.
 */
function importHistory(file) {
    const reader = new FileReader();
    reader.onerror = () => showToast('Could not read that file');
    reader.onload = ev => {
        try {
            const parsed = JSON.parse(ev.target.result);
            if (!Array.isArray(parsed)) { showToast('Invalid file format'); return; }
            const { sessions, added, duplicate, skipped } = mergeSessions(loadSessions(), parsed);
            // Announcing a restore that didn't persist is worse than no
            // restore — saveSessions has already explained the failure.
            if (!saveSessions(sessions)) return;
            flushHistoryRender();

            const notes = [];
            if (duplicate) notes.push(`${duplicate} already present`);
            if (skipped)   notes.push(`${skipped} unreadable`);
            showToast(notes.length
                ? `Imported ${added} (${notes.join(', ')})`
                : `Imported ${added} session${added === 1 ? '' : 's'}`);
        } catch (err) {
            showToast('Failed to import: ' + err.message);
        }
    };
    reader.readAsText(file);
}


// ---- 9. Wake lock ---------------------------------------------------------

/** Keep the screen on while the belt is moving — otherwise the dashboard
 *  blanks mid-walk and you have to reach over and tap it. */
async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
        // Denied, or the document isn't visible. Harmless — carry on without it.
    }
}

function releaseWakeLock() {
    if (!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
}

// The system drops the lock whenever the tab is hidden, so re-take it on return.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && connected && runningState === STATE.RUNNING) {
        requestWakeLock();
    }
});


// ---- 10. Wiring & init ----------------------------------------------------

function wireSegmented(group, onChange) {
    group.addEventListener('click', e => {
        const btn = e.target.closest('.seg');
        if (btn) onChange(btn.dataset.value);
    });
}

async function showCountdown() {
    countdownOverlay.hidden = false;
    for (const n of [3, 2, 1]) {
        countdownNumber.textContent = String(n);
        countdownNumber.classList.remove('is-pulsing');
        void countdownNumber.offsetWidth;     // restart CSS animation
        countdownNumber.classList.add('is-pulsing');
        await new Promise(r => setTimeout(r, 700));
    }
    countdownOverlay.hidden = true;
    countdownNumber.classList.remove('is-pulsing');
}

function showToast(message, timeout = 3500) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, timeout);
}

function bumpSpeed(deltaUserValue) {
    if (!connected) return;
    setTargetSpeed(kuToUser(curTargetSpeed) + deltaUserValue);
    pendingCommand = packet('set_speed', curTargetSpeed);
}

/** Start, or pause/resume if a run is already under way. */
function toggleRun() {
    if (!connected) return;
    if (runningState === STATE.RUNNING) {
        pendingCommand = packet('pause');
        return;
    }
    showCountdown();
    pendingCommand = packet('start', curTargetSpeed);
}

// ---- Speed presets --------------------------------------------------------

// 0.7 mph is the treadmill's floor (≈1 kph); kph starts at 1.
const PRESETS = { kph: [1, 2, 3, 4, 5, 6], mph: [0.7, 1, 1.5, 2, 2.5, 3, 3.5] };

function renderPresets() {
    const cur = kuToUser(curTargetSpeed);
    presetRow.replaceChildren();
    for (const v of PRESETS[unitMode]) {
        const b = document.createElement('button');
        b.type = 'button';
        const active = Math.abs(v - cur) < 0.05;
        b.className = 'preset-btn' + (active ? ' is-active' : '');
        b.textContent = v % 1 === 0 ? String(v) : v.toFixed(1);
        b.setAttribute('aria-label', `${b.textContent} ${SPEED_RANGE[unitMode].label}`);
        b.setAttribute('aria-pressed', String(active));
        b.addEventListener('click', () => {
            setTargetSpeed(v);
            if (connected) pendingCommand = packet('set_speed', curTargetSpeed);
        });
        presetRow.appendChild(b);
    }
}

// ---- Settings modal -------------------------------------------------------

let modalWeightUnit = 'kg';
let modalHeightUnit = 'cm';
let focusBeforeModal = null;

const round1 = n => Math.round(n * 10) / 10;

function openSettings() {
    modalWeightUnit = profile.weightUnit;
    modalHeightUnit = profile.heightUnit;
    updateSegmentedActive(weightUnitToggle, modalWeightUnit);
    updateSegmentedActive(heightUnitToggle, modalHeightUnit);
    weightInput.value = profile.weightKg == null ? ''
        : round1(modalWeightUnit === 'lb' ? profile.weightKg * LB_PER_KG : profile.weightKg);
    heightInput.value = profile.heightCm == null ? ''
        : round1(modalHeightUnit === 'in' ? profile.heightCm / CM_PER_IN : profile.heightCm);
    for (const k in tileChecks) tileChecks[k].checked = profile.tiles[k];
    focusBeforeModal = document.activeElement;
    settingsModal.hidden = false;
    weightInput.focus();
}

function closeSettings() {
    settingsModal.hidden = true;
    focusBeforeModal?.focus?.();
    focusBeforeModal = null;
}

/** Show/hide each dashboard tile per profile.tiles. */
function applyTileVisibility() {
    for (const k in tileChecks) {
        const el = document.querySelector(`.stat[data-tile="${k}"]`);
        if (el) el.classList.toggle('is-hidden', !profile.tiles[k]);
    }
}

function setModalWeightUnit(u) {
    if (u !== 'kg' && u !== 'lb') return;
    if (u === modalWeightUnit) return;
    const val = parseFloat(weightInput.value);
    if (Number.isFinite(val)) {
        const kg = modalWeightUnit === 'lb' ? val / LB_PER_KG : val;
        weightInput.value = round1(u === 'lb' ? kg * LB_PER_KG : kg);
    }
    modalWeightUnit = u;
    updateSegmentedActive(weightUnitToggle, u);
}

function setModalHeightUnit(u) {
    if (u !== 'cm' && u !== 'in') return;
    if (u === modalHeightUnit) return;
    const val = parseFloat(heightInput.value);
    if (Number.isFinite(val)) {
        const cm = modalHeightUnit === 'in' ? val * CM_PER_IN : val;
        heightInput.value = round1(u === 'in' ? cm / CM_PER_IN : cm);
    }
    modalHeightUnit = u;
    updateSegmentedActive(heightUnitToggle, u);
}

function saveSettings() {
    const w = parseFloat(weightInput.value);
    const h = parseFloat(heightInput.value);
    const weightKg = Number.isFinite(w) && w > 0
        ? (modalWeightUnit === 'lb' ? w / LB_PER_KG : w) : null;
    const heightCm = Number.isFinite(h) && h > 0
        ? (modalHeightUnit === 'in' ? h * CM_PER_IN : h) : null;
    const tiles = {};
    for (const k in tileChecks) tiles[k] = tileChecks[k].checked;
    saveProfile({ weightKg, heightCm, weightUnit: modalWeightUnit, heightUnit: modalHeightUnit, tiles });
    closeSettings();
    applyTileVisibility();
    updateDashboard();
    showToast('Settings saved');
}

// Keep Tab inside the dialog while it's open, and let Escape dismiss it.
const FOCUSABLE = 'button, input, [tabindex]:not([tabindex="-1"])';
settingsModal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); return; }
    if (e.key !== 'Tab') return;
    const items = [...settingsModal.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled);
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    }
});

// Connect
connectBtn.addEventListener('click', () => connected ? disconnectBluetooth() : connectBluetooth());

// Start / Stop
startBtn.addEventListener('click', toggleRun);
stopBtn.addEventListener('click', () => {
    if (connected) pendingCommand = packet('stop');
});

// Speed buttons + slider
speedUpBtn.addEventListener('click', () => bumpSpeed(+0.1));
speedDownBtn.addEventListener('click', () => bumpSpeed(-0.1));
speedSlider.addEventListener('input', () => {
    setSliderDisplay(parseFloat(speedSlider.value));
});
speedSlider.addEventListener('change', () => {
    setTargetSpeed(parseFloat(speedSlider.value));
    if (connected) pendingCommand = packet('set_speed', curTargetSpeed);
});

// Keyboard control: ←/→ (and ↑/↓ for speed's sake, ↓ doubles as pause) plus
// Space to start/pause. OS key-repeat fires keydown rapidly while a key is
// held, so rate-limit each action.
const KEY_THROTTLE_MS = { speed: 150, toggle: 600 };
const lastKeyTime = { speed: 0, toggle: 0 };
function keyAllowed(kind) {
    const now = performance.now();
    if (now - lastKeyTime[kind] < KEY_THROTTLE_MS[kind]) return false;
    lastKeyTime[kind] = now;
    return true;
}

/** Pause or resume, but only while a run is actually under way. */
function keyTogglePause() {
    if (!connected || (runningState !== STATE.RUNNING && runningState !== STATE.PAUSED)) return;
    if (!keyAllowed('toggle')) return;
    toggleRun();
}

window.addEventListener('keydown', e => {
    // Let native controls (slider, settings inputs) handle their own keys.
    const active = document.activeElement;
    const tag = active?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!settingsModal.hidden) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
            e.preventDefault();
            if (keyAllowed('speed')) bumpSpeed(+0.1);
            break;
        case 'ArrowLeft':
            e.preventDefault();
            if (keyAllowed('speed')) bumpSpeed(-0.1);
            break;
        case 'ArrowDown':
            e.preventDefault();
            keyTogglePause();
            break;
        case ' ':
        case 'Spacebar':
            // A focused button already treats Space as "activate" — don't
            // fire the toggle twice.
            if (tag === 'BUTTON') break;
            e.preventDefault();
            keyTogglePause();
            break;
    }
});

// Segmented toggles
unitToggles.forEach(g => wireSegmented(g, setUnit));
wireSegmented(inclineToggle, setIncline);

// Settings modal
settingsBtn.addEventListener('click', openSettings);
settingsCancelBtn.addEventListener('click', closeSettings);
settingsSaveBtn.addEventListener('click', saveSettings);
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });
wireSegmented(weightUnitToggle, setModalWeightUnit);
wireSegmented(heightUnitToggle, setModalHeightUnit);

// Tabs
tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => {
        const active = x === t;
        x.classList.toggle('is-active', active);
        x.setAttribute('aria-selected', String(active));
    });
    Object.entries(panels).forEach(([k, p]) => p.classList.toggle('is-active', k === t.dataset.tab));
    // Only rebuild if something changed while the tab was hidden.
    if (t.dataset.tab === 'history' && historyDirty) flushHistoryRender();
}));

// Calendar navigation
prevMonthBtn.addEventListener('click', () => navigateMonth(-1));
nextMonthBtn.addEventListener('click', () => navigateMonth(+1));

// Import / Export
exportHistoryBtn.addEventListener('click', exportHistory);
importHistoryBtn.addEventListener('click', () => { importHistoryInput.value = ''; importHistoryInput.click(); });
importHistoryInput.addEventListener('change', () => {
    const f = importHistoryInput.files?.[0];
    if (f) importHistory(f);
});

// Redraw the chart when the layout width changes (viewBox is width-derived).
window.addEventListener('resize', renderChart);

// Persistence is throttled during a session, so make sure the last few seconds
// aren't lost when the tab goes away.
window.addEventListener('pagehide', () => { if (session) writeSessionRecord(); });

// Offline shell. Nothing here needs the network at runtime, so the installed
// PWA shouldn't fall over when the network is down.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err =>
            console.warn('Service worker registration failed:', err));
    });
}

// Init
syncUnitToggles();
updateSegmentedActive(inclineToggle, String(inclineMode));
applyTileVisibility();
applyUnitToSlider();   // also renders presets
updateDashboard();     // also draws the empty chart
updateRunningState(STATE.STOPPED);
renderCalendar();      // also renders lifetime totals

if (!bluetoothSupported) {
    // Without this the Connect button throws a TypeError deep inside
    // requestDevice and surfaces as "Cannot read properties of undefined".
    connectBtn.disabled = true;
    connectBtn.title = 'Web Bluetooth is not available in this browser';
    unsupportedNotice.hidden = false;
    setStatus('unsupported');
}
