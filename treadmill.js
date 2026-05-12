// treadmill.js - PitPat Treadmill Control Dashboard

// --- Bluetooth UUIDs ---
const SERVICE_UUID = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fba1-0000-1000-8000-00805f9b34fb";

// --- UI Elements ---
const connectBtn = document.getElementById('connectBtn');
const speedDiv = document.getElementById('speed');
const distanceDiv = document.getElementById('distance');
const caloriesDiv = document.getElementById('calories');
const stepsDiv = document.getElementById('steps');
const durationDiv = document.getElementById('duration');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const speedUpBtn = document.getElementById('speedUpBtn');
const speedDownBtn = document.getElementById('speedDownBtn');
const speedSlider = document.getElementById('speedSlider');
const sliderValue = document.getElementById('sliderValue');
const sliderUnit = document.getElementById('sliderUnit');
const statusChip = document.getElementById('statusChip');
const loadingOverlay = document.getElementById('loadingOverlay');
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownNumber = document.getElementById('countdownNumber');
const importHistoryBtn = document.getElementById('importHistoryBtn');
const exportHistoryBtn = document.getElementById('exportHistoryBtn');
const importHistoryInput = document.getElementById('importHistoryInput');
const toastEl = document.getElementById('toast');
const unitToggle = document.getElementById('unitToggle');
const inclineToggle = document.getElementById('inclineToggle');
const tabs = document.querySelectorAll('.tab');
const panels = { controls: document.getElementById('controls-panel'), history: document.getElementById('history-panel') };
const calGrid = document.getElementById('calGrid');
const calMonth = document.getElementById('calMonth');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');
const dayDetail = document.getElementById('dayDetail');

// --- Persistent prefs ---
const PREF_UNIT = 'treadmill_unit';      // 'kph' | 'mph'
const PREF_INCLINE = 'treadmill_incline';// '0' | '3'
const INCLINE_KCAL_FACTOR = 1.30;        // ~3% grade increases kcal by ~30%
const KM_PER_MI = 1.609344;

let unitMode = (localStorage.getItem(PREF_UNIT) === 'mph') ? 'mph' : 'kph';
let inclineMode = (localStorage.getItem(PREF_INCLINE) === '3') ? 3 : 0;

// --- Session History ---
let sessionActive = false;
let sessionStartData = null;
let calViewDate = startOfThisMonth();
let selectedDayKey = null;

function loadSessions() {
    try {
        const s = JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
        return Array.isArray(s) ? s : [];
    } catch { return []; }
}
function saveSessions(sessions) {
    localStorage.setItem('treadmill_sessions', JSON.stringify(sessions));
}
function deleteSessionByDate(dateTs) {
    const sessions = loadSessions().filter(s => s.date !== dateTs);
    saveSessions(sessions);
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

// --- State ---
let device = null;
let server = null;
let notifyChar = null;
let writeChar = null;
let treadmillData = {};
let connected = false;
let runningState = 3; // 0:Starting 1:Running 2:Paused 3:Stopped
let curTargetSpeed = 1000; // user-facing target * 1000, interpreted by treadmill in current unit

// --- Helpers ---
function startOfThisMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
}
function dayKey(d) {
    const date = d instanceof Date ? d : new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0 || h > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
}
function setStatus(state) {
    let label = 'Disconnected', cls = 'chip-disconnected';
    if (state === 'connecting') { label = 'Connecting'; cls = 'chip-connecting'; }
    else if (state === 'running') { label = 'Running'; cls = 'chip-connected'; }
    else if (state === 'paused') { label = 'Paused'; cls = 'chip-paused'; }
    else if (state === 'stopped') { label = 'Stopped'; cls = 'chip-paused'; }
    statusChip.textContent = label;
    statusChip.className = 'chip ' + cls;
}

