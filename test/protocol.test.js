import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BLE, STATE, USER_ID_BYTES, FRAME_FIELDS,
    decodeNotification, decodeExtended, verifyChecksum, toHex, makePacket,
    stepCounterDelta,
} from '../lib/protocol.js';

/** Build a notification frame with raw bytes written by hand, so the test
 *  pins the wire layout rather than re-running the decoder's own arithmetic. */
function frame({ speed = 0, distance = 0, steps = 0, calories = 0, durationMs = 0, flags = 0 } = {}) {
    const a = new Uint8Array(BLE.MIN_PACKET_LEN);
    a[3]  = (speed >> 8) & 0xFF;   a[4]  = speed & 0xFF;
    a[7]  = (distance >>> 24) & 0xFF; a[8]  = (distance >>> 16) & 0xFF;
    a[9]  = (distance >>> 8)  & 0xFF; a[10] = distance & 0xFF;
    a[14] = (steps >>> 24) & 0xFF; a[15] = (steps >>> 16) & 0xFF;
    a[16] = (steps >>> 8)  & 0xFF; a[17] = steps & 0xFF;
    a[18] = (calories >> 8) & 0xFF; a[19] = calories & 0xFF;
    a[20] = (durationMs >>> 24) & 0xFF; a[21] = (durationMs >>> 16) & 0xFF;
    a[22] = (durationMs >>> 8)  & 0xFF; a[23] = durationMs & 0xFF;
    a[26] = flags;
    return new DataView(a.buffer);
}

test('decodeNotification reads every field big-endian at the documented offsets', () => {
    const raw = decodeNotification(frame({
        speed: 3500, distance: 1234, steps: 5000, calories: 120,
        durationMs: 65_000, flags: BLE.FLAG_STATE_RUNNING,
    }));

    assert.equal(raw.current_speed, 3500);
    assert.equal(raw.distance, 1234);
    assert.equal(raw.steps, 5000);
    assert.equal(raw.calories, 120);
    assert.equal(raw.duration, 65);              // ms → whole seconds
    assert.equal(raw.running_state, STATE.RUNNING);
    assert.equal(raw.reported_unit, 'kph');
});

test('decodeNotification maps each flag bit pattern to a run state', () => {
    const stateOf = flags => decodeNotification(frame({ flags })).running_state;
    assert.equal(stateOf(BLE.FLAG_STATE_STARTING), STATE.STARTING);
    assert.equal(stateOf(BLE.FLAG_STATE_RUNNING),  STATE.RUNNING);
    assert.equal(stateOf(BLE.FLAG_STATE_PAUSED),   STATE.PAUSED);
    assert.equal(stateOf(0x00),                    STATE.STOPPED);
});

test('decodeNotification reports the screen unit without changing the values', () => {
    // The mph flag labels the treadmill's screen; speed/distance stay metric.
    const metric = decodeNotification(frame({ speed: 3500, distance: 1234 }));
    const labelled = decodeNotification(frame({
        speed: 3500, distance: 1234, flags: BLE.FLAG_UNIT_MPH,
    }));
    assert.equal(labelled.reported_unit, 'mph');
    assert.equal(labelled.current_speed, metric.current_speed);
    assert.equal(labelled.distance, metric.distance);
});

test('decodeNotification keeps large u32 counters unsigned', () => {
    // The old hand-rolled `<<` decoder went negative past 2^31.
    const raw = decodeNotification(frame({ steps: 0x80000001, distance: 0xFFFFFFFF }));
    assert.equal(raw.steps, 2_147_483_649);
    assert.equal(raw.distance, 4_294_967_295);
});

test('decodeNotification rejects runt and missing frames', () => {
    assert.equal(decodeNotification(null), null);
    assert.equal(decodeNotification(new DataView(new Uint8Array(BLE.MIN_PACKET_LEN - 1).buffer)), null);
});

test('makePacket frames a 23-byte command with a valid checksum', () => {
    const p = makePacket('start', 3500, 'kph');

    assert.equal(p.length, 23);
    assert.equal(p[0], BLE.START_BYTE);
    assert.equal(p[1], 0x17);
    assert.equal(p[22], BLE.END_BYTE);

    // Speed is big-endian kph×1000 at bytes 6..7.
    assert.equal(p[6], 0x0D);
    assert.equal(p[7], 0xAC);

    assert.equal(p[9], 0, 'incline is a mechanical switch, never commanded');
    assert.equal(p[10], 80, 'protocol default weight');
    assert.deepEqual([...p.slice(13, 21)], [...USER_ID_BYTES]);

    // XOR over bytes 1..20 lands in byte 21, so 1..21 must XOR to zero.
    let xor = 0;
    for (let i = 1; i <= 21; i++) xor ^= p[i];
    assert.equal(xor, 0);
});

