#!/usr/bin/env node
// =============================================================================
// Analyze a raw-frame capture exported from the app's Data tab.
//
//   npm run analyze -- ~/Downloads/treadmill_capture_….json
//
// Answers, from data rather than guesswork:
//   1. What the stream looks like (rate, lengths, firmware, checksums, tail).
//   2. Which bytes ever move, and which move only when the incline label does.
//   3. Grade: for each field, how far apart 0% and 7% sit at the same speed.
//   4. Steps: between markers, how each step source compares with a hand count.
//
// Frames are re-decoded from their hex here, so this script and the app can
// never disagree about what a byte means.
// =============================================================================

import { readFileSync } from 'node:fs';
import { decodeNotification, decodeExtended, FRAME_FIELDS, STATE } from '../lib/protocol.js';
import { strideMeters } from '../lib/units.js';

const path = process.argv[2];
if (!path) {
    console.error('usage: npm run analyze -- <capture.json>');
    process.exit(2);
}
const cap = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(cap.frames)) {
    console.error('Not a capture file (no frames array).');
    process.exit(2);
}

// ---- helpers ---------------------------------------------------------------

const fromHex = hex => {
    const parts = hex.split(' ');
    const a = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i++) a[i] = parseInt(parts[i], 16);
    return { bytes: a, view: new DataView(a.buffer) };
};
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const std = xs => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const median = xs => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};
const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);
const h1 = t => console.log(`\n== ${t} ==`);

// ---- decode ------------------------------------------------------------------

const frames = cap.frames.map((f, i) => {
    const { bytes, view } = fromHex(f.hex);
    const raw = decodeNotification(view);
    return { i, t: f.t, bytes, raw, ext: raw ? decodeExtended(view) : null,
             inclineMode: f.inclineMode, unitMode: f.unitMode };
});
const decoded = frames.filter(f => f.raw);
const running = decoded.filter(f => f.raw.running_state === STATE.RUNNING);
const kph = f => f.raw.current_speed / 1000;

// ---- 1. stream facts -----------------------------------------------------------

h1('Stream');
const gaps = [];
for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
const lengths = new Map();
for (const f of frames) lengths.set(f.bytes.length, (lengths.get(f.bytes.length) || 0) + 1);
const tailKinds = new Map();
for (const f of decoded) {
    const k = f.ext ? f.ext.kind : 'none';
    tailKinds.set(k, (tailKinds.get(k) || 0) + 1);
}
console.log(`frames            ${frames.length} (${decoded.length} decodable, ${running.length} while running)`);
console.log(`markers           ${(cap.markers || []).length}`);
if (gaps.length) console.log(`median interval   ${median(gaps)} ms  (~${fmt(1000 / median(gaps), 1)} Hz)`);
console.log(`lengths seen      ${[...lengths].map(([l, n]) => `${l}×${n}`).join(', ')}`);
console.log(`firmware          ${[...new Set(decoded.map(f => f.raw.firmware))].join(', ') || '—'}`);
console.log(`device type       ${[...new Set(decoded.map(f => f.raw.device_type))].join(', ') || '—'}`);
console.log(`bad checksums     ${decoded.filter(f => !f.raw.checksum_ok).length}`);
console.log(`extended tail     ${[...tailKinds].map(([k, n]) => `${k}×${n}`).join(', ')}`);
const serial = decoded.map(f => f.ext).find(e => e && e.kind === 'identity')?.serial;
if (serial) console.log(`serial            ${serial}`);
console.log(`incline labels    ${[...new Set(frames.map(f => f.inclineMode))].join(', ')}`);
if (cap.profile) console.log(`profile           height ${cap.profile.heightCm ?? '—'} cm, weight ${cap.profile.weightKg ?? '—'} kg`);

// ---- 2. per-byte activity ------------------------------------------------------

