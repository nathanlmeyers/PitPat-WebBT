// =============================================================================
// Auto-incline detection from motor current.
//
// The pad has no tilt sensor, but its motor-current byte (`real_electricity`,
// byte 40) sits lower when the deck is on the 7% riser: gravity helps move
// the belt underfoot, so the motor works less. Measured on one unit, one walker:
//   kph    0% (flat)           7% (riser)
//   3.0    40.0 ± 12.3 (71)    26.4 ± 10.8 (127)
//   3.7    39.6 ± 15.2 (825)   27.1 ± 13.0 (450)
//   4.5    39.7 ± 18.3 (1041)  27.5 ± 15.2 (717)
// Individual frames overlap heavily; averages distinguish the two. Across the
// walking range the levels barely move with speed, but the noise grows.
//
// Those measurements ship as DEFAULT_CALIBRATION, so Auto works out of the
// box. The walker and the unit still matter, so the app also learns a
// baseline per (speed bucket, grade) while the incline is set by hand, and
// the learned data outweighs the built-in reference as soon as it exists.
// Lookups pool nearby speed buckets, weighting closer and larger ones more,
// and charge extra uncertainty the further the pooled data sits from the
// current speed. In Auto mode the rolling window is classified against that
// pair of baselines, waiting longer for noisy or extrapolated data.
//
// Pure: no DOM, no storage. The app owns persistence and the UI.
// =============================================================================

import { INCLINE_GRADE } from './units.js';

/** Baselines are learned per speed bucket this wide (kph). */
export const SPEED_BUCKET_KPH = 0.5;
/** Minimum consecutive valid, at-target frames before checking load stability. */
export const SETTLE_FRAMES = 8;           // ~4 s at 2 Hz
/** Rolling window the decision is made over. The riser can only move while
 *  the belt is stopped, and a stop clears the window, so a long window costs
 *  nothing in responsiveness and lets noisy speeds accumulate evidence. */
export const WINDOW_FRAMES = 120;         // ~60 s at 2 Hz
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
/** Buckets further than this from the current speed (beyond the bucket's own
 *  half-width) don't contribute to a lookup. */
export const MAX_SPEED_DISTANCE_KPH = 1.5;
/** Gaussian width of the speed pooling: a bucket 1 kph away counts ~60%. */
export const SPEED_KERNEL_KPH = 1.0;
/** Extra midpoint uncertainty per kph of extrapolation (motor-current units).
 *  The measured levels moved < 1 unit over 1.5 kph, so this is conservative. */
export const EXTRAPOLATION_SD_PER_KPH = 1;
/** Built-in samples count at most this much per baseline, so a minute of the
 *  user's own walking already outweighs them. */
export const DEFAULT_WEIGHT = 120;

/**
 * Reference measured on one PitPat unit (firmware 37) with one walker: the
 * 3.5 bucket from a 3.7 kph raw capture, the 3.0 and 4.5 buckets from the
 * app's own learning at those speeds. Variance is per frame.
 */
export const DEFAULT_CALIBRATION = Object.freeze({
    version: 2,
    buckets: Object.freeze({
        '3.0': { '0': { mean: 40.0, n: 71,   variance: 152 }, '7': { mean: 26.4, n: 127, variance: 118 } },
        '3.5': { '0': { mean: 39.6, n: 825,  variance: 231 }, '7': { mean: 27.1, n: 450, variance: 170 } },
        '4.5': { '0': { mean: 39.7, n: 1041, variance: 334 }, '7': { mean: 27.5, n: 717, variance: 231 } },
    }),
});

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

/** Combine two baselines as if their samples had been pooled. */
function mergeBaselines(a, b) {
    if (!a) return b;
    if (!b) return a;
    const n = a.n + b.n;
    const mean = (a.mean * a.n + b.mean * b.n) / n;
    const spread = x => (x.variance ?? LEGACY_VARIANCE) + (x.mean - mean) ** 2;
    return { mean, n: Math.min(n, MAX_BASELINE_WEIGHT),
        variance: (spread(a) * a.n + spread(b) * b.n) / n };
}

/**
 * The calibration Auto actually classifies against: the built-in reference
 * (each baseline capped at DEFAULT_WEIGHT samples) with the user's learned
 * data pooled on top. Baselines that rest on the reference alone are marked
 * `builtIn` for the UI. Neither input is mutated; only `cal` is persisted.
 */
