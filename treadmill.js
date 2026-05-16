// =============================================================================
// PitPat Treadmill Web Dashboard
//
// Single-file ES module that drives the dashboard for a PitPat treadmill over
// Web Bluetooth. Loaded as `<script type="module">` from index.html. Uses the
// date-fns CDN global (window.dateFns) for calendar math; no other deps.
//
// Sections in this file:
//   1.  Constants     — BLE protocol, app config, units, persistence keys
//   2.  DOM refs      — cached element handles
//   3.  State         — mutable runtime state
//   4.  Storage       — localStorage helpers for sessions + sanitization
//   5.  Helpers       — formatting, conversion, incline adjustment
//   6.  Bluetooth     — connect / disconnect / notification handler
//   7.  Packet builder
//   8.  Display       — dashboard, slider, segmented toggles, status chip
//   9.  History       — calendar, day detail, import/export
//  10.  Wiring & init
//
// Session storage shape (under `treadmill_sessions` in localStorage). New
// sessions are written canonically in metric (km / kph); the unit fields are
// kept so older or imported records in mi/mph still convert correctly on
// render via normalizeSession().
//   { date: number,              // ms timestamp
//     duration: number,          // seconds
//     steps: number,
//     calories: number,          // already incline-adjusted at save time
//     rawCalories: number,       // firmware-reported, reference only
//     distance: number,          // in `distanceUnit`
//     distanceUnit: 'km'|'mi',   // new sessions: 'km'
//     avgSpeed: number,          // in `speedUnit`
//     speedUnit: 'kph'|'mph',    // new sessions: 'kph'
//     inclineApplied: 0|7 }
// =============================================================================


// ---- 1. Constants ----------------------------------------------------------

const SERVICE_UUID     = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID  = "0000fba1-0000-1000-8000-00805f9b34fb";

/**
 * PitPat BLE protocol layout.
 *
 * Notification payload (≥ MIN_PACKET_LEN bytes): treadmill → app at ~1 Hz.
 *   bytes 3..4   u16  current speed × 1000 (in current unit)
 *   bytes 7..10  u32  distance × 1000      (in current unit)
 *   bytes 14..17 u32  steps
 *   bytes 18..19 u16  calories (kcal)
 *   bytes 20..23 u32  duration (ms)
 *   byte  26          flags (bit 7 = mph; bits 3-4 encode run state)
 *
 * Command packet (23 bytes): app → treadmill, framed by START_BYTE/END_BYTE
 * with an XOR checksum at byte 21. See `makePacket` for full layout.
 */
const BLE = {
    MIN_PACKET_LEN:      31,
    // notification payload
    OFFSET_CURRENT_SPEED: 3,
    OFFSET_DISTANCE:      7,
    OFFSET_STEPS:        14,
    OFFSET_CALORIES:     18,
    OFFSET_DURATION_MS:  20,
    OFFSET_FLAGS:        26,
    FLAG_UNIT_MPH:       0x80,   // notification speed/distance are in THIS unit
                                 // (the command-packet speed is always kph)
    FLAG_STATE_MASK:     0x18,
    FLAG_STATE_STARTING: 0x18,
    FLAG_STATE_RUNNING:  0x08,
    FLAG_STATE_PAUSED:   0x10,
    // command packet
    START_BYTE:          0x6A,
    END_BYTE:            0x43,
    CMD_UNIT_MPH_BIT:    0x08,   // OR into byte 12 when speaking mph
    CMD_KPH_MASK:        0xF7,   // AND into byte 12 to force kph
};

/** Speed slider ranges, expressed in the user's selected display unit. */
const SPEED_RANGE = {
    kph: { min: 1.0, max: 6.0, label: 'kph' },
    mph: { min: 0.7, max: 3.8, label: 'mph' },
};

/**
 * The treadmill's speed command is ALWAYS kph × 1000 internally, no matter
 * which unit its screen shows — the unit bit in the command byte only changes
 * the on-screen label, not how the speed value is interpreted. So we keep the
 * target in those native units and convert to/from the user's unit purely for
 * the slider and the readout. (Sending "3.7" while meaning 3.7 mph made the
 * belt run at 3.7 kph ≈ 2.3 mph — the original calibration bug.)
 */
