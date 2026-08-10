import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    format, startOfMonth, endOfMonth, addMonths, eachDayOfInterval, dayKey,
} from '../lib/dates.js';

// All assertions use local-time Date constructors so they hold in any timezone.

test('format renders the patterns the app actually uses', () => {
    assert.equal(format(new Date(2026, 7, 4), 'MMMM yyyy'), 'August 2026');
    assert.equal(format(new Date(2026, 7, 4), 'EEEE, MMM d'), 'Tuesday, Aug 4');
    assert.equal(format(new Date(2026, 7, 4, 15, 5), 'h:mm a'), '3:05 PM');
});

test('format handles the 12-hour clock boundaries', () => {
    assert.equal(format(new Date(2026, 7, 4, 0, 5), 'h:mm a'), '12:05 AM');
    assert.equal(format(new Date(2026, 7, 4, 12, 5), 'h:mm a'), '12:05 PM');
    assert.equal(format(new Date(2026, 7, 4, 23, 59), 'h:mm a'), '11:59 PM');
});

test('format accepts a timestamp as well as a Date', () => {
    const d = new Date(2026, 0, 15, 8, 30);
    assert.equal(format(d.getTime(), 'MMMM yyyy'), 'January 2026');
});

test('startOfMonth and endOfMonth bracket the month in local time', () => {
    const mid = new Date(2026, 7, 15, 13, 45);
    assert.equal(startOfMonth(mid).getDate(), 1);
    assert.equal(startOfMonth(mid).getMonth(), 7);
    assert.equal(endOfMonth(mid).getDate(), 31);
    assert.equal(endOfMonth(new Date(2026, 1, 10)).getDate(), 28);   // Feb 2026
    assert.equal(endOfMonth(new Date(2024, 1, 10)).getDate(), 29);   // Feb 2024, leap
});

test('addMonths clamps rather than rolling into the next month', () => {
    const jan31 = new Date(2026, 0, 31);
    const feb = addMonths(jan31, 1);
    assert.equal(feb.getMonth(), 1);
    assert.equal(feb.getDate(), 28);
});

test('addMonths crosses year boundaries in both directions', () => {
    const dec = addMonths(new Date(2026, 0, 15), -1);
    assert.equal(dec.getFullYear(), 2025);
    assert.equal(dec.getMonth(), 11);

    const jan = addMonths(new Date(2026, 11, 15), 1);
    assert.equal(jan.getFullYear(), 2027);
    assert.equal(jan.getMonth(), 0);
});

test('eachDayOfInterval returns every day inclusive', () => {
    const days = eachDayOfInterval({
        start: startOfMonth(new Date(2026, 7, 10)),
        end:   endOfMonth(new Date(2026, 7, 10)),
    });
    assert.equal(days.length, 31);
    assert.equal(days[0].getDate(), 1);
    assert.equal(days[30].getDate(), 31);
    assert.ok(days.every(d => d.getMonth() === 7));
});

test('eachDayOfInterval handles a single-day range', () => {
    const d = new Date(2026, 7, 4);
    assert.equal(eachDayOfInterval({ start: d, end: d }).length, 1);
});

test('dayKey is zero-padded and stable for a whole local day', () => {
    assert.equal(dayKey(new Date(2026, 7, 4, 0, 0, 0)), '2026-08-04');
    assert.equal(dayKey(new Date(2026, 7, 4, 23, 59, 59)), '2026-08-04');
    assert.equal(dayKey(new Date(2026, 0, 1)), '2026-01-01');
    assert.equal(dayKey(new Date(2026, 7, 4, 6, 0).getTime()), '2026-08-04');
});
