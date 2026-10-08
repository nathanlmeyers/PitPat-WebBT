import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SETTLE_FRAMES, WINDOW_FRAMES, MIN_DECISION_FRAMES, MIN_BASELINE_SAMPLES,
    MAX_SPEED_DISTANCE_KPH, DEFAULT_WEIGHT, DEFAULT_CALIBRATION,
    speedBucket, emptyCalibration, cleanCalibration, learnSample, baselinesFor,
    withDefaults, classify, GradeDetector,
} from '../lib/incline.js';
import { INCLINE_GRADE } from '../lib/units.js';

/** Calibration shaped like the real measurement at 3.7 kph. */
function measuredCal() {
    const cal = emptyCalibration();
    for (let i = 0; i < 100; i++) {
        learnSample(cal, 3.7, 0, 39.6);
        learnSample(cal, 3.7, INCLINE_GRADE, 27.1);
    }
    return cal;
}

test('speedBucket rounds to half-kph string keys', () => {
    assert.equal(speedBucket(3.7), '3.5');
    assert.equal(speedBucket(3.76), '4.0');
    assert.equal(speedBucket(1.0), '1.0');
    assert.equal(speedBucket(0), '0.0');
});

test('learnSample keeps a capped running mean per bucket and grade', () => {
    const cal = emptyCalibration();
    learnSample(cal, 3.7, 0, 40);
    learnSample(cal, 3.7, 0, 20);
    assert.equal(cal.buckets['3.5']['0'].mean, 30);
    assert.equal(cal.buckets['3.5']['0'].n, 2);
    learnSample(cal, 3.6, INCLINE_GRADE, 10);   // same bucket, other grade
    assert.equal(cal.buckets['3.5']['7'].mean, 10);
    assert.equal(cal.buckets['3.5']['0'].mean, 30, 'grades are learned independently');
});

test('baselinesFor needs both grades, enough samples, and uphill reading lower', () => {
    const cal = emptyCalibration();
    assert.equal(baselinesFor(cal, 3.7), null);

    for (let i = 0; i < MIN_BASELINE_SAMPLES; i++) learnSample(cal, 3.7, 0, 40);
    assert.equal(baselinesFor(cal, 3.7), null, 'only one grade learned');

    for (let i = 0; i < MIN_BASELINE_SAMPLES - 1; i++) learnSample(cal, 3.7, INCLINE_GRADE, 27);
    assert.equal(baselinesFor(cal, 3.7), null, 'too few samples for the grade');

    learnSample(cal, 3.7, INCLINE_GRADE, 27);
    const b = baselinesFor(cal, 3.7);
    assert.ok(b);
    assert.equal(b.bucket, '3.5');
    assert.ok(Math.abs(b.separation - 13) < 1e-9);

    // Uphill reading HIGHER than flat is not a usable calibration.
    const bad = emptyCalibration();
    for (let i = 0; i < MIN_BASELINE_SAMPLES; i++) {
        learnSample(bad, 2.0, 0, 20);
        learnSample(bad, 2.0, INCLINE_GRADE, 35);
    }
    assert.equal(baselinesFor(bad, 2.0), null);
});

test('baselinesFor pools nearby buckets and reports when it had to reach', () => {
    const cal = measuredCal();           // learned at the 3.5 bucket only
    const here = baselinesFor(cal, 3.7);
    assert.equal(here.local, true);
    assert.equal(here.distance, 0, 'inside the bucket is not extrapolation');

    const near = baselinesFor(cal, 3.9);  // 4.0 bucket missing → pooled from 3.5
    assert.ok(near);
    assert.equal(near.bucket, '4.0');
    assert.equal(near.local, false);
    assert.ok(Math.abs(near.flat.mean - 39.6) < 1e-9 && Math.abs(near.grade.mean - 27.1) < 1e-9);
    assert.ok(near.distance > 0 && near.distance < 0.5);

    const far = baselinesFor(cal, 4.6);   // 0.85 kph outside the bucket: still an estimate
    assert.ok(far && !far.local && far.distance > 0.8);
    assert.equal(baselinesFor(cal, 3.75 + MAX_SPEED_DISTANCE_KPH + 0.01), null, 'out of reach');
    assert.equal(baselinesFor(cal, 3.25 - MAX_SPEED_DISTANCE_KPH - 0.01), null);
});