const KU_MIN = 1000;   // 1.0 kph
const KU_MAX = 6200;   // ~6.2 kph ≈ 3.85 mph — covers the Deerrun's 3.8 mph cap

const PREF_UNIT    = 'treadmill_unit';
const PREF_INCLINE = 'treadmill_incline';
const SESSIONS_KEY = 'treadmill_sessions';
const PROFILE_KEY  = 'treadmill_profile';

const INCLINE_GRADE = 7;   // the treadmill's manual incline switch, in percent
// Fallback used ONLY when the user hasn't entered body metrics: firmware
// doesn't fold the incline switch into its kcal count, so apply a flat ~1.8×
// at 7% (ACSM walking eq, ~2.5–3 mph). Once a weight is set we integrate the
// real ACSM equation instead (incline folded in) — see estimateKcalPerMin.
const INCLINE_KCAL_FACTOR = 1.80;
const KM_PER_MI = 1.609344;
const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;
const FT_PER_M  = 3.28084;
const STRIDE_FACTOR = 0.414;   // walking stride ≈ 0.414 × height (unisex)

// PitPat protocol default user ID — a protocol constant, NOT a personal
// identifier. Every command packet carries the same bytes here.
const USER_ID_BYTES = (() => {
    const id = 58965456623n;
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; ++i) out[i] = Number((id >> BigInt(56 - i * 8)) & 0xFFn);
    return out;
})();

const HEARTBEAT = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);


// ---- 2. DOM refs ----------------------------------------------------------

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
const loadingOverlay     = $('loadingOverlay');
const countdownOverlay   = $('countdownOverlay');
const countdownNumber    = $('countdownNumber');
const importHistoryBtn   = $('importHistoryBtn');
const exportHistoryBtn   = $('exportHistoryBtn');
const importHistoryInput = $('importHistoryInput');
const toastEl            = $('toast');
const unitToggle         = $('unitToggle');
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


// ---- 3. State -------------------------------------------------------------

let unitMode    = localStorage.getItem(PREF_UNIT)    === 'mph' ? 'mph' : 'kph';
let inclineMode = localStorage.getItem(PREF_INCLINE) === String(INCLINE_GRADE) ? INCLINE_GRADE : 0;

let device = null, server = null, notifyChar = null, writeChar = null;
let connected = false;
let runningState = 3;       // 0 Starting · 1 Running · 2 Paused · 3 Stopped
let curTargetSpeed = 1000;  // treadmill speed command — kph × 1000 (unit-independent)

let lastRaw = null;         // most recent decoded notification (for re-render)
let pendingCommand = null;  // queued packet, sent on next notification tick

let sessionActive = false;
let sessionStartData = null;
let calViewDate = startOfThisMonth();
let selectedDayKey = null;

let profile = loadProfile();

// Per-minute samples for the current session's chart: index = minute,
// value = { sum, count, incline }. Reset on each new session.
let sessionSamples = [];
let estKcal = 0;            // ACSM-integrated kcal for the active session
let estSteps = 0;           // speed-integrated step count (smooth, profile-based)

let toastTimer = null;


// ---- 4. Storage -----------------------------------------------------------

function loadSessions() {
    try {
        const s = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
        return Array.isArray(s) ? s : [];
    } catch { return []; }
}

function saveSessions(sessions) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function deleteSessionByDate(dateTs) {
    saveSessions(loadSessions().filter(s => s.date !== dateTs));
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
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

/**
 * Coerce an untrusted object into a canonical session, or return null if it's
 * not recognizable as one. Used by Import to defend localStorage from junk;
 * the renderers stay defensive but data is sanitized here so they don't have
 * to spread that responsibility.
 */
function cleanSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.date !== 'number' || !Number.isFinite(raw.date)) return null;

    const num = (x, def = 0) => {
        const n = Number(typeof x === 'string' ? parseFloat(x) : x);
        return Number.isFinite(n) ? n : def;
    };
    const speedUnit = raw.speedUnit === 'mph' ? 'mph' : 'kph';
    const distanceUnit =
        raw.distanceUnit === 'mi' ? 'mi' :
        raw.distanceUnit === 'km' ? 'km' :
        (speedUnit === 'mph' ? 'mi' : 'km');

    return {
        date:           raw.date,
        duration:       Math.max(0, Math.floor(num(raw.duration))),
        steps:          Math.max(0, Math.floor(num(raw.steps))),
        calories:       Math.max(0, Math.round(num(raw.calories))),
        rawCalories:    Math.max(0, Math.round(num(raw.rawCalories ?? raw.calories))),
        distance:       Math.max(0, num(raw.distance)),
        distanceUnit,
        avgSpeed:       Math.max(0, num(raw.avgSpeed)),
        speedUnit,
        inclineApplied: raw.inclineApplied === INCLINE_GRADE ? INCLINE_GRADE : 0,
    };
}


