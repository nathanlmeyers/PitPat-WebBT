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
 *   bytes 3..4   u16  current speed × 1000 (kph — see FLAG_UNIT_MPH)
 *   bytes 7..10  u32  distance × 1000      (metres)
 *   bytes 14..17 u32  steps
 *   bytes 18..19 u16  calories (kcal)
 *   bytes 20..23 u32  duration (ms, cumulative — not reset per session)
 *   byte  26          flags (bit 7 = mph label; bits 3-4 encode run state)
 *
 * Command packet (23 bytes): app → treadmill, framed by START_BYTE/END_BYTE
 * with an XOR checksum at byte 21. See `makePacket` for full layout.
 */
export const BLE = {
    MIN_PACKET_LEN:      31,
    // notification payload
    OFFSET_CURRENT_SPEED: 3,
    OFFSET_DISTANCE:      7,
    OFFSET_STEPS:        14,
    OFFSET_CALORIES:     18,
    OFFSET_DURATION_MS:  20,
    OFFSET_FLAGS:        26,
    // Reflects the unit shown on the treadmill's SCREEN only. The reported
    // speed/distance values are metric either way, and the command-packet
    // speed is likewise always kph — see the note on `decodeNotification`.
    FLAG_UNIT_MPH:       0x80,
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

/** Run states, as decoded from the flags byte. */
export const STATE = { STARTING: 0, RUNNING: 1, PAUSED: 2, STOPPED: 3 };

// PitPat protocol default user ID — a protocol constant, NOT a personal
// identifier. Every command packet carries the same bytes here.
export const USER_ID_BYTES = (() => {
    const id = 58965456623n;
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; ++i) out[i] = Number((id >> BigInt(56 - i * 8)) & 0xFFn);
    return out;
})();

export const HEARTBEAT = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);

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
 * @param {DataView} value
 * @returns {{current_speed:number, distance:number, calories:number,
 *            steps:number, duration:number, reported_unit:'kph'|'mph',
 *            running_state:number} | null}
 */
export function decodeNotification(value) {
    if (!value || value.byteLength < BLE.MIN_PACKET_LEN) return null;

    const flags = value.getUint8(BLE.OFFSET_FLAGS);
    const stateBits = flags & BLE.FLAG_STATE_MASK;
    const running_state =
        stateBits === BLE.FLAG_STATE_STARTING ? STATE.STARTING :
        stateBits === BLE.FLAG_STATE_RUNNING  ? STATE.RUNNING  :
        stateBits === BLE.FLAG_STATE_PAUSED   ? STATE.PAUSED   : STATE.STOPPED;

    // DataView reads big-endian by default, which is the wire order here.
    return {
        current_speed: value.getUint16(BLE.OFFSET_CURRENT_SPEED),   // kph × 1000
        distance:      value.getUint32(BLE.OFFSET_DISTANCE),        // metres
        calories:      value.getUint16(BLE.OFFSET_CALORIES),
        steps:         value.getUint32(BLE.OFFSET_STEPS),
        duration:      Math.round(value.getUint32(BLE.OFFSET_DURATION_MS) / 1000),
        reported_unit: (flags & BLE.FLAG_UNIT_MPH) ? 'mph' : 'kph',
        running_state,
    };
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