test('pooling weights bigger, closer buckets more and widens variance on disagreement', () => {
    const cal = emptyCalibration();
    for (let i = 0; i < 1000; i++) { learnSample(cal, 4.5, 0, 40); learnSample(cal, 4.5, INCLINE_GRADE, 28); }
    for (let i = 0; i < 50; i++)   { learnSample(cal, 3.5, 0, 44); learnSample(cal, 3.5, INCLINE_GRADE, 24); }
    const b = baselinesFor(cal, 4.0);     // equidistant: the 4.5 bucket dominates by count
    assert.ok(b.flat.mean > 40 && b.flat.mean < 40.5, `flat ${b.flat.mean}`);
    assert.ok(b.grade.mean > 27.5 && b.grade.mean < 28, `grade ${b.grade.mean}`);
    assert.ok(b.flat.variance > 0, 'constant samples, so all variance comes from the buckets disagreeing');
    assert.equal(b.local, false);
});

test('a small mislabelled bucket cannot flip a pooled estimate', () => {
    const cal = emptyCalibration();
    for (let i = 0; i < 35; i++) learnSample(cal, 2.5, INCLINE_GRADE, 40.8);  // flat walk labelled 7%
    const b = baselinesFor(withDefaults(cal), 2.5);
    assert.ok(b, 'still usable');
    assert.ok(b.grade.mean < 32, `uphill estimate ${b.grade.mean} still well below flat`);
    assert.ok(b.separation > 7);
});

test('withDefaults ships a usable pair across the walking range and yields to learned data', () => {
    const fresh = withDefaults(emptyCalibration());
    for (const kph of [2.0, 3.0, 3.7, 4.5, 5.5, 6.0]) {
        const b = baselinesFor(fresh, kph);
        assert.ok(b, `no built-in pair at ${kph} kph`);
        assert.ok(b.separation > 10, `separation ${b.separation} at ${kph} kph`);
        assert.ok(b.flat.n <= DEFAULT_WEIGHT * 3, 'built-in weight is capped');
    }
    assert.equal(baselinesFor(fresh, 3.7).local, true);
    assert.equal(baselinesFor(fresh, 2.0).local, false);
    assert.equal(fresh.buckets['4.5']['0'].builtIn, true);
    assert.equal(Object.keys(DEFAULT_CALIBRATION.buckets).length, 3);

    // A different unit/walker reads 10 units higher: their own minute of
    // walking must already outweigh the shipped reference.
    const cal = emptyCalibration();
    for (let i = 0; i < 150; i++) { learnSample(cal, 3.7, 0, 50); learnSample(cal, 3.7, INCLINE_GRADE, 37); }
    const mine = withDefaults(cal);
    assert.equal(mine.buckets['3.5']['0'].builtIn, undefined);
    assert.ok(mine.buckets['3.5']['0'].mean > 45, `learned data should dominate: ${mine.buckets['3.5']['0'].mean}`);
    assert.ok(mine.buckets['3.5']['0'].variance > 20, 'the disagreement is kept as uncertainty');
    assert.deepEqual(cal.buckets['3.5']['0'].n, 150, 'input is not mutated');
    assert.equal(DEFAULT_CALIBRATION.buckets['3.5']['0'].n, 825, 'defaults are not mutated');
});

test('classify uses the midpoint with a dead band', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    // midpoint 33.35, margin 1.25
    assert.equal(classify(b, 27), INCLINE_GRADE);
    assert.equal(classify(b, 40), 0);
    assert.equal(classify(b, 33.3), null);
    assert.equal(classify(null, 30), null);
    assert.equal(classify(b, NaN), null);
});

