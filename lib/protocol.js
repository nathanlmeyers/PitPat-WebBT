// =============================================================================
// PitPat BLE protocol — GATT identifiers, notification decoding, command frames.
//
// Pure: takes a DataView in, gives plain objects / Uint8Arrays out. No DOM.
// =============================================================================

export const SERVICE_UUID     = "0000fba0-0000-1000-8000-00805f9b34fb";
export const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
export const WRITE_CHAR_UUID  = "0000fba1-0000-1000-8000-00805f9b34fb";

/**
 * PitPat BLE protocol layout.
 *
 * Notification payload (≥ MIN_PACKET_LEN bytes): treadmill → app at ~1 Hz.
 * All multi-byte integers are big-endian.
 *
 *   byte  0           prefix (0x68 on the one published real capture; not validated)
 *   byte  1           frame length
 *   bytes 3..4   u16  current speed × 1000 (kph — see FLAG_UNIT_MPH)
 *   bytes 5..6   u16  target speed × 1000 (kph)
 *   bytes 7..10  u32  distance × 1000      (metres)
 *   byte  11          current incline
 *   byte  12          target incline (low 6 bits) + run/walk state (bits 6-7)
 *   byte  13          heart rate (bpm; 0 without a strap)
 *   bytes 14..17 u32  steps
 *   bytes 18..19 u16  calories (kcal)
 *   bytes 20..23 u32  duration (ms on firmware ≥ 20; cumulative — not reset per session)
 *   byte  24          cycle id
 *   byte  25          firmware version
 *   byte  26          flags: bit 0 wifi, bits 3-4 run state, bits 5-6 bracelet,
 *                     bit 7 = mph label on the treadmill's screen
 *   bytes 27..28 u16  max speed × 1000
 *   byte  29          max incline
 *   byte  30          device type (low 5 bits)
 *   byte  31          bracelet power (firmware > 5)
 *   bytes 32..        extended tail — layout depends on firmware and length,
 *                     see `decodeExtended`
 *   byte  len-2       XOR checksum of bytes 1..len-3
 *   byte  len-1       END_BYTE (0x43)
 *
 * Bytes 0..30 are what every open-source decoder agrees on (pacekeeper,
 * KeiranY/PitPat-WebBT, sirfergy, Razzolate99, trot). The incline / heart-rate
 * / cycle / extended-tail map comes from azmke/pitpat-treadmill-control's
 * `treadmill_data.py`, which was lifted from the vendor app, and is verified
 * here only against azmke's one published 52-byte capture. Treat the tail
 * fields as "what the vendor app calls them" until this hardware confirms.
 *
 * Command packet (23 bytes): app → treadmill, framed by START_BYTE/END_BYTE
 * with an XOR checksum at byte 21. See `makePacket` for full layout.
 */
export const BLE = {
    MIN_PACKET_LEN:      31,
    // notification payload
    OFFSET_FRAME_LEN:     1,
    OFFSET_CURRENT_SPEED: 3,
    OFFSET_TARGET_SPEED:  5,
    OFFSET_DISTANCE:      7,
    OFFSET_INCLINE:      11,
    OFFSET_TARGET_INCLINE: 12,
    OFFSET_HEART_RATE:   13,
    OFFSET_STEPS:        14,
    OFFSET_CALORIES:     18,
    OFFSET_DURATION_MS:  20,
    OFFSET_CYCLE_ID:     24,
    OFFSET_FIRMWARE:     25,
    OFFSET_FLAGS:        26,
    OFFSET_MAX_SPEED:    27,
    OFFSET_MAX_INCLINE:  29,
    OFFSET_DEVICE_TYPE:  30,
    OFFSET_BRACELET_POWER: 31,
    OFFSET_EXTENDED:     32,
    // Reflects the unit shown on the treadmill's SCREEN only. The reported
    // speed/distance values are metric either way, and the command-packet
    // speed is likewise always kph — see the note on `decodeNotification`.
    FLAG_UNIT_MPH:       0x80,
    FLAG_BRACELET_MASK:  0x60,
    FLAG_STATE_MASK:     0x18,
    FLAG_STATE_STARTING: 0x18,
    FLAG_STATE_RUNNING:  0x08,
    FLAG_STATE_PAUSED:   0x10,
    FLAG_WIFI:           0x01,
    // command packet
    START_BYTE:          0x6A,
    END_BYTE:            0x43,
    CMD_UNIT_MPH_BIT:    0x08,   // OR into byte 12 when speaking mph
    CMD_KPH_MASK:        0xF7,   // AND into byte 12 to force kph
};

