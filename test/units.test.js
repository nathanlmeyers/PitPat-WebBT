import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    KM_PER_MI, KU_MIN, KU_MAX, INCLINE_GRADE,
    unitOfDistance, convertDistance, userToKU, kuToUser,
    formatDuration, adjustCalories, estimateKcalPerMin, strideMeters,
} from '../lib/units.js';

test('unitOfDistance pairs speed units with distance units', () => {
    assert.equal(unitOfDistance('kph'), 'km');
    assert.equal(unitOfDistance('mph'), 'mi');
});

test('convertDistance round-trips and is a no-op for matching units', () => {
    assert.equal(convertDistance(5, 'km', 'km'), 5);
    assert.equal(convertDistance(0, 'km', 'mi'), 0);
    assert.equal(convertDistance(KM_PER_MI, 'km', 'mi'), 1);
    assert.equal(convertDistance(1, 'mi', 'km'), KM_PER_MI);
    assert.ok(Math.abs(convertDistance(convertDistance(7.5, 'km', 'mi'), 'mi', 'km') - 7.5) < 1e-9);
});

test('userToKU converts mph to the treadmill native kph×1000, not straight through', () => {
    // The shipped calibration bug: sending "3.7" meaning mph made the belt run
    // at 3.7 kph (≈2.3 mph). The command field is always kph×1000.
    assert.equal(userToKU(3.7, 'mph'), Math.round(3.7 * KM_PER_MI * 1000));
    assert.notEqual(userToKU(3.7, 'mph'), 3700);
    assert.equal(userToKU(3.7, 'kph'), 3700);
});

test('userToKU clamps to the treadmill hardware range', () => {
    assert.equal(userToKU(0.1, 'kph'), KU_MIN);
    assert.equal(userToKU(99, 'kph'), KU_MAX);
    assert.equal(userToKU(99, 'mph'), KU_MAX);
});

test('kuToUser inverts userToKU within rounding', () => {
    for (const [v, unit] of [[1.0, 'kph'], [3.4, 'kph'], [6.0, 'kph'], [0.7, 'mph'], [2.5, 'mph'], [3.8, 'mph']]) {
        const back = kuToUser(userToKU(v, unit), unit);
        assert.ok(Math.abs(back - v) < 0.001, `${v} ${unit} round-tripped to ${back}`);
    }
});

test('formatDuration switches to h:mm:ss past an hour', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(9), '0:09');
    assert.equal(formatDuration(754), '12:34');
    assert.equal(formatDuration(3599), '59:59');
    assert.equal(formatDuration(3723), '1:02:03');
});

test('formatDuration is defensive about junk input', () => {
    assert.equal(formatDuration(-5), '0:00');
    assert.equal(formatDuration(NaN), '0:00');
    assert.equal(formatDuration(undefined), '0:00');
    assert.equal(formatDuration(12.7), '0:12');
});

test('adjustCalories only scales at the incline grade', () => {
    assert.equal(adjustCalories(100, 0), 100);
    assert.equal(adjustCalories(100, INCLINE_GRADE), 180);
    assert.equal(adjustCalories(0, INCLINE_GRADE), 0);
    assert.equal(adjustCalories('nonsense', INCLINE_GRADE), 0);
});

test('estimateKcalPerMin matches the ACSM walking equation', () => {
    // S = 5 kph → 83.33 m/min; VO2 = 0.1·S + 3.5 = 11.833 ml/kg/min
    // kcal/min = 11.833 · 70 · 5 / 1000 ≈ 4.142
    assert.ok(Math.abs(estimateKcalPerMin(5, 0, 70) - 4.1417) < 0.001);
    // Incline is inside the formula, so 7% must cost more than flat.
    assert.ok(estimateKcalPerMin(5, 0.07, 70) > estimateKcalPerMin(5, 0, 70));
    // Standing still still burns resting VO2 (the 3.5 term).
    assert.ok(estimateKcalPerMin(0, 0, 70) > 0);
});

test('strideMeters scales with height', () => {
    assert.ok(Math.abs(strideMeters(180) - 0.7452) < 1e-9);
    assert.ok(strideMeters(190) > strideMeters(160));
});