test('makePacket encodes the command nibble per action', () => {
    assert.equal(makePacket('start',     1000, 'kph')[12], 4);
    assert.equal(makePacket('pause',     1000, 'kph')[12], 2);
    assert.equal(makePacket('stop',      1000, 'kph')[12], 0);
    assert.equal(makePacket('set_speed', 1000, 'kph')[12], 4);

    // Byte 8 distinguishes a speed change from everything else.
    assert.equal(makePacket('set_speed', 1000, 'kph')[8], 5);
    assert.equal(makePacket('start',     1000, 'kph')[8], 1);
});

test('makePacket sets the unit bit without touching the speed value', () => {
    const kph = makePacket('start', 3500, 'kph');
    const mph = makePacket('start', 3500, 'mph');

    assert.equal(mph[12], kph[12] | BLE.CMD_UNIT_MPH_BIT);
    // The speed field is ALWAYS kph×1000 — the unit bit only relabels the
    // treadmill's screen. Getting this wrong ran the belt 1.6× too slow.
    assert.equal(mph[6], kph[6]);
    assert.equal(mph[7], kph[7]);

    let xor = 0;
    for (let i = 1; i <= 21; i++) xor ^= mph[i];
    assert.equal(xor, 0, 'checksum must still be valid with the unit bit set');
});

// ---- Full-frame decoding ---------------------------------------------------