// Apply incline kcal correction. Returns adjusted calories (rounded).
function adjustCalories(rawKcal) {
    const n = Number(rawKcal) || 0;
    if (inclineMode === 3) return Math.round(n * INCLINE_KCAL_FACTOR);
    return Math.round(n);
}

// Convert a distance value from one unit to another.
function convertDistance(value, from, to) {
    if (!value || from === to) return value;
    return from === 'km' ? value / KM_PER_MI : value * KM_PER_MI;
}
function unitOfDistance() { return unitMode === 'mph' ? 'mi' : 'km'; }

function updateDashboard(d) {
    speedDiv.textContent = d.speedDisplay || '—';
    distanceDiv.textContent = d.distanceDisplay || '—';
    caloriesDiv.textContent = (d.calories !== undefined && d.calories !== null)
        ? adjustCalories(d.calories) + ' kcal'
        : '—';
    stepsDiv.textContent = (d.steps !== undefined && d.steps !== null) ? d.steps : '—';
    durationDiv.textContent = d.duration !== undefined ? formatDuration(d.duration) : '—';
}

function enableControls(enable) {
    startBtn.disabled = !enable;
    stopBtn.disabled = !enable;
    speedUpBtn.disabled = !enable;
    speedDownBtn.disabled = !enable;
    speedSlider.disabled = !enable;
}

function updateRunningState(state) {
    runningState = state;
    if (!connected) {
        enableControls(false);
        startBtn.textContent = 'Start';
        setStatus('disconnected');
        return;
    }
    switch (state) {
        case 0:
            enableControls(false);
            startBtn.textContent = 'Start';
            break;
        case 1:
            enableControls(true);
            startBtn.textContent = 'Pause';
            setStatus('running');
            break;
        case 2:
            enableControls(true);
            startBtn.textContent = 'Start';
            setStatus('paused');
            break;
        case 3:
        default:
            enableControls(true);
            startBtn.textContent = 'Start';
            setStatus('stopped');
    }
}

// --- Slider / unit handling ---
function applyUnitToSlider() {
    if (unitMode === 'kph') {
        speedSlider.min = '1';
        speedSlider.max = '6';
        speedSlider.step = '0.1';
        sliderUnit.textContent = ' kph';
    } else {
        speedSlider.min = '0.6';
        speedSlider.max = '3.7';
        speedSlider.step = '0.1';
        sliderUnit.textContent = ' mph';
    }
    // Sync slider value to curTargetSpeed (which is user-facing × 1000 in CURRENT unit)
    const v = (curTargetSpeed / 1000);
    speedSlider.value = String(v);
    sliderValue.textContent = v.toFixed(1);
}

function setUnit(newUnit) {
    if (newUnit !== 'kph' && newUnit !== 'mph') return;
    if (newUnit === unitMode) return;
    // Convert curTargetSpeed so the physical pace stays the same.
    const currentVal = curTargetSpeed / 1000;
    const newVal = unitMode === 'kph' ? currentVal / KM_PER_MI : currentVal * KM_PER_MI;
    const newMin = newUnit === 'kph' ? 1.0 : 0.6;
    const newMax = newUnit === 'kph' ? 6.0 : 3.7;
    curTargetSpeed = Math.round(Math.min(newMax, Math.max(newMin, newVal)) * 1000);
    unitMode = newUnit;
    localStorage.setItem(PREF_UNIT, unitMode);
    updateSegmentedActive(unitToggle, unitMode);
    applyUnitToSlider();
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
    if (connected) send_data(makePacket('set_speed', curTargetSpeed));
}

