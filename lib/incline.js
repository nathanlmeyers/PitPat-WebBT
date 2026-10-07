// =============================================================================
// Auto-incline detection from motor current.
//
// The pad has no tilt sensor, but its motor-current byte (`real_electricity`,
// byte 40) sits lower when the deck is on the 7% riser: gravity helps pull
// the belt uphill, so the motor works less. Measured at 3.7 kph on one unit:
//   0%  39.6 ± 15.2 per frame      7%  27.1 ± 13.0 per frame
// Useless per frame, but a 30-second average separates the two by ~16 sd.
//
// The level depends on speed (and the walker), so there is no fixed
// threshold. Instead the app learns a baseline for each (speed bucket, grade)
// while the user has the incline set manually, and in Auto mode classifies
// the rolling window against those baselines.
//
// Pure: no DOM, no storage. The app owns persistence and the UI.
// =============================================================================

import { INCLINE_GRADE } from './units.js';

/** Baselines are learned per speed bucket this wide (kph). */
export const SPEED_BUCKET_KPH = 0.5;
/** Frames to ignore after a speed change or start, while the motor settles. */
export const SETTLE_FRAMES = 20;          // ~10 s at 2 Hz
/** Rolling window the decision is made over. */
export const WINDOW_FRAMES = 60;          // ~30 s at 2 Hz
/** Minimum window fill before any decision. */
export const MIN_DECISION_FRAMES = 40;    // ~20 s
/** Baselines closer than this (in motor-current units) can't be trusted. */
export const MIN_SEPARATION = 4;
/** Dead band either side of the midpoint, as a fraction of the separation. */
export const MARGIN_FRACTION = 0.1;
/** Cap on the effective sample count, so baselines keep adapting slowly. */
export const MAX_BASELINE_WEIGHT = 2000;
/** Samples a baseline needs before it is used for detection. */
export const MIN_BASELINE_SAMPLES = 40;   // ~20 s of settled walking

/** "3.5" for 3.4–3.74 kph, etc. Keys are strings so JSON round-trips cleanly. */
export function speedBucket(kph) {
    return (Math.round(kph / SPEED_BUCKET_KPH) * SPEED_BUCKET_KPH).toFixed(1);
}

export function emptyCalibration() {
    return { version: 1, buckets: {} };
}

/** Coerce stored/imported calibration into a usable shape (never throws). */
export function cleanCalibration(raw) {
    const cal = emptyCalibration();
    const buckets = raw && typeof raw === 'object' && raw.buckets && typeof raw.buckets === 'object'
        ? raw.buckets : {};
    for (const [key, grades] of Object.entries(buckets)) {
        if (!/^\d+\.\d$/.test(key) || !grades || typeof grades !== 'object') continue;
        const out = {};
        for (const g of ['0', String(INCLINE_GRADE)]) {
            const b = grades[g];
            if (!b || typeof b !== 'object') continue;
            const mean = Number(b.mean), n = Math.floor(Number(b.n));
            if (!Number.isFinite(mean) || !Number.isFinite(n) || n <= 0) continue;
            out[g] = { mean, n: Math.min(n, MAX_BASELINE_WEIGHT) };
        }
        if (Object.keys(out).length) cal.buckets[key] = out;
    }
    return cal;
}

/**
 * Fold one settled motor-current sample into the baseline for (speed, grade).
 * Running mean with a capped weight: the first samples move it quickly, and
 * after MAX_BASELINE_WEIGHT it behaves like a slow exponential average, so a
 * belt that wears in or a user whose weight changes isn't stuck with stale
 * numbers forever. Mutates and returns `cal`.
 */
export function learnSample(cal, kph, grade, value) {
    const g = grade === INCLINE_GRADE ? String(INCLINE_GRADE) : '0';
    const key = speedBucket(kph);
    const bucket = cal.buckets[key] || (cal.buckets[key] = {});
    const b = bucket[g] || (bucket[g] = { mean: value, n: 0 });
    b.n = Math.min(b.n + 1, MAX_BASELINE_WEIGHT);
    b.mean += (value - b.mean) / b.n;
    return cal;
}