/** Run states, as decoded from the flags byte. */
export const STATE = { STARTING: 0, RUNNING: 1, PAUSED: 2, STOPPED: 3 };

/**
 * Byte map of the notification frame, for colouring a hex view and for
 * per-field statistics. Ordered by offset; gaps are bytes nobody has named.
 * Tail fields (offset ≥ 32) only apply to the diagnostics-shaped frame — on
 * the identity-shaped frame bytes 32..49 are the serial number and BLE ids.
 */
export const FRAME_FIELDS = [
    { offset: 0,  length: 1, name: 'prefix' },
    { offset: 1,  length: 1, name: 'frame_len' },
    { offset: 3,  length: 2, name: 'current_speed' },
    { offset: 5,  length: 2, name: 'target_speed' },
    { offset: 7,  length: 4, name: 'distance' },
    { offset: 11, length: 1, name: 'incline' },
    { offset: 12, length: 1, name: 'target_incline' },
    { offset: 13, length: 1, name: 'heart_rate' },
    { offset: 14, length: 4, name: 'steps' },
    { offset: 18, length: 2, name: 'calories' },
    { offset: 20, length: 4, name: 'duration_ms' },
    { offset: 24, length: 1, name: 'cycle_id' },
    { offset: 25, length: 1, name: 'firmware' },
    { offset: 26, length: 1, name: 'flags' },
    { offset: 27, length: 2, name: 'max_speed' },
    { offset: 29, length: 1, name: 'max_incline' },
    { offset: 30, length: 1, name: 'device_type' },
    { offset: 31, length: 1, name: 'bracelet_power' },
    { offset: 32, length: 1, name: 'carrying_idler' },
    { offset: 33, length: 1, name: 'sensor_status' },
    { offset: 34, length: 2, name: 'peak' },
    { offset: 36, length: 2, name: 'grain' },
    { offset: 38, length: 2, name: 'sum_steps' },
    { offset: 40, length: 1, name: 'real_electricity' },
    { offset: 41, length: 2, name: 'real_rotate' },
    { offset: 43, length: 2, name: 'real_electricity_steps' },
    { offset: 45, length: 1, name: 'battery' },
    { offset: 46, length: 1, name: 'remote_states' },
    { offset: 47, length: 1, name: 'misc_bits' },
];

// PitPat protocol default user ID — a protocol constant, NOT a personal
// identifier. Every command packet carries the same bytes here.
export const USER_ID_BYTES = (() => {
    const id = 58965456623n;
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; ++i) out[i] = Number((id >> BigInt(56 - i * 8)) & 0xFFn);
    return out;
})();

export const HEARTBEAT = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);

/** Space-separated upper-case hex of a frame, e.g. "68 34 00 …". */
export function toHex(value) {
    if (!value) return '';
    const out = [];
    for (let i = 0; i < value.byteLength; ++i) {
        out.push(value.getUint8(i).toString(16).padStart(2, '0').toUpperCase());
    }
    return out.join(' ');
}

/**
 * Inbound checksum: XOR of bytes 1..len-3 must equal byte len-2, and the
 * frame must end in END_BYTE. Informational — the decoder does not reject
 * frames on failure, since the app has always accepted them unchecked and a
 * single bad frame shouldn't drop a live session.
 */
export function verifyChecksum(value) {
    if (!value || value.byteLength < 4) return false;
    const len = value.byteLength;
    if (value.getUint8(len - 1) !== BLE.END_BYTE) return false;
    let xor = 0;
    for (let i = 1; i <= len - 3; ++i) xor ^= value.getUint8(i);
    return xor === value.getUint8(len - 2);
}

