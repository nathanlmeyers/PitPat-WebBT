import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    cleanSession, normalizeSession, mergeSessions, isJunkSession,
    aggregateByDay, lifetimeTotals, sessionDistanceUnit,
    MIN_SESSION_SECONDS,
} from '../lib/sessions.js';
import { INCLINE_GRADE, KM_PER_MI } from '../lib/units.js';

const session = (over = {}) => ({
    date: Date.UTC(2026, 7, 4, 12, 0, 0),
    duration: 1800, steps: 3000, calories: 150, rawCalories: 150,
    distance: 3, distanceUnit: 'km', avgSpeed: 6, speedUnit: 'kph',
    inclineApplied: 0,
    ...over,
});

test('cleanSession rejects anything without a usable timestamp', () => {
    assert.equal(cleanSession(null), null);
    assert.equal(cleanSession('nope'), null);
    assert.equal(cleanSession({}), null);
    assert.equal(cleanSession({ date: 'yesterday' }), null);
    assert.equal(cleanSession({ date: NaN }), null);
});

test('cleanSession coerces strings and clamps negatives', () => {
    const s = cleanSession({ date: 1, duration: '900', steps: '2500.9', calories: '77', distance: '-4' });
    assert.equal(s.duration, 900);
    assert.equal(s.steps, 2500);
    assert.equal(s.calories, 77);
    assert.equal(s.distance, 0);
});

test('cleanSession infers the distance unit from the speed unit on older records', () => {
    assert.equal(cleanSession({ date: 1, speedUnit: 'mph' }).distanceUnit, 'mi');
    assert.equal(cleanSession({ date: 1, speedUnit: 'kph' }).distanceUnit, 'km');
    // An explicit distanceUnit wins over the inference.
    assert.equal(cleanSession({ date: 1, speedUnit: 'mph', distanceUnit: 'km' }).distanceUnit, 'km');
});

test('cleanSession normalizes the incline field to 0 or the grade', () => {
    assert.equal(cleanSession({ date: 1, inclineApplied: INCLINE_GRADE }).inclineApplied, INCLINE_GRADE);
    assert.equal(cleanSession({ date: 1, inclineApplied: 3 }).inclineApplied, 0);
    assert.equal(cleanSession({ date: 1 }).inclineApplied, 0);
});

test('sessionDistanceUnit falls back for records written before the field existed', () => {
    assert.equal(sessionDistanceUnit({ distanceUnit: 'mi' }), 'mi');
    assert.equal(sessionDistanceUnit({ speedUnit: 'mph' }), 'mi');
    assert.equal(sessionDistanceUnit({}), 'km');
});

test('normalizeSession converts stored distance into the requested unit', () => {
    const km = normalizeSession(session({ distance: KM_PER_MI }), 'mi');
    assert.ok(Math.abs(km.distance - 1) < 1e-9);

    const mi = normalizeSession(session({ distance: 1, distanceUnit: 'mi' }), 'km');
    assert.ok(Math.abs(mi.distance - KM_PER_MI) < 1e-9);
});

test('mergeSessions keeps existing records instead of replacing them', () => {
    // The whole point: a "restore from backup" must not delete anything
    // recorded since the backup was taken.
    const existing = [session({ date: 200 }), session({ date: 100 })];
    const incoming = [session({ date: 300 }), session({ date: 50 })];

    const { sessions, added, duplicate, skipped } = mergeSessions(existing, incoming);

    assert.deepEqual(sessions.map(s => s.date), [300, 200, 100, 50]);
    assert.equal(added, 2);
    assert.equal(duplicate, 0);
    assert.equal(skipped, 0);
});

test('mergeSessions dedupes on date and lets the existing record win', () => {
    const existing = [session({ date: 100, steps: 9999 })];
    const incoming = [session({ date: 100, steps: 1 }), session({ date: 101 })];

    const { sessions, added, duplicate } = mergeSessions(existing, incoming);

    assert.equal(sessions.length, 2);
    assert.equal(sessions.find(s => s.date === 100).steps, 9999);
    assert.equal(added, 1);
    assert.equal(duplicate, 1);
});

test('mergeSessions counts unreadable records instead of throwing on them', () => {
    const { sessions, added, skipped } = mergeSessions([], [session({ date: 1 }), null, { junk: true }, 42]);
    assert.equal(sessions.length, 1);
    assert.equal(added, 1);
    assert.equal(skipped, 3);
});

test('mergeSessions tolerates a corrupt existing log', () => {
    const { sessions, added } = mergeSessions([null, { nope: 1 }], [session({ date: 7 })]);
    assert.deepEqual(sessions.map(s => s.date), [7]);
    assert.equal(added, 1);
});

test('isJunkSession filters accidental start/stop taps', () => {
    assert.equal(isJunkSession(session({ duration: 1800, distance: 3 })), false);
    assert.equal(isJunkSession(session({ duration: 2 })), true);
    assert.equal(isJunkSession(session({ distance: 0 })), true);
    assert.equal(isJunkSession(session({ duration: MIN_SESSION_SECONDS - 1 })), true);
    assert.equal(isJunkSession(null), true);
});

test('aggregateByDay sums sessions per local day in the requested unit', () => {
    const day = new Date(2026, 7, 4, 9, 0, 0).getTime();
    const later = new Date(2026, 7, 4, 18, 0, 0).getTime();
    const other = new Date(2026, 7, 5, 9, 0, 0).getTime();

    const map = aggregateByDay([
        session({ date: day,   distance: 2, calories: 100 }),
        session({ date: later, distance: 3, calories: 150 }),
        session({ date: other, distance: 1, calories: 50 }),
    ], 'km');

    assert.equal(map.size, 2);
    assert.equal(map.get('2026-08-04').distance, 5);
    assert.equal(map.get('2026-08-04').calories, 250);
    assert.equal(map.get('2026-08-05').distance, 1);
});

test('lifetimeTotals only counts climb for inclined sessions', () => {
    const flat = lifetimeTotals([session({ distance: 10, inclineApplied: 0 })], 'km');
    assert.equal(flat.climbM, 0);
    assert.equal(flat.distance, 10);

    const hill = lifetimeTotals([session({ distance: 10, inclineApplied: INCLINE_GRADE })], 'km');
    assert.ok(Math.abs(hill.climbM - 700) < 1e-9);   // 10 km × 7%
});

test('lifetimeTotals converts mixed-unit history to one unit', () => {
    const { distance } = lifetimeTotals([
        session({ distance: 1, distanceUnit: 'km' }),
        session({ date: 2, distance: 1, distanceUnit: 'mi' }),
    ], 'km');
    assert.ok(Math.abs(distance - (1 + KM_PER_MI)) < 1e-9);
});
