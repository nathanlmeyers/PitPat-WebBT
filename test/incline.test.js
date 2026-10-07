import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SETTLE_FRAMES, WINDOW_FRAMES, MIN_DECISION_FRAMES, MIN_BASELINE_SAMPLES,
    speedBucket, emptyCalibration, cleanCalibration, learnSample, baselinesFor,
    classify, GradeDetector,
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

test('baselinesFor falls back to a neighbouring bucket', () => {
    const cal = measuredCal();           // learned at 3.5 bucket
    assert.equal(baselinesFor(cal, 3.9).bucket, '3.5');   // 4.0 missing → 3.5
    assert.equal(baselinesFor(cal, 4.6), null);           // 4.5 and both neighbours missing
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
