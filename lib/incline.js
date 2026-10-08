// =============================================================================
// Auto-incline detection from motor current.
//
// The pad has no tilt sensor, but its motor-current byte (`real_electricity`,
// byte 40) sits lower when the deck is on the 7% riser: gravity helps move
// the belt underfoot, so the motor works less. Measured at 3.7 kph on one unit:
//   0%  39.6 ± 15.2 per frame      7%  27.1 ± 13.0 per frame
// Individual frames overlap heavily; averages can distinguish the two.
//
// The level depends on speed (and the walker), so there is no fixed
// threshold. Instead the app learns a baseline for each (speed bucket, grade)
// while the user has the incline set manually, and in Auto mode classifies
// the rolling window against those baselines, waiting longer for noisy data.
//
// Pure: no DOM, no storage. The app owns persistence and the UI.
// =============================================================================

import { INCLINE_GRADE } from './units.js';

/** Baselines are learned per speed bucket this wide (kph). */
export const SPEED_BUCKET_KPH = 0.5;
/** Minimum consecutive valid, at-target frames before checking load stability. */
export const SETTLE_FRAMES = 8;           // ~4 s at 2 Hz
/** Rolling window the decision is made over. */
export const WINDOW_FRAMES = 60;          // ~30 s at 2 Hz
/** Minimum window fill before any decision. */
export const MIN_DECISION_FRAMES = 16;    // ~8 s; noisy readings need longer
/** Average short blocks to account for noise shared by nearby frames. */
export const BLOCK_FRAMES = 4;           // ~2 s
// Two estimated standard errors plus the dead band and recent-block agreement.
// Repeated checks and correlated data mean this is not a 95% confidence claim.
const EVIDENCE_MULTIPLIER = 2;
/** Conservative per-frame variance for older, mean-only calibration. */
const LEGACY_VARIANCE = 15 ** 2;
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
    return { version: 2, buckets: {} };
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
            out[g] = { mean, n: Math.min(n, MAX_BASELINE_WEIGHT),
                variance: Number.isFinite(b.variance) && b.variance >= 0
                    ? b.variance : LEGACY_VARIANCE };
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
    const b = bucket[g] || (bucket[g] = { mean: value, n: 0, variance: 0 });
    b.n = Math.min(b.n + 1, MAX_BASELINE_WEIGHT);
    const delta = value - b.mean;
    b.mean += delta / b.n;
    // Weighted population variance; also adapts once the mean's weight is capped.
    b.variance = (1 - 1 / b.n) * ((b.variance ?? LEGACY_VARIANCE) + delta * delta / b.n);
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

/** Sample statistics; variance uses n - 1 to avoid understating short windows. */
function stats(values) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.length > 1
        ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1) : 0;
    return { mean, variance };
}

/**
 * Motor current is noisy and successive frames can be correlated. Compare
 * both raw-sample and two-second block variability, using the larger error.
 * Calibration uncertainty also counts, including for legacy saved baselines.
 * This is a conservative evidence gate, NOT a calibrated probability or a
 * formal sequential test: real walking captures must validate error rates.
 */
function confidentGrade(baselines, samples) {
    if (!baselines || samples.length < MIN_DECISION_FRAMES) return null;
    // Only complete blocks participate; discard the oldest partial block.
    const values = samples.slice(samples.length % BLOCK_FRAMES);
    const blocks = [];
    for (let i = 0; i < values.length; i += BLOCK_FRAMES) {
        blocks.push(stats(values.slice(i, i + BLOCK_FRAMES)).mean);
    }
    const raw = stats(values), grouped = stats(blocks);
    const candidate = classify(baselines, raw.mean);
    if (candidate === null) return null;
    // One unusual block must not pull the entire window into a new grade.
    if (!blocks.slice(-3).every(mean => classify(baselines, mean) === candidate)) return null;
    const baselineError = ((baselines.flat.variance ?? LEGACY_VARIANCE) / baselines.flat.n
        + (baselines.grade.variance ?? LEGACY_VARIANCE) / baselines.grade.n) / 4;
    const error = Math.sqrt(Math.max(raw.variance / values.length,
        grouped.variance / blocks.length, 1 / blocks.length) + baselineError);
    const radius = EVIDENCE_MULTIPLIER * error;
    // The entire evidence interval must lie beyond the midpoint's dead band.
    return classify(baselines, raw.mean - radius) === candidate
        && classify(baselines, raw.mean + radius) === candidate ? candidate : null;
}

/**
 * Collect only consecutive valid frames at the commanded speed. After at
 * least four seconds, compare the two halves of the settling window: an
 * ongoing load trend extends settling instead of imposing a fixed ten seconds.
 * Stops, invalid readings, or speed changes require fresh evidence, but the
 * previous grade remains available as an explicitly unconfirmed fallback.
 */
export class GradeDetector {
    constructor() { this.reset(); }

    reset() {
        this.decision = null;
        this.lastTarget = null;
        this.clearEvidence();
    }

    clearEvidence() {
        this.window = [];
        this.settling = [];
        this.settled = false;
        this.confirmed = false;
    }

    /**
     * Feed one frame. Returns true when a settled sample was added.
     * speed/target use matching units (raw kph×1000 is fine).
     */
    push({ running, speed, target, current }) {
        if (!running || !Number.isFinite(speed) || !Number.isFinite(target)
            || speed <= 0 || speed !== target || !Number.isFinite(current)) {
            this.clearEvidence();
            this.lastTarget = target;
            return false;
        }
        if (target !== this.lastTarget) {
            this.lastTarget = target;
            this.clearEvidence();
        }
        if (!this.settled) {
            this.settling.push(current);
            if (this.settling.length > SETTLE_FRAMES) this.settling.shift();
            if (this.settling.length === SETTLE_FRAMES) {
                const half = SETTLE_FRAMES / 2;
                const first = stats(this.settling.slice(0, half));
                const last = stats(this.settling.slice(half));
                const tolerance = Math.max(2,
                    2 * Math.sqrt((first.variance + last.variance) / half));
                this.settled = Math.abs(first.mean - last.mean) <= tolerance;
            }
            return false;
        }
        this.window.push(current);
        if (this.window.length > WINDOW_FRAMES) this.window.shift();
        this.confirmed = false; // evaluate() must confirm against this new evidence
        return true;
    }

    get count() { return this.window.length; }

    get windowMean() {
        return this.window.length ? stats(this.window).mean : NaN;
    }

    /** Remember the last grade, but confirm it only with current evidence. */
    evaluate(baselines) {
        const grade = confidentGrade(baselines, this.window);
        this.confirmed = grade !== null;
        if (this.confirmed) this.decision = grade;
        return this.decision;
    }
}
