import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BLE, STATE, USER_ID_BYTES, decodeNotification, makePacket,
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