/**
 * Decode a notification frame, or return null if it's too short to trust.
 *
 * Speed and distance come back METRIC (kph×1000, metres) regardless of the
 * unit shown on the treadmill's screen — the FLAG_UNIT_MPH bit reflects only
 * the on-screen label, not the units of these values. A hardware screenshot
 * showed speed reading ~1.6× high back when we multiplied by KM_PER_MI here,
 * which is how we know. `reported_unit` is therefore informational only;
 * nothing downstream should convert based on it.
 *
 * The first seven fields are what the dashboard runs on and are stable. The
 * rest are decoded from the vendor-app byte map (see the layout note above)
 * and are there for the Data tab; none of them drives belt control.
 *
 * @param {DataView} value
 * @returns {{current_speed:number, distance:number, calories:number,
 *            steps:number, duration:number, reported_unit:'kph'|'mph',
 *            running_state:number,
 *            target_speed:number, incline:number, target_incline:number,
 *            run_walk_state:number, heart_rate:number, cycle_id:number,
 *            firmware:number, max_speed:number, max_incline:number,
 *            device_type:number, wifi_connected:boolean, has_bracelet:boolean,
 *            frame_len:number, checksum_ok:boolean} | null}
 */
export function decodeNotification(value) {
    if (!value || value.byteLength < BLE.MIN_PACKET_LEN) return null;

    const flags = value.getUint8(BLE.OFFSET_FLAGS);
    const stateBits = flags & BLE.FLAG_STATE_MASK;
    const running_state =
        stateBits === BLE.FLAG_STATE_STARTING ? STATE.STARTING :
        stateBits === BLE.FLAG_STATE_RUNNING  ? STATE.RUNNING  :
        stateBits === BLE.FLAG_STATE_PAUSED   ? STATE.PAUSED   : STATE.STOPPED;

    const targetInclineByte = value.getUint8(BLE.OFFSET_TARGET_INCLINE);

    // DataView reads big-endian by default, which is the wire order here.
    return {
        current_speed: value.getUint16(BLE.OFFSET_CURRENT_SPEED),   // kph × 1000
        distance:      value.getUint32(BLE.OFFSET_DISTANCE),        // metres
        calories:      value.getUint16(BLE.OFFSET_CALORIES),
        steps:         value.getUint32(BLE.OFFSET_STEPS),
        duration:      Math.round(value.getUint32(BLE.OFFSET_DURATION_MS) / 1000),
        reported_unit: (flags & BLE.FLAG_UNIT_MPH) ? 'mph' : 'kph',
        running_state,

        target_speed:   value.getUint16(BLE.OFFSET_TARGET_SPEED),   // kph × 1000
        incline:        value.getUint8(BLE.OFFSET_INCLINE),
        target_incline: targetInclineByte & 0x3F,
        run_walk_state: (targetInclineByte >> 6) & 0x03,
        heart_rate:     value.getUint8(BLE.OFFSET_HEART_RATE),
        cycle_id:       value.getUint8(BLE.OFFSET_CYCLE_ID),
        firmware:       value.getUint8(BLE.OFFSET_FIRMWARE),
        max_speed:      value.getUint16(BLE.OFFSET_MAX_SPEED),      // kph × 1000
        max_incline:    value.getUint8(BLE.OFFSET_MAX_INCLINE),
        device_type:    value.getUint8(BLE.OFFSET_DEVICE_TYPE) & 0x1F,
        wifi_connected: (flags & BLE.FLAG_WIFI) !== 0,
        // The vendor app treats bracelet bits == 3 as "no bracelet".
        has_bracelet:   ((flags & BLE.FLAG_BRACELET_MASK) >> 5) !== 3,
        frame_len:      value.getUint8(BLE.OFFSET_FRAME_LEN),
        checksum_ok:    verifyChecksum(value),
    };
}

/**
 * Advance of a wrapping u16 counter between two readings. A small backwards
 * step is a wrap (65535 → 3); a large one is a reset, which contributes 0.
 * Used for the motor-side step counter at bytes 43..44, which is the only
 * step count some firmware (37, at least) ever fills in.
 */
export function stepCounterDelta(prev, cur) {
    let d = cur - prev;
    if (d < -32768) d += 65536;
    return d < 0 ? 0 : d;
}