function setIncline(newIncline) {
    const n = Number(newIncline) === 3 ? 3 : 0;
    if (n === inclineMode) return;
    inclineMode = n;
    localStorage.setItem(PREF_INCLINE, String(inclineMode));
    updateSegmentedActive(inclineToggle, String(inclineMode));
    // Re-render dashboard with current data using new adjustment
    if (treadmillData && treadmillData._raw) {
        updateDashboard(buildDisplayFromRaw(treadmillData._raw));
    } else {
        updateDashboard(treadmillData || {});
    }
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

function updateSegmentedActive(group, value) {
    group.querySelectorAll('.seg').forEach(b => {
        b.classList.toggle('is-active', b.dataset.value === String(value));
    });
}

// --- Data sending ---
let pendingData = null;
function send_data(packet) { pendingData = packet; }

// --- Bluetooth ---
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
        writeChar = await service.getCharacteristic(WRITE_CHAR_UUID);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        connected = true;
        setStatus('stopped');
        connectBtn.textContent = 'Disconnect';
        updateRunningState(3);
        loadingOverlay.hidden = true;
        // Push the user's chosen unit to the treadmill on connect.
        send_data(makePacket('set_speed', curTargetSpeed));
    } catch (err) {
        console.error('Bluetooth connection error:', err);
        showToast('Bluetooth error: ' + err.message);
        setStatus('disconnected');
        connected = false;
        connectBtn.textContent = 'Connect';
        loadingOverlay.hidden = true;
    }
}

function disconnectBluetooth() {
    if (device && device.gatt.connected) device.gatt.disconnect();
    loadingOverlay.hidden = true;
}

function onDisconnected() {
    connected = false;
    setStatus('disconnected');
    connectBtn.textContent = 'Connect';
    updateRunningState(3);
    if (sessionActive && sessionStartData) finishSession();
}

function buildDisplayFromRaw(raw) {
    // raw: { current_speed, distance, calories, steps, duration, speed_unit }
    const distVal = raw.distance / 1000;
    const distUnit = raw.speed_unit === 'mph' ? 'mi' : 'km';
    // Display distance in user's chosen unit
    const userUnit = unitOfDistance();
    const distInUserUnit = convertDistance(distVal, distUnit, userUnit);
    return {
        speedDisplay: (raw.current_speed / 1000).toFixed(2) + ' ' + raw.speed_unit,
        distanceDisplay: distInUserUnit.toFixed(2) + ' ' + userUnit,
        calories: raw.calories,
        steps: raw.steps,
        duration: raw.duration,
        _raw: raw
    };
}

function handleNotification(event) {
    const value = event.target.value;
    if (value.byteLength < 31) {
        updateDashboard({});
        updateRunningState(3);
        if (sessionActive && sessionStartData) finishSession();
        return;
    }
    const u16 = o => (value.getUint8(o) << 8) | value.getUint8(o + 1);
    const u32 = o => (value.getUint8(o) << 24) | (value.getUint8(o + 1) << 16) | (value.getUint8(o + 2) << 8) | value.getUint8(o + 3);

    const current_speed = u16(3);
    const distance = u32(7);
    const calories = (value.getUint8(18) << 8) | value.getUint8(19);
    const steps = u32(14);
    const duration_ms = u32(20);
    const flags = value.getUint8(26);
    const unit_mode = (flags & 128) === 128 ? 1 : 0;
    const running_state_bits = flags & 24;
    let new_running = 3;
    if (running_state_bits === 24) new_running = 0;
    else if (running_state_bits === 8) new_running = 1;
    else if (running_state_bits === 16) new_running = 2;

    const speed_unit = unit_mode === 1 ? 'mph' : 'kph';
    const raw = { current_speed, distance, calories, steps, duration: Math.round(duration_ms / 1000), speed_unit };
    treadmillData = buildDisplayFromRaw(raw);
    updateDashboard(treadmillData);
    updateRunningState(new_running);

    // Session tracking
    if (new_running === 1 && !sessionActive) {
        sessionActive = true;
        sessionStartData = {
            date: Date.now(),
            steps, calories, distance,
            duration: raw.duration,
            speedSum: current_speed, speedCount: 1,
            speedUnit: speed_unit
        };
        upsertLiveSession();
    } else if (new_running === 1 && sessionActive && sessionStartData) {
        sessionStartData.steps = steps;
        sessionStartData.calories = calories;
        sessionStartData.distance = distance;
        sessionStartData.duration = raw.duration;
        sessionStartData.speedSum += current_speed;
        sessionStartData.speedCount += 1;
        upsertLiveSession();
    } else if ((new_running === 2 || new_running === 3) && sessionActive && sessionStartData) {
        finishSession();
    }

    // Heartbeat / pending command
    if (writeChar) {
        if (pendingData) {
            writeChar.writeValue(pendingData).then(() => { pendingData = null; })
                .catch(err => console.error('Failed to send pending data:', err));
        } else {
            const heartbeat = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);
            writeChar.writeValue(heartbeat).catch(err => console.error('Heartbeat failed:', err));
        }
    }
}