// ---- 5. Helpers -----------------------------------------------------------

function startOfThisMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

function dayKey(d) {
    const date = d instanceof Date ? d : new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Stopwatch style: "0:00", "12:34", or "1:02:03" once it passes an hour. */
function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${s}`
        : `${m}:${s}`;
}

function unitOfDistance() { return unitMode === 'mph' ? 'mi' : 'km'; }

function convertDistance(value, from, to) {
    if (!value || from === to) return value;
    return from === 'km' ? value / KM_PER_MI : value * KM_PER_MI;
}

/** User-facing speed (in the current unit) → native treadmill units (kph×1000). */
function userToKU(v) {
    const ku = unitMode === 'mph'
        ? Math.round(v * KM_PER_MI * 1000)
        : Math.round(v * 1000);
    return Math.min(KU_MAX, Math.max(KU_MIN, ku));
}

/** Native treadmill units (kph×1000) → user-facing value in the current unit. */
function kuToUser(ku) {
    const kph = ku / 1000;
    return unitMode === 'mph' ? kph / KM_PER_MI : kph;
}

/**
 * Firmware doesn't fold the manual incline switch into its calorie count.
 * Apply a flat correction when the user has selected the incline grade.
 */
function adjustCalories(rawKcal) {
    const n = Number(rawKcal) || 0;
    return Math.round(inclineMode === INCLINE_GRADE ? n * INCLINE_KCAL_FACTOR : n);
}

/** Canonical metric from a decoded notification (fields are in reported_unit). */
function rawKph(raw) {
    const v = raw.current_speed / 1000;
    return raw.reported_unit === 'mph' ? v * KM_PER_MI : v;
}
function rawKm(raw) {
    const v = raw.distance / 1000;
    return raw.reported_unit === 'mph' ? v * KM_PER_MI : v;
}

/**
 * ACSM walking metabolic equation. The treadmill caps ~3.8 mph, so walking
 * (not running) applies throughout. Returns kcal per minute.
 *   S    = speed in m/min
 *   VO2  = 0.1·S + 1.8·S·grade + 3.5   (ml/kg/min)
 *   kcal/min = VO2 · weightKg · 5 / 1000   (≈5 kcal per L O2)
 * Incline is part of the formula, so no separate factor is needed here.
 */
function estimateKcalPerMin(speedKph, gradeFrac, weightKg) {
    const S = speedKph * 1000 / 60;
    const vo2 = 0.1 * S + 1.8 * S * gradeFrac + 3.5;
    return vo2 * weightKg * 5 / 1000;
}

/** Walking stride length (m) from standing height (cm). */
function strideMeters(heightCm) {
    return STRIDE_FACTOR * heightCm / 100;
}

/**
 * Project a stored session onto `{ date, distance, calories }` in the user's
 * current display unit. Tolerant of older session shapes that lack
 * `distanceUnit` or stored calories as a string.
 */
function normalizeSession(s) {
    if (!s || typeof s.date !== 'number') return null;
    const from = s.distanceUnit || (s.speedUnit === 'mph' ? 'mi' : 'km');
    return {
        date:     s.date,
        distance: convertDistance(Number(s.distance) || 0, from, unitOfDistance()),
        calories: Math.round(Number(s.calories) || 0),
    };
}


// ---- 6. Bluetooth ---------------------------------------------------------

async function connectBluetooth() {
    setStatus('connecting');
    loadingOverlay.hidden = false;
    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            services: [SERVICE_UUID]
        });
        device.addEventListener('gattserverdisconnected', onDisconnected);
        server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
        writeChar  = await service.getCharacteristic(WRITE_CHAR_UUID);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        connected = true;
        connectBtn.textContent = 'Disconnect';
        updateRunningState(3);
        // Push the user's chosen unit to the treadmill on connect.
        pendingCommand = makePacket('set_speed', curTargetSpeed);
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

function disconnectBluetooth() {
    if (device?.gatt?.connected) device.gatt.disconnect();
    loadingOverlay.hidden = true;
}

function onDisconnected() {
    connected = false;
    connectBtn.textContent = 'Connect';
    updateRunningState(3); // also sets status to disconnected when !connected
    if (sessionActive) finishSession();
}

/** @param {DataView} value */
function decodeNotification(value) {
    const u16 = o => (value.getUint8(o) << 8) | value.getUint8(o + 1);
    const u32 = o => (value.getUint8(o) << 24) | (value.getUint8(o + 1) << 16) |
                     (value.getUint8(o + 2) << 8) | value.getUint8(o + 3);

    const flags = value.getUint8(BLE.OFFSET_FLAGS);
    const stateBits = flags & BLE.FLAG_STATE_MASK;
    const running_state =
        stateBits === BLE.FLAG_STATE_STARTING ? 0 :
        stateBits === BLE.FLAG_STATE_RUNNING  ? 1 :
        stateBits === BLE.FLAG_STATE_PAUSED   ? 2 : 3;

    return {
        // Notification speed/distance are in the treadmill's *display* unit
        // (reported_unit) × 1000 — NOT metric. (The command packet's speed is
        // the one that's always kph; the two paths differ.)
        current_speed: u16(BLE.OFFSET_CURRENT_SPEED),  // reported_unit × 1000
        distance:      u32(BLE.OFFSET_DISTANCE),        // reported_unit dist × 1000
        calories:      u16(BLE.OFFSET_CALORIES),
        steps:         u32(BLE.OFFSET_STEPS),
        duration:      Math.round(u32(BLE.OFFSET_DURATION_MS) / 1000),
        reported_unit: (flags & BLE.FLAG_UNIT_MPH) ? 'mph' : 'kph',
        running_state,
    };
}

function handleNotification(event) {
    const value = event.target.value;

    if (value.byteLength < BLE.MIN_PACKET_LEN) {
        lastRaw = null;
        updateDashboard({});
        updateRunningState(3);
        if (sessionActive) finishSession();
        return;
    }

    const raw = decodeNotification(value);
    lastRaw = raw;
    updateDashboard(buildDisplayFromRaw(raw));
    updateRunningState(raw.running_state);
    trackSession(raw);
    sendQueuedOrHeartbeat();
}

/** Record the minute slot for the chart. We store the LAST sample of each
 *  minute (the belt's actual speed/incline at that point) rather than the
 *  minute average — averaging dragged the line above the live treadmill
 *  reading whenever the speed had been changed within the minute. Speed is
 *  kept in canonical kph so a mid-session unit toggle re-scales correctly. */
function recordSample(raw) {
    const minute = Math.max(0, Math.floor(raw.duration / 60));
    const slot = sessionSamples[minute] ||
        (sessionSamples[minute] = { kph: 0, incline: inclineMode, steps: 0 });
    slot.kph = rawKph(raw);
    slot.incline = inclineMode;
    slot.steps = profile.heightCm != null ? Math.round(estSteps) : raw.steps;
}

function trackSession(raw) {
    const running = raw.running_state === 1;
    if (running && !sessionActive) {
        sessionActive = true;
        sessionStartData = {
            date: Date.now(),
            steps: raw.steps, calories: raw.calories, distance: raw.distance,
            duration: raw.duration, prevDuration: raw.duration,
            speedSum: raw.current_speed, speedCount: 1,
            reportedUnit: raw.reported_unit,  // fixed for the run
        };
        estKcal = 0;
        estSteps = 0;
        sessionSamples = [];
        recordSample(raw);
        upsertLiveSession();
    } else if (running && sessionStartData) {
        const dt = Math.max(0, raw.duration - sessionStartData.prevDuration);
        if (dt > 0 && profile.weightKg != null) {
            estKcal += estimateKcalPerMin(rawKph(raw), inclineMode / 100, profile.weightKg) * (dt / 60);
        }
        if (dt > 0 && profile.heightCm != null) {
            // Integrate speed×time so the count rises every tick instead of
            // jumping with the treadmill's coarse distance field.
            const metres = rawKph(raw) * 1000 * (dt / 3600);
            estSteps += metres / strideMeters(profile.heightCm);
        }
        Object.assign(sessionStartData, {
            steps: raw.steps, calories: raw.calories, distance: raw.distance,
            duration: raw.duration, prevDuration: raw.duration,
        });
        sessionStartData.speedSum += raw.current_speed;
        sessionStartData.speedCount += 1;
        recordSample(raw);
        upsertLiveSession();
    } else if (!running && sessionActive) {
        finishSession();
    }
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

function upsertLiveSession() {
    if (!sessionStartData) return;
    const s = sessionStartData;
    // The treadmill reports in its display unit; convert to canonical metric
    // (km / kph) before storing so the calendar/detail views (which assume
    // metric and re-convert per the user's choice) stay correct.
    const repMph = s.reportedUnit === 'mph';
    const distKm = repMph ? (s.distance / 1000) * KM_PER_MI : s.distance / 1000;
    const avgRaw = (s.speedSum / s.speedCount) / 1000;
    const avgKph = repMph ? avgRaw * KM_PER_MI : avgRaw;
    // Use the profile-based estimates when available so stored history matches
    // the live dashboard; otherwise the firmware numbers (incline-adjusted).
    const calories = profile.weightKg != null
        ? Math.round(estKcal)
        : adjustCalories(s.calories);
    const steps = profile.heightCm != null ? Math.round(estSteps) : s.steps;
    const session = {
        date: s.date,
        duration: s.duration,
        steps,
        calories,
        rawCalories: s.calories,
        distance: distKm,
        distanceUnit: 'km',
        avgSpeed: avgKph,
        speedUnit: 'kph',
        inclineApplied: inclineMode,
    };
    const sessions = loadSessions();
    if (sessions[0] && sessions[0].date === session.date) sessions[0] = session;
    else sessions.unshift(session);
    saveSessions(sessions);
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

function finishSession() {
    sessionActive = false;
    sessionStartData = null;
}


// ---- 7. Packet builder ----------------------------------------------------

/**
 * Build a 23-byte command packet for the treadmill.
 *
 *   [0]      START_BYTE (0x6A)
 *   [1]      length (0x17 = 23)
 *   [2..5]   reserved (zero)
 *   [6..7]   target speed, kph × 1000 (big-endian u16). ALWAYS kph — the
 *            unit bit below only changes the treadmill's on-screen label.
 *   [8]      magic: 5 for set_speed, 1 otherwise
 *   [9]      incline (always 0 — incline is a mechanical switch)
 *   [10]     weight (kg; default 80)
 *   [11]     reserved
 *   [12]     command nibble + unit bit. 4=start, 2=pause, 0=stop.
 *            OR 0x08 (CMD_UNIT_MPH_BIT) to label the screen in mph.
 *   [13..20] user ID (8 bytes; protocol-default constant)
 *   [21]     XOR checksum of bytes 1..20
 *   [22]     END_BYTE (0x43)
 *
 * @param {'start'|'pause'|'stop'|'set_speed'} type
 * @param {number} [speed=1000] target speed in kph × 1000
 * @returns {Uint8Array}
 */
function makePacket(type, speed = 1000) {
    const arr = new Uint8Array(23);
    arr[0] = BLE.START_BYTE;
    arr[1] = 0x17;
    arr[6] = (speed >> 8) & 0xFF;
    arr[7] = speed & 0xFF;
    arr[8] = type === 'set_speed' ? 5 : 1;
    arr[10] = 80;
    const baseCmd = type === 'pause' ? 2 : type === 'stop' ? 0 : 4;
    arr[12] = unitMode === 'mph'
        ? (baseCmd | BLE.CMD_UNIT_MPH_BIT)
        : (baseCmd & BLE.CMD_KPH_MASK);
    arr.set(USER_ID_BYTES, 13);
    let xor = 0;
    for (let i = 1; i <= 20; ++i) xor ^= arr[i];
    arr[21] = xor;
    arr[22] = BLE.END_BYTE;
    return arr;
}


// ---- 8. Display -----------------------------------------------------------

const STATUS = {
    connecting:   { label: 'Connecting',   cls: 'chip-connecting' },
    running:      { label: 'Running',      cls: 'chip-connected' },
    paused:       { label: 'Paused',       cls: 'chip-paused' },
    stopped:      { label: 'Stopped',      cls: 'chip-paused' },
    disconnected: { label: 'Disconnected', cls: 'chip-disconnected' },
};
function setStatus(state) {
    const { label, cls } = STATUS[state] || STATUS.disconnected;
    statusChip.textContent = label;
    statusChip.className = 'chip ' + cls;
}

function buildDisplayFromRaw(raw) {
    // Notification fields are in the treadmill's reported unit; rawKph/rawKm
    // canonicalize, then we present in the user's chosen unit. Calories/steps
    // use the profile estimate when set, else the firmware value.
    const userUnit = unitOfDistance();
    return {
        distanceDisplay: convertDistance(rawKm(raw), 'km', userUnit).toFixed(2) + ' ' + userUnit,
        calories: profile.weightKg != null ? Math.round(estKcal) : adjustCalories(raw.calories),
        steps:    profile.heightCm != null ? Math.round(estSteps) : raw.steps,
        duration: raw.duration,
    };
}

function updateDashboard(d) {
    distanceDiv.textContent = d?.distanceDisplay ?? '—';
    caloriesDiv.textContent = (d?.calories != null) ? d.calories + ' kcal' : '—';
    stepsDiv.textContent    = (d?.steps != null) ? d.steps : '—';
    durationDiv.textContent = (d?.duration != null) ? formatDuration(d.duration) : '—';
    renderChart();
}

function refreshDashboard() {
    if (lastRaw) updateDashboard(buildDisplayFromRaw(lastRaw));
    else updateDashboard({});
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs, cls) {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (cls) el.setAttribute('class', cls);
    return el;
}

/**
 * Hand-rolled SVG chart of the current session: per-minute average speed on
 * the left axis, cumulative steps on the right axis, plus a faint stepped
 * incline band. 30-minute window, extended by 30 once the user reaches minute
 * 29 (then 59, …). Steps axis starts at 2000, grows by 1000 past 75% full.
 */
function renderChart() {
    if (!sessionChart) return;
    // Match the viewBox to the element's real pixel size (1 unit = 1 px) so
    // text isn't stretched — preserveAspectRatio default keeps it 1:1.
    const VB_H = 160;
    const VB_W = Math.round(sessionChart.clientWidth) || 320;
    const x0 = 30, x1 = VB_W - 30, yTop = 10, yBot = 140;  // right margin = steps axis
    const plotW = x1 - x0, plotH = yBot - yTop;

    const lastMinute = sessionSamples.length - 1;            // -1 if empty
    let windowMin = 30;
    while (lastMinute >= windowMin - 1) windowMin += 30;

    const speedMax = SPEED_RANGE[unitMode].max;
    const inclineScaleMax = INCLINE_GRADE * 4;               // 7% → 25% height

    // Secondary (right) axis: cumulative steps. Starts at 2000, grows by 1000
    // once the count passes 75% of the current top.
    let maxSteps = 0;
    for (const s of sessionSamples) if (s && s.steps > maxSteps) maxSteps = s.steps;
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
            const inc = sessionSamples[m] ? sessionSamples[m].incline : 0;
            dPath += ` L ${xFor(m)} ${yInc(inc)} L ${xFor(m + 1)} ${yInc(inc)}`;
        }
        dPath += ` L ${xFor(lastMinute + 1)} ${yBot} Z`;
        frag.appendChild(svgEl('path', { d: dPath }, 'chart-incline'));
    }

    // speed polyline: last sample of each minute, plotted at the minute centre
    const pts = [];
    for (let m = 0; m <= lastMinute; m++) {
        const s = sessionSamples[m];
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
        const s = sessionSamples[m];
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
        setStatus('disconnected');
        return;
    }
    enableControls(state !== 0);                          // disable during "Starting"
    startBtn.textContent = state === 1 ? 'Pause' : 'Start';
    if      (state === 1) setStatus('running');
    else if (state === 2) setStatus('paused');
    else if (state === 3) setStatus('stopped');
    // state === 0: leave chip as-is (typically "Stopped" → "Starting" briefly)
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
    speedSlider.value = v.toFixed(1);
    sliderValue.textContent = v.toFixed(1);
    renderPresets();
}

function setTargetSpeed(userValue) {
    const r = SPEED_RANGE[unitMode];
    const clamped = Math.min(r.max, Math.max(r.min, userValue));
    curTargetSpeed = userToKU(clamped);
    speedSlider.value = clamped.toFixed(1);
    sliderValue.textContent = clamped.toFixed(1);
    renderPresets();
}

function setUnit(newUnit) {
    if (newUnit !== 'kph' && newUnit !== 'mph') return;
    if (newUnit === unitMode) return;
    unitMode = newUnit;
    localStorage.setItem(PREF_UNIT, unitMode);
    updateSegmentedActive(unitToggle, unitMode);
    // curTargetSpeed is in native units (unit-independent); only the
    // slider/readout presentation changes — the physical target is unchanged,
    // so there's no need to resend a command.
    applyUnitToSlider();
    refreshDashboard();
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

function setIncline(newIncline) {
    const n = Number(newIncline) === INCLINE_GRADE ? INCLINE_GRADE : 0;
    if (n === inclineMode) return;
    inclineMode = n;
    localStorage.setItem(PREF_INCLINE, String(inclineMode));
    updateSegmentedActive(inclineToggle, String(inclineMode));
    refreshDashboard();
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

function updateSegmentedActive(group, value) {
    group.querySelectorAll('.seg').forEach(b => {
        const active = b.dataset.value === String(value);
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}


// ---- 9. History (calendar, day detail, import/export) --------------------

function aggregateByDay(sessions) {
    const map = new Map();
    for (const s of sessions) {
        const n = normalizeSession(s);
        if (!n) continue;
        const key = dayKey(n.date);
        let agg = map.get(key);
        if (!agg) { agg = { distance: 0, calories: 0 }; map.set(key, agg); }
        agg.distance += n.distance;
        agg.calories += n.calories;
    }
    return map;
}

/** All-time totals across stored sessions: distance (user's unit), elevation
 *  climbed (m/ft from each session's incline × distance), and steps. */
function renderLifetime() {
    let dist = 0, steps = 0, climbM = 0;
    for (const s of loadSessions()) {
        const n = normalizeSession(s);
        if (!n) continue;
        dist += n.distance;
        steps += Number(s.steps) || 0;
        const from = s.distanceUnit || (s.speedUnit === 'mph' ? 'mi' : 'km');
        const km = convertDistance(Number(s.distance) || 0, from, 'km');
        const grade = (Number(s.inclineApplied) === INCLINE_GRADE ? INCLINE_GRADE : 0) / 100;
        climbM += km * 1000 * grade;
    }
    lifeDistance.textContent = dist.toFixed(2) + ' ' + unitOfDistance();
    lifeSteps.textContent = Math.round(steps).toLocaleString();
    lifeClimb.textContent = unitOfDistance() === 'mi'
        ? Math.round(climbM * FT_PER_M).toLocaleString() + ' ft'
        : Math.round(climbM).toLocaleString() + ' m';
}

function renderCalendar() {
    renderLifetime();
    const { startOfMonth, endOfMonth, eachDayOfInterval, format } = window.dateFns;
    calMonth.textContent = format(calViewDate, 'MMMM yyyy');

    const monthStart = startOfMonth(calViewDate);
    const days = eachDayOfInterval({ start: monthStart, end: endOfMonth(calViewDate) });
    const leadingPadding = (monthStart.getDay() + 6) % 7;  // Mon=0
    const totals = aggregateByDay(loadSessions());
    const todayKey = dayKey(new Date());
    const unit = unitOfDistance();

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
            cell.addEventListener('click', () => {
                selectedDayKey = (selectedDayKey === key) ? null : key;
                renderCalendar();
                if (selectedDayKey) renderDayDetail(selectedDayKey);
                else clearDayDetail();
            });
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
    header.textContent = `${window.dateFns.format(new Date(sessions[0].date), 'EEEE, MMM d')} — ${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
    dayDetail.appendChild(header);

    for (const s of sessions) {
        const n = normalizeSession(s);
        if (!n) continue;
        const row = document.createElement('div');
        row.className = 'session-row';
        row.append(
            makeField('Time',     window.dateFns.format(new Date(n.date), 'h:mm a')),
            makeField('Distance', `${n.distance.toFixed(2)} ${unit}`),
            makeField('Calories', `${n.calories} kcal`),
        );
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.title = 'Delete';
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
    calViewDate = window.dateFns.addMonths(calViewDate, delta);
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

function importHistory(file) {
    const reader = new FileReader();
    reader.onload = ev => {
        try {
            const parsed = JSON.parse(ev.target.result);
            if (!Array.isArray(parsed)) { showToast('Invalid file format'); return; }
            const cleaned = parsed.map(cleanSession).filter(Boolean);
            saveSessions(cleaned);
            renderCalendar();
            const dropped = parsed.length - cleaned.length;
            showToast(dropped > 0
                ? `Imported ${cleaned.length} (skipped ${dropped})`
                : 'History imported');
        } catch (err) {
            showToast('Failed to import: ' + err.message);
        }
    };
    reader.readAsText(file);
}


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
    pendingCommand = makePacket('set_speed', curTargetSpeed);
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
        b.className = 'preset-btn' + (Math.abs(v - cur) < 0.05 ? ' is-active' : '');
        b.textContent = v % 1 === 0 ? String(v) : v.toFixed(1);
        b.addEventListener('click', () => {
            setTargetSpeed(v);
            if (connected) pendingCommand = makePacket('set_speed', curTargetSpeed);
        });
        presetRow.appendChild(b);
    }
}

// ---- Settings modal -------------------------------------------------------

let modalWeightUnit = 'kg';
let modalHeightUnit = 'cm';

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
    settingsModal.hidden = false;
}