h1('Per-byte activity (running frames)');
const fieldAt = off => FRAME_FIELDS.find(f => off >= f.offset && off < f.offset + f.length);
const maxLen = Math.max(0, ...frames.map(f => f.bytes.length));
const inclineLabels = [...new Set(running.map(f => f.inclineMode))];
console.log(pad('byte', 5) + pad('field', 24) + pad('distinct', 9) + 'per incline label (distinct values)');
const inclineOnly = [];
for (let off = 0; off < maxLen; off++) {
    const all = new Set();
    const perLabel = new Map();
    for (const f of running) {
        if (off >= f.bytes.length) continue;
        const v = f.bytes[off];
        all.add(v);
        if (!perLabel.has(f.inclineMode)) perLabel.set(f.inclineMode, new Set());
        perLabel.get(f.inclineMode).add(v);
    }
    if (all.size <= 1) continue;   // constant — boring
    const label = fieldAt(off)?.name ?? '';
    const detail = [...perLabel].map(([l, s]) => `${l}%:{${[...s].sort((a, b) => a - b).slice(0, 6).join(',')}${s.size > 6 ? ',…' : ''}}`).join('  ');
    console.log(pad(off, 5) + pad(label, 24) + pad(all.size, 9) + detail);
    // A byte that is constant within each label but differs between labels
    // is the cleanest possible grade signal.
    if (inclineLabels.length > 1 && [...perLabel.values()].every(s => s.size === 1)) {
        const vals = new Set([...perLabel.values()].map(s => [...s][0]));
        if (vals.size > 1) inclineOnly.push(off);
    }
}
if (inclineLabels.length > 1) {
    console.log(inclineOnly.length
        ? `\nBytes that change ONLY with the incline label: ${inclineOnly.join(', ')}  ← look here first`
        : '\nNo byte is constant within each incline label yet different between them.');
}

// ---- 3. grade test -------------------------------------------------------------

h1('Grade test: 0% vs 7% at matched speed');
const GRADE_FIELDS = [
    ['incline',               f => f.raw.incline],
    ['target_incline',        f => f.raw.target_incline],
    ['run_walk_state',        f => f.raw.run_walk_state],
    ['cycle_id',              f => f.raw.cycle_id],
    ['real_electricity',      f => f.ext?.real_electricity],
    ['real_rotate',           f => f.ext?.real_rotate],
    ['peak',                  f => f.ext?.peak],
    ['grain',                 f => f.ext?.grain],
    ['carrying_idler',        f => f.ext?.carrying_idler],
    ['sensor_status',         f => f.ext?.sensor_status],
    ['speed_err',             f => f.raw.current_speed - f.raw.target_speed],
];
/** Seconds per averaging block, for the "gap over a window" column. */
const BLOCK_S = 30;
const hz = gaps.length ? 1000 / median(gaps) : 1;
const blockMeans = xs => {
    const n = Math.max(1, Math.round(BLOCK_S * hz));
    const out = [];
    for (let i = 0; i + n <= xs.length; i += n) out.push(mean(xs.slice(i, i + n)));
    return out;
};
if (inclineLabels.length < 2) {
    console.log('Need running frames under both incline labels (toggle 0% / 7% in the app while recording).');
} else {
    const bucket = f => Math.round(kph(f) * 10) / 10;
    const buckets = [...new Set(running.map(bucket))].sort((a, b) => a - b);
    const [la, lb] = inclineLabels.slice(0, 2);
    for (const [name, get] of GRADE_FIELDS) {
        const rows = [];
        for (const b of buckets) {
            const A = running.filter(f => bucket(f) === b && f.inclineMode === la).map(get).filter(Number.isFinite);
            const B = running.filter(f => bucket(f) === b && f.inclineMode === lb).map(get).filter(Number.isFinite);
            if (A.length < 5 || B.length < 5) continue;
            const pooled = Math.sqrt((std(A) ** 2 + std(B) ** 2) / 2);
            const d = pooled > 0 ? (mean(B) - mean(A)) / pooled : (mean(B) !== mean(A) ? Infinity : 0);
            rows.push({ b, A, B, d });
        }
        if (!rows.length) continue;
        console.log(`\n${name}`);
        console.log(pad('  kph', 8) + rpad(`${la}% mean±sd (n)`, 24) + rpad(`${lb}% mean±sd (n)`, 24)
            + rpad('gap/frame', 11) + rpad(`gap/${BLOCK_S}s`, 10));
        for (const r of rows) {
            // A detector would average over a window, not judge single frames:
            // split each label into BLOCK_S-second blocks and compare block means.
            const blocksA = blockMeans(r.A), blocksB = blockMeans(r.B);
            let dBlock = NaN;
            if (blocksA.length >= 2 && blocksB.length >= 2) {
                const pooledB = Math.sqrt((std(blocksA) ** 2 + std(blocksB) ** 2) / 2);
                dBlock = pooledB > 0 ? (mean(blocksB) - mean(blocksA)) / pooledB : (mean(blocksB) !== mean(blocksA) ? Infinity : 0);
            }
            const sep = Math.abs(r.d) >= 2 ? '  ◀ separates per frame'
                      : Math.abs(dBlock) >= 2 ? `  ◀ separates over ${BLOCK_S}s` : '';
            console.log(pad(`  ${fmt(r.b, 1)}`, 8)
                + rpad(`${fmt(mean(r.A))}±${fmt(std(r.A))} (${r.A.length})`, 24)
                + rpad(`${fmt(mean(r.B))}±${fmt(std(r.B))} (${r.B.length})`, 24)
                + rpad(r.d === Infinity ? '∞' : fmt(r.d, 1), 11)
                + rpad(dBlock === Infinity ? '∞' : fmt(dBlock, 1), 10)
                + sep);
        }
    }
    console.log(`\nA gap of ≥2 sd per frame means the field tells the grade on its own; a gap of ≥2 sd over ${BLOCK_S}s means a rolling average can.`);
}