function upsertLiveSession() {
    if (!sessionStartData) return;
    const s = sessionStartData;
    const avgSpeed = (s.speedSum / s.speedCount) / 1000;
    const distVal = s.distance / 1000;
    const distUnit = s.speedUnit === 'mph' ? 'mi' : 'km';
    const session = {
        date: s.date,
        duration: s.duration,
        steps: s.steps,
        calories: adjustCalories(s.calories),
        rawCalories: s.calories,
        distance: distVal,
        distanceUnit: distUnit,
        avgSpeed,
        speedUnit: s.speedUnit,
        inclineApplied: inclineMode
    };
    let sessions = loadSessions();
    if (sessions.length > 0 && sessions[0] && sessions[0].date === session.date) {
        sessions[0] = session;
    } else {
        sessions.unshift(session);
    }
    saveSessions(sessions);
    renderCalendar();
    if (selectedDayKey) renderDayDetail(selectedDayKey);
}

function finishSession() {
    sessionActive = false;
    sessionStartData = null;
}

// --- Command packets ---
function makePacket(type, speed = 1000) {
    const arr = new Uint8Array(23);
    arr[0] = 0x6A;
    arr[1] = 0x17;
    arr[6] = (speed >> 8) & 0xFF;
    arr[7] = speed & 0xFF;
    arr[8] = type === 'set_speed' ? 5 : 1;
    arr[9] = 0;
    arr[10] = 80;
    arr[11] = 0;
    let cmd = type === 'pause' ? 2 : type === 'stop' ? 0 : 4;
    // Bit 3 of byte 12 selects units: 0 = kph, 1 = mph
    arr[12] = unitMode === 'mph' ? (cmd | 0x08) : (cmd & 0xF7);
    let userId = 58965456623n;
    for (let i = 0; i < 8; ++i) {
        arr[13 + i] = Number((userId >> BigInt(56 - i * 8)) & 0xFFn);
    }
    let checksum = 0;
    for (let i = 1; i <= 20; ++i) checksum ^= arr[i];
    arr[21] = checksum;
    arr[22] = 0x43;
    return arr;
}

// --- Calendar rendering ---
function aggregateByDay(sessions) {
    const map = new Map();
    for (const s of sessions) {
        if (!s || typeof s.date !== 'number') continue;
        const key = dayKey(s.date);
        let agg = map.get(key);
        if (!agg) {
            agg = { distance: 0, calories: 0, sessions: [] };
            map.set(key, agg);
        }
        // Distance: normalize to user's current unit
        const sUnit = s.distanceUnit || (s.speedUnit === 'mph' ? 'mi' : 'km');
        agg.distance += convertDistance(Number(s.distance) || 0, sUnit, unitOfDistance());
        // Calories: stored adjusted; if from older sessions stored as string with ' kcal', strip it
        let kcal = s.calories;
        if (typeof kcal === 'string') kcal = parseFloat(kcal) || 0;
        agg.calories += Number(kcal) || 0;
        agg.sessions.push(s);
    }
    return map;
}