export function withDefaults(cal, defaults = DEFAULT_CALIBRATION) {
    const out = emptyCalibration();
    const keys = new Set([...Object.keys(defaults.buckets), ...Object.keys(cal.buckets)]);
    for (const key of keys) {
        const bucket = {};
        for (const g of ['0', String(INCLINE_GRADE)]) {
            const d = defaults.buckets[key]?.[g], l = cal.buckets[key]?.[g];
            if (!d && !l) continue;
            const capped = d && { ...d, n: Math.min(d.n, DEFAULT_WEIGHT) };
            bucket[g] = l ? mergeBaselines(capped, l) : { ...capped, builtIn: true };
        }
        if (Object.keys(bucket).length) out.buckets[key] = bucket;
    }
    return out;
}

/** How far `kph` sits outside a bucket (0 inside it). */
function bucketDistance(key, kph) {
    return Math.max(0, Math.abs(Number(key) - kph) - SPEED_BUCKET_KPH / 2);
}

/**
 * One grade's baseline at `kph`, pooled over nearby buckets. Larger and
 * closer buckets weigh more; disagreement between buckets widens the
 * variance; `distance` is the weighted extrapolation distance.
 */
function pooledBaseline(cal, kph, g) {
    const parts = [];
    let weight = 0;
    for (const [key, grades] of Object.entries(cal.buckets)) {
        const b = grades[g];
        if (!b) continue;
        const distance = bucketDistance(key, kph);
        if (distance > MAX_SPEED_DISTANCE_KPH) continue;
        const w = b.n * Math.exp(-0.5 * (distance / SPEED_KERNEL_KPH) ** 2);
        parts.push({ b, w, distance });
        weight += w;
    }
    if (weight <= 0) return null;
    const mean = parts.reduce((sum, p) => sum + p.w * p.b.mean, 0) / weight;
    const variance = parts.reduce((sum, p) =>
        sum + p.w * ((p.b.variance ?? LEGACY_VARIANCE) + (p.b.mean - mean) ** 2), 0) / weight;
    const distance = parts.reduce((sum, p) => sum + p.w * p.distance, 0) / weight;
    return { mean, variance, n: weight, distance };
}

/**
 * The pair of baselines to classify against at this speed, pooled from the
 * buckets within reach, or null when either grade lacks enough samples or
 * the pair doesn't separate. `local` is true when the exact bucket alone has
 * a usable pair; otherwise the pair is an estimate from nearby speeds and
 * `distance` (kph) says how far it was carried.
 *
 * @returns {{ bucket: string, flat: {mean:number,n:number,variance:number},
 *             grade: {mean:number,n:number,variance:number}, separation: number,
 *             distance: number, local: boolean } | null}
 */
export function baselinesFor(cal, kph) {
    const flat = pooledBaseline(cal, kph, '0');
    const grade = pooledBaseline(cal, kph, String(INCLINE_GRADE));
    if (!flat || !grade) return null;
    if (flat.n < MIN_BASELINE_SAMPLES || grade.n < MIN_BASELINE_SAMPLES) return null;
    const separation = flat.mean - grade.mean;
    // Uphill must read LOWER; anything else is noise or a mislabelled run.
    if (separation < MIN_SEPARATION) return null;
    const bucket = speedBucket(kph);
    const here = cal.buckets[bucket];
    const local = !!here?.['0'] && !!here?.[String(INCLINE_GRADE)]
        && here['0'].n >= MIN_BASELINE_SAMPLES && here[String(INCLINE_GRADE)].n >= MIN_BASELINE_SAMPLES
        && here['0'].mean - here[String(INCLINE_GRADE)].mean >= MIN_SEPARATION;
    return { bucket, flat, grade, separation, distance: Math.max(flat.distance, grade.distance), local };
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
 * Calibration uncertainty also counts, including for legacy saved baselines
 * and for baselines estimated from nearby speeds.
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
    // Midpoint uncertainty: sampling error of both baselines, plus how far
    // the pooled data had to be carried in speed to reach this lookup.
    const baselineError = ((baselines.flat.variance ?? LEGACY_VARIANCE) / baselines.flat.n
        + (baselines.grade.variance ?? LEGACY_VARIANCE) / baselines.grade.n) / 4
        + (EXTRAPOLATION_SD_PER_KPH * (baselines.distance ?? 0)) ** 2;
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