test('cleanCalibration drops junk and keeps good buckets', () => {
    const cal = cleanCalibration({
        buckets: {
            '3.5': { '0': { mean: 40, n: 50 }, '7': { mean: 'x', n: 50 }, '9': { mean: 1, n: 1 } },
            'bad': { '0': { mean: 1, n: 1 } },
            '2.0': { '0': { mean: 30, n: 1e9 } },
        },
    });
    assert.deepEqual(Object.keys(cal.buckets).sort(), ['2.0', '3.5']);
    assert.deepEqual(Object.keys(cal.buckets['3.5']), ['0']);
    assert.ok(cal.buckets['2.0']['0'].n < 1e9, 'weight is capped');
    assert.deepEqual(cleanCalibration(null), emptyCalibration());
    assert.deepEqual(cleanCalibration('nope'), emptyCalibration());
});

function feed(det, n, frame) {
    let used = 0;
    for (let i = 0; i < n; i++) if (det.push(frame)) used++;
    return used;
}

test('GradeDetector ignores the settle period and unsettled speed', () => {
    const det = new GradeDetector();
    const used = feed(det, SETTLE_FRAMES + 5, { running: true, speed: 3700, target: 3700, current: 30 });
    assert.equal(used, 5);
    assert.equal(feed(det, 3, { running: true, speed: 3500, target: 3700, current: 30 }), 0,
        'belt not yet at the commanded speed');
});

test('GradeDetector decides only once the window is full enough, then holds through the dead band', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    const det = new GradeDetector();
    feed(det, SETTLE_FRAMES + MIN_DECISION_FRAMES - 1, { running: true, speed: 3700, target: 3700, current: 27 });
    assert.equal(det.evaluate(b), null, 'one frame short');
    feed(det, 1, { running: true, speed: 3700, target: 3700, current: 27 });
    assert.equal(det.evaluate(b), INCLINE_GRADE);

    // Drift into the dead band: decision is kept.
    feed(det, WINDOW_FRAMES, { running: true, speed: 3700, target: 3700, current: 33.3 });
    assert.equal(det.evaluate(b), INCLINE_GRADE);

    // Clearly flat: flips.
    feed(det, WINDOW_FRAMES, { running: true, speed: 3700, target: 3700, current: 40 });
    assert.equal(det.evaluate(b), 0);
});

test('GradeDetector rebuilds the window on a speed change but keeps the decision', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    const det = new GradeDetector();
    feed(det, SETTLE_FRAMES + MIN_DECISION_FRAMES, { running: true, speed: 3700, target: 3700, current: 27 });
    assert.equal(det.evaluate(b), INCLINE_GRADE);
    det.push({ running: true, speed: 3700, target: 4000, current: 27 });
    assert.equal(det.count, 0);
    assert.equal(det.evaluate(b), INCLINE_GRADE, 'remembered across the rebuild');
});

test('GradeDetector clears the window on stop (the deck moves while stopped)', () => {
    const det = new GradeDetector();
    feed(det, SETTLE_FRAMES + 10, { running: true, speed: 3700, target: 3700, current: 27 });
    assert.equal(det.count, 10);
    det.push({ running: false, speed: 0, target: 3700, current: 0 });
    assert.equal(det.count, 0);
    // Restart has to settle again.
    assert.equal(feed(det, SETTLE_FRAMES, { running: true, speed: 3700, target: 3700, current: 27 }), 0);
});

const walking = { running: true, speed: 3700, target: 3700, current: 27 };

function feedValues(det, b, values) {
    for (const current of values) {
        det.push({ ...walking, current });
        det.evaluate(b);
    }
}