function renderCalendar() {
    const { startOfMonth, endOfMonth, eachDayOfInterval, format, addMonths } = dateFns;
    const view = calViewDate;
    calMonth.textContent = format(view, 'MMMM yyyy');

    const monthStart = startOfMonth(view);
    const monthEnd = endOfMonth(view);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

    // Monday-first padding
    const dow = (monthStart.getDay() + 6) % 7; // 0=Mon
    const totals = aggregateByDay(loadSessions());
    const today = new Date();
    const todayKey = dayKey(today);

    calGrid.innerHTML = '';
    for (let i = 0; i < dow; i++) {
        const cell = document.createElement('div');
        cell.className = 'cal-day is-outside is-empty';
        calGrid.appendChild(cell);
    }
    const unit = unitOfDistance();
    for (const d of days) {
        const key = dayKey(d);
        const t = totals.get(key);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day' + (t ? '' : ' is-empty');
        if (key === todayKey) cell.classList.add('is-today');
        if (key === selectedDayKey) cell.classList.add('is-selected');
        cell.dataset.day = key;
        const num = document.createElement('div');
        num.className = 'cal-day-num';
        num.textContent = String(d.getDate());
        cell.appendChild(num);
        if (t) {
            const totalsEl = document.createElement('div');
            totalsEl.className = 'cal-day-totals';
            const dist = document.createElement('div');
            dist.className = 'dist';
            dist.textContent = t.distance.toFixed(2) + ' ' + unit;
            const kcal = document.createElement('div');
            kcal.className = 'kcal';
            kcal.textContent = Math.round(t.calories) + ' kcal';
            totalsEl.appendChild(dist);
            totalsEl.appendChild(kcal);
            cell.appendChild(totalsEl);
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
    const sessions = loadSessions().filter(s => s && typeof s.date === 'number' && dayKey(s.date) === key);
    dayDetail.replaceChildren();
    if (sessions.length === 0) {
        dayDetail.hidden = true;
        return;
    }
    sessions.sort((a, b) => b.date - a.date);
    const unit = unitOfDistance();

    const header = document.createElement('div');
    header.className = 'day-detail-header';
    header.textContent = `${dateFns.format(new Date(sessions[0].date), 'EEEE, MMM d')} — ${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
    dayDetail.appendChild(header);

    for (const s of sessions) {
        const sUnit = s.distanceUnit || (s.speedUnit === 'mph' ? 'mi' : 'km');
        const dist = convertDistance(Number(s.distance) || 0, sUnit, unit).toFixed(2);
        const kcal = Math.round(Number(s.calories) || 0);
        const time = dateFns.format(new Date(s.date), 'h:mm a');

        const row = document.createElement('div');
        row.className = 'session-row';
        row.appendChild(makeField('Time', time));
        row.appendChild(makeField('Distance', `${dist} ${unit}`));
        row.appendChild(makeField('Calories', `${kcal} kcal`));
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
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = value;
    wrap.appendChild(l);
    wrap.appendChild(v);
    return wrap;
}

// --- Event wiring ---
connectBtn.addEventListener('click', () => {
    if (!connected) connectBluetooth();
    else disconnectBluetooth();
});

startBtn.addEventListener('click', () => {
    if (!connected) return;
    if (runningState === 1) {
        send_data(makePacket('pause'));
        return;
    }
    // Countdown overlay (cosmetic; command is queued immediately)
    countdownOverlay.hidden = false;
    countdownOverlay.style.opacity = '1';
    let count = 3;
    countdownNumber.textContent = String(count);
    countdownNumber.style.opacity = '1';
    countdownNumber.style.transform = 'scale(1)';
    (async () => {
        for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 700));
            countdownNumber.style.transform = 'scale(1.3)';
            countdownNumber.style.opacity = '0.5';
            await new Promise(r => setTimeout(r, 200));
            count--;
            if (count > 0) {
                countdownNumber.textContent = String(count);
                countdownNumber.style.opacity = '1';
                countdownNumber.style.transform = 'scale(1)';
            }
        }
        await new Promise(r => setTimeout(r, 400));
        countdownOverlay.style.opacity = '0';
        await new Promise(r => setTimeout(r, 500));
        countdownOverlay.hidden = true;
        countdownOverlay.style.opacity = '1';
    })();
    send_data(makePacket('start', curTargetSpeed));
});

stopBtn.addEventListener('click', () => {
    if (!connected) return;
    send_data(makePacket('stop'));
});

speedUpBtn.addEventListener('click', () => {
    if (!connected) return;
    const max = unitMode === 'kph' ? 6000 : 3700;
    curTargetSpeed = Math.min(curTargetSpeed + 100, max);
    speedSlider.value = (curTargetSpeed / 1000).toFixed(1);
    sliderValue.textContent = (curTargetSpeed / 1000).toFixed(1);
    send_data(makePacket('set_speed', curTargetSpeed));
});

speedDownBtn.addEventListener('click', () => {
    if (!connected) return;
    const min = unitMode === 'kph' ? 1000 : 600;
    curTargetSpeed = Math.max(curTargetSpeed - 100, min);
    speedSlider.value = (curTargetSpeed / 1000).toFixed(1);
    sliderValue.textContent = (curTargetSpeed / 1000).toFixed(1);
    send_data(makePacket('set_speed', curTargetSpeed));
});

speedSlider.addEventListener('input', () => {
    sliderValue.textContent = parseFloat(speedSlider.value).toFixed(1);
});
speedSlider.addEventListener('change', () => {
    curTargetSpeed = Math.round(parseFloat(speedSlider.value) * 1000);
    if (!connected) return;
    send_data(makePacket('set_speed', curTargetSpeed));
});

// Segmented toggles
unitToggle.addEventListener('click', e => {
    const btn = e.target.closest('.seg');
    if (btn) setUnit(btn.dataset.value);
});
inclineToggle.addEventListener('click', e => {
    const btn = e.target.closest('.seg');
    if (btn) setIncline(btn.dataset.value);
});

// Tabs
tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('is-active', x === t));
    Object.entries(panels).forEach(([k, p]) => p.classList.toggle('is-active', k === t.dataset.tab));
    if (t.dataset.tab === 'history') renderCalendar();
}));

function clearDayDetail() {
    selectedDayKey = null;
    dayDetail.hidden = true;
    dayDetail.replaceChildren();
}

// Calendar nav
prevMonthBtn.addEventListener('click', () => {
    calViewDate = dateFns.addMonths(calViewDate, -1);
    clearDayDetail();
    renderCalendar();
});
nextMonthBtn.addEventListener('click', () => {
    calViewDate = dateFns.addMonths(calViewDate, 1);
    clearDayDetail();
    renderCalendar();
});

// Import / Export
exportHistoryBtn.addEventListener('click', () => {
    const sessions = loadSessions();
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'treadmill_sessions.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    showToast('History exported');
});

importHistoryBtn.addEventListener('click', () => {
    importHistoryInput.value = '';
    importHistoryInput.click();
});
importHistoryInput.addEventListener('change', () => {
    const file = importHistoryInput.files && importHistoryInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        try {
            const imported = JSON.parse(ev.target.result);
            if (Array.isArray(imported)) {
                saveSessions(imported);
                renderCalendar();
                showToast('History imported');
            } else showToast('Invalid file format');
        } catch (err) {
            showToast('Failed to import: ' + err.message);
        }
    };
    reader.readAsText(file);
});

// --- Toast ---
let toastTimer = null;
function showToast(message, timeout = 3500) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, timeout);
}

// --- Initialize ---
updateSegmentedActive(unitToggle, unitMode);
updateSegmentedActive(inclineToggle, String(inclineMode));
applyUnitToSlider();
updateDashboard({});
updateRunningState(3);
renderCalendar();
