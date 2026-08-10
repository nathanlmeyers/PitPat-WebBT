// =============================================================================
// Session records — sanitizing, normalizing, merging, aggregating.
//
// Pure: operates on plain arrays/objects. The localStorage read/write wrappers
// live in treadmill.js; everything that decides what a session *means* is here
// so it can be tested.
//
// Session shape (as stored under `treadmill_sessions`). New sessions are
// written canonically in metric (km / kph); the unit fields are kept so older
// or imported records in mi/mph still convert correctly on render.
//   { date: number,              // ms timestamp — the de-facto primary key
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

import { INCLINE_GRADE, convertDistance } from './units.js';
import { dayKey } from './dates.js';

/** Below these, a record is an accidental tap rather than a workout. */
export const MIN_SESSION_SECONDS = 30;
export const MIN_SESSION_KM = 0.01;   // 10 m

/**
 * Coerce an untrusted object into a canonical session, or return null if it's
 * not recognizable as one. Used by Import to defend localStorage from junk;
 * the renderers stay defensive but data is sanitized here so they don't have
 * to spread that responsibility.
 */
export function cleanSession(raw) {
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

/** The unit a session's distance is recorded in, inferred for older records. */
export function sessionDistanceUnit(s) {
    return s.distanceUnit || (s.speedUnit === 'mph' ? 'mi' : 'km');
}

/**
 * Project a stored session onto `{ date, distance, calories }` in `toUnit`
 * ('km' | 'mi'). Tolerant of older session shapes that lack `distanceUnit` or
 * stored calories as a string.
 */
export function normalizeSession(s, toUnit) {
    if (!s || typeof s.date !== 'number') return null;
    return {
        date:     s.date,
        distance: convertDistance(Number(s.distance) || 0, sessionDistanceUnit(s), toUnit),
        calories: Math.round(Number(s.calories) || 0),
    };
}

/**
 * Merge imported sessions into the existing log rather than replacing it.
 *
 * Import is documented as "restore from a backup", and a restore that silently
 * deletes everything recorded since the export is a data-loss bug. Records are
 * keyed on `date` (the ms timestamp, already the identity used by delete), and
 * existing records win on collision so a stale backup can't clobber newer,
 * more complete data for the same session.
 *
 * @returns {{ sessions: object[], added: number, duplicate: number, skipped: number }}
 */
export function mergeSessions(existing, incoming) {
    const byDate = new Map();
    for (const s of existing) {
        if (s && typeof s.date === 'number') byDate.set(s.date, s);
    }

    let added = 0, duplicate = 0, skipped = 0;
    for (const raw of incoming) {
        const s = cleanSession(raw);
        if (!s) { skipped++; continue; }
        if (byDate.has(s.date)) { duplicate++; continue; }
        byDate.set(s.date, s);
        added++;
    }

    const sessions = [...byDate.values()].sort((a, b) => b.date - a.date);
    return { sessions, added, duplicate, skipped };
}

/** True for records too short or too still to be a real workout. */
export function isJunkSession(s) {
    if (!s) return true;
    const km = convertDistance(Number(s.distance) || 0, sessionDistanceUnit(s), 'km');
    return (Number(s.duration) || 0) < MIN_SESSION_SECONDS || km < MIN_SESSION_KM;
}

/** Map of dayKey → { distance, calories } summed, with distance in `toUnit`. */
export function aggregateByDay(sessions, toUnit) {
    const map = new Map();
    for (const s of sessions) {
        const n = normalizeSession(s, toUnit);
        if (!n) continue;
        const key = dayKey(n.date);
        let agg = map.get(key);
        if (!agg) { agg = { distance: 0, calories: 0 }; map.set(key, agg); }
        agg.distance += n.distance;
        agg.calories += n.calories;
    }
    return map;
}

/**
 * All-time totals: distance in `toUnit`, steps, and vertical climb in metres
 * (Σ session distance × its incline grade).
 */
export function lifetimeTotals(sessions, toUnit) {
    let distance = 0, steps = 0, climbM = 0;
    for (const s of sessions) {
        const n = normalizeSession(s, toUnit);
        if (!n) continue;
        distance += n.distance;
        steps += Number(s.steps) || 0;
        const km = convertDistance(Number(s.distance) || 0, sessionDistanceUnit(s), 'km');
        const grade = (Number(s.inclineApplied) === INCLINE_GRADE ? INCLINE_GRADE : 0) / 100;
        climbM += km * 1000 * grade;
    }
    return { distance, steps, climbM };
}