test('clear readings confirm either grade after 12 seconds at 2 Hz', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    for (const [grade, mean] of [[0, 39.6], [INCLINE_GRADE, 27.1]]) {
        const det = new GradeDetector();
        feedValues(det, b, Array.from({ length: 23 }, (_, i) => mean + (i % 2 ? 2 : -2)));
        assert.equal(det.decision, null);
        feedValues(det, b, [mean + 2]);
        assert.equal(det.decision, grade);
        assert.equal(det.confirmed, true);
    }
});

test('estimates carried from another speed need clearer readings than local ones', () => {
    const cal = measuredCal();
    const local = baselinesFor(cal, 3.7), carried = baselinesFor(cal, 4.9);
    assert.ok(carried && carried.distance > 1);
    const run = (b, mean) => {
        const det = new GradeDetector();
        feedValues(det, b, Array.from({ length: 60 }, (_, i) => mean + (i % 2 ? 2 : -2)));
        return det.decision;
    };
    // Mildly uphill readings: good enough at the calibrated speed, not when
    // the baselines were carried over a kilometre per hour.
    assert.equal(run(local, 30), INCLINE_GRADE);
    assert.equal(run(carried, 30), null);
    // Clearly uphill readings still confirm with the carried pair.
    assert.equal(run(carried, 27.1), INCLINE_GRADE);
    assert.equal(run(carried, 39.6), 0);
});

test('startup load trend extends settling even after actual speed reaches target', () => {
    const det = new GradeDetector();
    feedValues(det, null, Array.from({ length: 24 }, (_, i) => 100 - 2 * i));
    assert.equal(det.count, 0, 'a ramp must not become training or decision data');
    feedValues(det, null, Array(16).fill(27));
    assert.ok(det.count > 0, 'stable load eventually finishes settling');
});

test('acceleration does not count toward settling', () => {
    const det = new GradeDetector();
    feed(det, 30, { ...walking, speed: 3000 });
    assert.equal(feed(det, SETTLE_FRAMES, walking), 0);
    assert.equal(det.count, 0);
    assert.equal(feed(det, 1, walking), 1);
});

test('noisy readings wait longer than clear ones, then resolve', () => {
    const cal = emptyCalibration();
    for (let i = 0; i < 400; i++) {
        learnSample(cal, 3.7, 0, 39.6 + (i % 2 ? 15 : -15));
        learnSample(cal, 3.7, INCLINE_GRADE, 27.1 + (i % 2 ? 13 : -13));
    }
    const b = baselinesFor(cal, 3.7);
    for (const [grade, mean, noise] of [[0, 39.6, 15], [INCLINE_GRADE, 27.1, 13]]) {
        const det = new GradeDetector();
        const values = n => Array.from({ length: n }, (_, i) => mean + (i % 2 ? noise : -noise));
        feedValues(det, b, values(24));
        assert.equal(det.decision, null, 'not enough evidence for early detection');
        let firstDecisionFrame = null;
        for (let i = 0; i < 44; i++) {
            feedValues(det, b, [mean + (i % 2 ? noise : -noise)]);
            if (det.decision !== null && firstDecisionFrame === null) firstDecisionFrame = 25 + i;
        }
        assert.ok(firstDecisionFrame !== null && firstDecisionFrame < 60,
            'these noisy fixtures resolve before the old 30-second minimum');
        assert.equal(det.decision, grade, 'additional samples resolve the noise');
        assert.equal(det.confirmed, true);
    }
});

test('correlated blocks do not get treated as independent low-noise readings', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    const det = new GradeDetector();
    feed(det, SETTLE_FRAMES, { ...walking, current: 39.6 });
    // Mean is above the flat threshold, and all readings are on its flat side.
    // Per-frame error alone would confirm; block variability must prevent it.
    feedValues(det, b, [35, 47, 35, 47].flatMap(v => Array(4).fill(v)));
    assert.equal(classify(b, det.windowMean), 0);
    assert.equal(det.decision, null);
    assert.equal(det.confirmed, false);
});