/**
 * The pair of baselines to classify against at this speed, or null if the
 * bucket (or a neighbouring one) doesn't have a usable pair yet.
 *
 * @returns {{ bucket: string, flat: {mean:number,n:number},
 *             grade: {mean:number,n:number}, separation: number } | null}
 */
export function baselinesFor(cal, kph) {
    const centre = Math.round(kph / SPEED_BUCKET_KPH) * SPEED_BUCKET_KPH;
    for (const off of [0, -SPEED_BUCKET_KPH, SPEED_BUCKET_KPH]) {
        const key = (centre + off).toFixed(1);
        const b = cal.buckets[key];
        if (!b) continue;
        const flat = b['0'], grade = b[String(INCLINE_GRADE)];
        if (!flat || !grade) continue;
        if (flat.n < MIN_BASELINE_SAMPLES || grade.n < MIN_BASELINE_SAMPLES) continue;
        const separation = flat.mean - grade.mean;
        // Uphill must read LOWER; anything else is noise or a mislabelled run.
        if (separation < MIN_SEPARATION) continue;
        return { bucket: key, flat, grade, separation };
    }
    return null;
}

/**
 * Classify a window mean against the baselines: 0, INCLINE_GRADE, or null
 * when it falls inside the dead band around the midpoint.
 */
export function classify(baselines, windowMean) {
    if (!baselines || !Number.isFinite(windowMean)) return null;
    const mid = (baselines.flat.mean + baselines.grade.mean) / 2;
    const margin = baselines.separation * MARGIN_FRACTION;
    if (windowMean < mid - margin) return INCLINE_GRADE;
    if (windowMean > mid + margin) return 0;
    return null;
}

/**
 * Rolling window of settled motor-current samples plus the latest decision.
 *
 * "Settled" means: belt running, actual speed equals the commanded speed, and
 * at least SETTLE_FRAMES since the last speed change or start. A stop clears
 * everything — that's when the deck gets moved — while a decision survives
 * speed changes (the window is rebuilt, the grade usually hasn't changed).
 */
export class GradeDetector {
    constructor() { this.reset(); }

    reset() {
        this.window = [];
        this.sinceChange = 0;
        this.lastTarget = null;
        this.decision = null;
    }

    /**
     * Feed one frame. Returns true when the sample was settled and added.
     * @param {{running:boolean, speed:number, target:number, current:number}} f
     *   speed/target in any matching units (raw kph×1000 is fine);
     *   current = motor-current byte.
     */
    push({ running, speed, target, current }) {
        if (!running) {
            const decision = this.decision;
            this.reset();
            this.decision = decision;   // remembered until the next decision
            this.stopped = true;
            return false;
        }
        if (target !== this.lastTarget) {
            this.lastTarget = target;
            this.sinceChange = 0;
            this.window = [];
        }
        this.sinceChange++;
        if (this.sinceChange <= SETTLE_FRAMES) return false;
        if (speed !== target || !Number.isFinite(current)) return false;
        this.window.push(current);
        if (this.window.length > WINDOW_FRAMES) this.window.shift();
        return true;
    }

    get count() { return this.window.length; }

    get windowMean() {
        if (!this.window.length) return NaN;
        let s = 0;
        for (const v of this.window) s += v;
        return s / this.window.length;
    }

    /** Update and return the decision (0 | INCLINE_GRADE | null). Keeps the
     *  previous decision while the window is short or in the dead band. */
    evaluate(baselines) {
        if (this.count < MIN_DECISION_FRAMES) return this.decision;
        const c = classify(baselines, this.windowMean);
        if (c !== null) this.decision = c;
        return this.decision;
    }
}