function closeSettings() { settingsModal.hidden = true; }

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
    refreshDashboard();
    showToast('Settings saved');
}

// Connect
connectBtn.addEventListener('click', () => connected ? disconnectBluetooth() : connectBluetooth());

// Start / Stop
startBtn.addEventListener('click', () => {
    if (!connected) return;
    if (runningState === 1) {
        pendingCommand = makePacket('pause');
        return;
    }
    showCountdown();
    pendingCommand = makePacket('start', curTargetSpeed);
});
stopBtn.addEventListener('click', () => {
    if (connected) pendingCommand = makePacket('stop');
});

// Speed buttons + slider
speedUpBtn.addEventListener('click', () => bumpSpeed(+0.1));
speedDownBtn.addEventListener('click', () => bumpSpeed(-0.1));
speedSlider.addEventListener('input', () => {
    sliderValue.textContent = parseFloat(speedSlider.value).toFixed(1);
});
speedSlider.addEventListener('change', () => {
    setTargetSpeed(parseFloat(speedSlider.value));
    if (connected) pendingCommand = makePacket('set_speed', curTargetSpeed);
});

// Segmented toggles
wireSegmented(unitToggle,    setUnit);
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
    tabs.forEach(x => x.classList.toggle('is-active', x === t));
    Object.entries(panels).forEach(([k, p]) => p.classList.toggle('is-active', k === t.dataset.tab));
    if (t.dataset.tab === 'history') renderCalendar();
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

// Init
updateSegmentedActive(unitToggle, unitMode);
updateSegmentedActive(inclineToggle, String(inclineMode));
applyTileVisibility();
applyUnitToSlider();   // also renders presets
updateDashboard({});   // also draws empty chart
updateRunningState(3);
renderCalendar();      // also renders lifetime totals