test('ambiguous readings and an isolated spike never confirm a grade', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    const det = new GradeDetector();
    feedValues(det, b, Array(100).fill(33.35));
    assert.equal(det.decision, null);
    feedValues(det, b, [255]);
    assert.equal(classify(b, det.windowMean), 0, 'spike moves the simple mean beyond the dead band');
    assert.equal(det.decision, null, 'the uncertainty gate rejects that guess');
    assert.equal(det.confirmed, false);
});

test('previous grade is unconfirmed after stop, speed change, invalid data or missing calibration', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    for (const interruption of [
        { ...walking, running: false },
        { ...walking, speed: 4000, target: 4000 },
        { ...walking, speed: 3600 },
        { ...walking, current: NaN },
        { ...walking, speed: NaN },
        { ...walking, target: NaN },
    ]) {
        const det = new GradeDetector();
        feedValues(det, b, Array(24).fill(27));
        assert.equal(det.confirmed, true);
        det.push(interruption);
        assert.equal(det.evaluate(b), INCLINE_GRADE);
        assert.equal(det.confirmed, false);
        assert.equal(det.count, 0);
    }
    const det = new GradeDetector();
    feedValues(det, b, Array(24).fill(27));
    assert.equal(det.evaluate(null), INCLINE_GRADE);
    assert.equal(det.confirmed, false);
    det.reset();
    assert.equal(det.decision, null, 'manual override clears the remembered auto decision');
});

test('a restart can detect the opposite grade without using the old window', () => {
    const b = baselinesFor(measuredCal(), 3.7);
    const det = new GradeDetector();
    feedValues(det, b, Array(24).fill(27));
    det.push({ ...walking, running: false });
    feedValues(det, b, Array(23).fill(40));
    assert.equal(det.decision, INCLINE_GRADE);
    assert.equal(det.confirmed, false);
    feedValues(det, b, [40]);
    assert.equal(det.decision, 0);
    assert.equal(det.confirmed, true);
});

test('learned variance survives storage and continues adapting at the weight cap', () => {
    const cal = emptyCalibration();
    for (const value of [20, 40, 20, 40]) learnSample(cal, 3.7, 0, value);
    const flat = cal.buckets['3.5']['0'];
    assert.equal(flat.mean, 30);
    assert.ok(Math.abs(flat.variance - 100) < 1e-9);
    assert.deepEqual(cleanCalibration(JSON.parse(JSON.stringify(cal))), cal);
    for (let i = 0; i < 2500; i++) learnSample(cal, 3.7, 0, 30);
    const before = flat.variance;
    learnSample(cal, 3.7, 0, 60);
    assert.ok(flat.variance > before);
    assert.ok(Number.isFinite(flat.variance));
});

test('legacy or malformed variance gets a conservative default without losing calibration', () => {
    for (const variance of [undefined, null, -1, Infinity, '0']) {
        const cal = cleanCalibration({ version: 1, buckets: {
            '3.5': { '0': { mean: 40, n: 100, variance }, '7': { mean: 27, n: 100, variance } },
        } });
        assert.equal(cal.version, 2);
        assert.equal(cal.buckets['3.5']['0'].mean, 40);
        assert.equal(cal.buckets['3.5']['0'].n, 100);
        assert.ok(cal.buckets['3.5']['0'].variance > 0);
        const det = new GradeDetector();
        feedValues(det, baselinesFor(cal, 3.7), Array(24).fill(27));
        assert.equal(det.decision, INCLINE_GRADE);
    }
});

test('uncertain calibration can prevent a premature decision even with steady readings', () => {
    const cal = cleanCalibration({ buckets: {
        '3.5': { '0': { mean: 36, n: 40 }, '7': { mean: 31, n: 40 } },
    } });
    const det = new GradeDetector();
    feedValues(det, baselinesFor(cal, 3.7), Array(100).fill(31));
    assert.equal(det.decision, null, 'weak baselines need more manual calibration');
});