// ---- 4. step test ----------------------------------------------------------------

h1('Step test');
const markers = (cap.markers || []).slice().sort((a, b) => a.t - b.t);
const heightCm = cap.profile?.heightCm;
const stride = heightCm ? strideMeters(heightCm) : null;

// u16 counters wrap; count forward movement only.
const delta16 = (a, b) => ((b - a) + 65536) % 65536;

function segmentStats(from, to) {
    const seg = decoded.filter(f => f.t >= from && f.t <= to);
    if (seg.length < 2) return null;
    const first = seg[0], last = seg[seg.length - 1];
    let integrated = 0;       // metres, from speed × wall-clock
    for (let i = 1; i < seg.length; i++) {
        const dt = (seg[i].t - seg[i - 1].t) / 1000;
        integrated += kph(seg[i]) * 1000 * dt / 3600;
    }
    const ext = seg.map(f => f.ext).filter(e => e && e.kind === 'diagnostics');
    const out = {
        frames: seg.length,
        seconds: (last.t - first.t) / 1000,
        firmware_steps: last.raw.steps - first.raw.steps,
        distance_m: last.raw.distance - first.raw.distance,
        stride_from_distance: stride ? (last.raw.distance - first.raw.distance) / stride : null,
        stride_from_speed: stride ? integrated / stride : null,
    };
    if (ext.length >= 2) {
        const e0 = ext[0], e1 = ext[ext.length - 1];
        if (e0.sum_steps != null) out.sum_steps = delta16(e0.sum_steps, e1.sum_steps);
        if (e0.real_electricity_steps != null) out.real_electricity_steps = delta16(e0.real_electricity_steps, e1.real_electricity_steps);
    }
    return out;
}

function printSegment(title, s, truth) {
    console.log(`\n${title}  (${s.frames} frames, ${fmt(s.seconds, 0)} s, ${s.distance_m} m)`);
    const sources = ['firmware_steps', 'sum_steps', 'real_electricity_steps', 'stride_from_distance', 'stride_from_speed'];
    for (const k of sources) {
        if (s[k] == null) continue;
        let line = pad(`  ${k}`, 28) + rpad(fmt(s[k], 0), 8);
        if (truth) line += rpad(`${s[k] - truth >= 0 ? '+' : ''}${fmt(s[k] - truth, 0)} (${fmt(100 * (s[k] - truth) / truth, 1)}%)`, 20);
        console.log(line);
    }
}

if (markers.length >= 2) {
    for (let i = 1; i < markers.length; i++) {
        const a = markers[i - 1], b = markers[i];
        const s = segmentStats(a.t, b.t);
        if (!s) continue;
        // "counted 100 steps" → 100 is the hand count for the stretch ending here.
        const m = /(\d+)/.exec(b.text);
        const truth = m && /step|count/i.test(b.text) ? Number(m[1]) : null;
        printSegment(`"${a.text}" → "${b.text}"${truth ? `  hand count ${truth}` : ''}`, s, truth);
    }
} else {
    console.log('Fewer than two markers — showing the whole capture instead. Mark the start and end of a hand-counted stretch (e.g. "counted 100 steps") for a real comparison.');
    if (running.length >= 2) {
        const s = segmentStats(running[0].t, running[running.length - 1].t);
        if (s) printSegment('whole running stretch', s, null);
    }
}
if (!stride) console.log('\n(No height in profile → stride estimates skipped. Set it in Settings before exporting.)');
console.log('');