/** Vendor-app sign convention for peak/grain: the top bit flags a negative
 *  value, stored as 0xFFFF − magnitude. */
function signMagnitude16(raw) {
    return (raw & 0x8000) ? 65535 - raw : raw;
}

/**
 * Decode the extended tail (bytes 32 onward), following the vendor app's
 * firmware- and length-gated rule:
 *
 *   firmware ≥ 25 and length ≥ 52 → "identity": serial number + BLE ids
 *   firmware ≥ 25 and length <  52 → "diagnostics": motor / step internals,
 *                                    each field only if the frame is long
 *                                    enough to hold it
 *   firmware <  25                 → serial at 30 or 32 if the frame is long
 *                                    enough, else nothing
 *
 * Returns null for a bare frame with no tail. Everything here is for
 * inspection; the dashboard never reads it.
 *
 * @param {DataView} value
 * @returns {object | null}
 */
export function decodeExtended(value) {
    if (!value || value.byteLength < BLE.MIN_PACKET_LEN) return null;
    const len = value.byteLength;
    const frameLen = value.getUint8(BLE.OFFSET_FRAME_LEN);
    const firmware = value.getUint8(BLE.OFFSET_FIRMWARE);
    const u8  = i => value.getUint8(i);
    const u16 = i => value.getUint16(i);
    const ascii = (start, n) => {
        let s = '';
        for (let i = start; i < start + n && i < len; ++i) {
            const c = u8(i);
            s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '';
        }
        return s;
    };
    const braceletPower = firmware > 5 && len > BLE.OFFSET_BRACELET_POWER
        ? u8(BLE.OFFSET_BRACELET_POWER) <= 15 : null;

    if (firmware < 25) {
        const start = firmware > 5 ? 32 : 30;
        const minLen = firmware > 5 ? 48 : 46;
        if (len < minLen) return null;
        return { kind: 'identity', serial: ascii(start, 16), bracelet_power: braceletPower };
    }

    // The vendor app treats any ≥52-byte frame as the identity frame, but a
    // real firmware-37 pad streams 60-byte frames whose bytes 32..47 are
    // motor diagnostics, not a serial. So only call it identity when the
    // serial slot actually holds printable text.
    const looksLikeSerial = (() => {
        if (len < 48) return false;
        for (let i = 32; i < 48; ++i) {
            const c = u8(i);
            if (c < 0x20 || c >= 0x7F) return false;
        }
        return true;
    })();
    if (len >= 52 && looksLikeSerial) {
        return {
            kind: 'identity',
            serial: ascii(32, 16),
            ble_model: u8(48),
            ble_brand: u8(49),
            bracelet_power: braceletPower,
        };
    }

    if (len <= BLE.OFFSET_EXTENDED) return null;

    const out = { kind: 'diagnostics', bracelet_power: braceletPower };
    // The vendor app gates each field on the declared frame length, not the
    // bytes received; we require both so a short read can't index past the end.
    const has = (declaredMin, lastIndex) => frameLen > declaredMin && len > lastIndex;
    if (has(32, 32)) out.carrying_idler = u8(32);
    if (has(35, 33)) out.sensor_status  = u8(33);
    if (has(39, 39)) {
        out.peak      = signMagnitude16(u16(34));
        out.grain     = signMagnitude16(u16(36));
        out.sum_steps = u16(38);
    }
    if (has(42, 42)) {
        out.real_electricity = u8(40);
        out.real_rotate      = u16(41);
    }
    if (has(44, 44)) out.real_electricity_steps = u16(43);
    if (has(46, 46)) {
        out.battery       = u8(45);
        out.remote_states = u8(46);
    }
    if (len > 47) {
        const b = u8(47);
        out.buzzer_on       = (b & 0x01) !== 0;
        out.factory_rc      = (b >> 1) & 0x01;
        out.device_activate = (b >> 2) & 0x03;
    }
    return out;
}

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
 * @param {'kph'|'mph'} [unitMode='kph'] unit to show on the treadmill's screen
 * @returns {Uint8Array}
 */
export function makePacket(type, speed = 1000, unitMode = 'kph') {
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