/** Parse "68 34 00 …" / "683400…" into a DataView. */
function fromHex(hex) {
    const clean = hex.replace(/\s+/g, '');
    const a = new Uint8Array(clean.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return new DataView(a.buffer);
}

/** Seal a hand-built frame: write the declared length, checksum, terminator. */
function seal(bytes) {
    bytes[1] = bytes.length;
    let xor = 0;
    for (let i = 1; i <= bytes.length - 3; i++) xor ^= bytes[i];
    bytes[bytes.length - 2] = xor;
    bytes[bytes.length - 1] = BLE.END_BYTE;
    return new DataView(bytes.buffer);
}

// The one published real capture (azmke/pitpat-treadmill-control, idle
// treadmill, 52 bytes). Firmware 27, max speed 6.0 kph, device type 5,
// serial "tlKa191fUpTss603", checksum 0x40.
const REAL_IDLE_FRAME =
    '68 34 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
    '2a 1b 00 17 70 00 05 00 74 6c 4b 61 31 39 31 66 55 70 54 73 73 36 30 33 ' +
    '0e 00 40 43';

test('decodeNotification decodes the published 52-byte real capture', () => {
    const view = fromHex(REAL_IDLE_FRAME);
    assert.equal(view.byteLength, 52);
    const raw = decodeNotification(view);

    assert.equal(raw.frame_len, 52);
    assert.equal(raw.firmware, 27);
    assert.equal(raw.cycle_id, 0x2a);
    assert.equal(raw.max_speed, 6000);
    assert.equal(raw.max_incline, 0);
    assert.equal(raw.device_type, 5);
    assert.equal(raw.running_state, STATE.STOPPED);
    assert.equal(raw.incline, 0);
    assert.equal(raw.heart_rate, 0);
    assert.equal(raw.wifi_connected, false);
    assert.equal(raw.checksum_ok, true);
    assert.equal(verifyChecksum(view), true);
});

test('decodeExtended reads the identity tail on a ≥52-byte frame', () => {
    const ext = decodeExtended(fromHex(REAL_IDLE_FRAME));
    assert.equal(ext.kind, 'identity');
    assert.equal(ext.serial, 'tlKa191fUpTss603');
    assert.equal(ext.ble_model, 0x0e);
    assert.equal(ext.ble_brand, 0);
    assert.equal(ext.bracelet_power, true);   // byte 31 = 0 ≤ 15
});

test('decodeExtended reads the diagnostics tail on a shorter fw≥25 frame', () => {
    const a = new Uint8Array(50);
    a[25] = 27;                       // firmware
    a[32] = 7;                        // carrying_idler
    a[33] = 2;                        // sensor_status
    a[34] = 0x80; a[35] = 0x0A;       // peak: sign bit set → 65535 − 0x800A
    a[36] = 0x01; a[37] = 0x2C;       // grain 300
    a[38] = 0x00; a[39] = 0x64;       // sum_steps 100
    a[40] = 55;                       // real_electricity
    a[41] = 0x04; a[42] = 0xB0;       // real_rotate 1200
    a[43] = 0x00; a[44] = 0x63;       // real_electricity_steps 99
    a[45] = 88;                       // battery
    a[46] = 1;                        // remote_states
    a[47] = 0b00000101;               // buzzer on, factory_rc 0, device_activate 1
    const view = seal(a);

    const ext = decodeExtended(view);
    assert.equal(ext.kind, 'diagnostics');
    assert.equal(ext.carrying_idler, 7);
    assert.equal(ext.sensor_status, 2);
    assert.equal(ext.peak, 65535 - 0x800A);
    assert.equal(ext.grain, 300);
    assert.equal(ext.sum_steps, 100);
    assert.equal(ext.real_electricity, 55);
    assert.equal(ext.real_rotate, 1200);
    assert.equal(ext.real_electricity_steps, 99);
    assert.equal(ext.battery, 88);
    assert.equal(ext.remote_states, 1);
    assert.equal(ext.buzzer_on, true);
    assert.equal(ext.factory_rc, 0);
    assert.equal(ext.device_activate, 1);
    assert.equal(decodeNotification(view).checksum_ok, true);
});

test('decodeExtended returns null for a bare 31-byte frame', () => {
    const a = new Uint8Array(31);
    a[25] = 27;
    assert.equal(decodeExtended(seal(a)), null);
});

test('a bad checksum is reported, not rejected', () => {
    const a = new Uint8Array(31);
    a[25] = 27;
    a[3] = 0x0D; a[4] = 0xAC;        // 3500
    seal(a);
    a[a.length - 2] ^= 0xFF;          // corrupt it
    const raw = decodeNotification(new DataView(a.buffer));
    assert.ok(raw, 'frame still decodes');
    assert.equal(raw.current_speed, 3500);
    assert.equal(raw.checksum_ok, false);
});

test('decodeNotification decodes the mid-frame fields the dashboard ignores', () => {
    const a = new Uint8Array(31);
    a[5] = 0x0B; a[6] = 0xB8;         // target speed 3000
    a[11] = 7;                        // incline
    a[12] = 0b10000011;               // target_incline 3, run_walk_state 2
    a[13] = 120;                      // heart rate
    a[26] = BLE.FLAG_STATE_RUNNING | BLE.FLAG_WIFI;   // bracelet bits 0 → present
    const raw = decodeNotification(seal(a));
    assert.equal(raw.target_speed, 3000);
    assert.equal(raw.incline, 7);
    assert.equal(raw.target_incline, 3);
    assert.equal(raw.run_walk_state, 2);
    assert.equal(raw.heart_rate, 120);
    assert.equal(raw.wifi_connected, true);
    assert.equal(raw.has_bracelet, true);
    assert.equal(raw.running_state, STATE.RUNNING);
});

test('toHex round-trips and FRAME_FIELDS covers the documented bytes without overlap', () => {
    assert.equal(toHex(fromHex('68 34 00 FF')), '68 34 00 FF');
    assert.equal(toHex(null), '');

    let last = -1;
    for (const f of FRAME_FIELDS) {
        assert.ok(f.offset > last, `${f.name} overlaps the previous field`);
        last = f.offset + f.length - 1;
    }
    const byName = Object.fromEntries(FRAME_FIELDS.map(f => [f.name, f]));
    assert.equal(byName.current_speed.offset, BLE.OFFSET_CURRENT_SPEED);
    assert.equal(byName.steps.offset, BLE.OFFSET_STEPS);
    assert.equal(byName.flags.offset, BLE.OFFSET_FLAGS);
    assert.equal(byName.incline.offset, BLE.OFFSET_INCLINE);
});

test('decodeExtended does not mistake a 60-byte diagnostics frame for the identity frame', () => {
    // Real frame from a firmware-37 pad: bytes 32..47 are motor diagnostics
    // (not ASCII), so the vendor app's "≥52 bytes → serial" rule is wrong here.
    const view = fromHex(
        '67 3C 00 0E 74 0E 74 00 00 0D BF 00 00 00 00 00 00 00 01 23 00 42 7F 70 B8 25 ' +
        '8A 17 70 00 05 02 00 00 00 00 00 00 00 00 1C 07 B0 17 CF 00 00 05 00 00 00 00 ' +
        '00 00 00 00 00 00 E0 43');
    const raw = decodeNotification(view);
    assert.equal(raw.frame_len, 60);
    assert.equal(raw.firmware, 37);
    assert.equal(raw.current_speed, 3700);
    assert.equal(raw.steps, 0, 'this firmware leaves the classic steps field at zero');
    assert.equal(raw.checksum_ok, true);
    const ext = decodeExtended(view);
    assert.equal(ext.kind, 'diagnostics');
    assert.equal(ext.real_electricity, 0x1C);
    assert.equal(ext.real_rotate, 0x07B0);
    assert.equal(ext.real_electricity_steps, 0x17CF);
    assert.equal(ext.remote_states, 0);
    assert.equal(ext.buzzer_on, true);
    assert.equal(ext.device_activate, 1);
});

test('stepCounterDelta handles u16 wrap and treats a reset as no steps', () => {
    assert.equal(stepCounterDelta(100, 103), 3);
    assert.equal(stepCounterDelta(65534, 2), 4);       // wrapped
    assert.equal(stepCounterDelta(6130, 0), 0);        // power-cycle reset
    assert.equal(stepCounterDelta(5, 5), 0);
});
