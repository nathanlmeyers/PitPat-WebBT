// =============================================================================
// Date helpers — the small slice of date-fns this app actually used.
//
// Replaces the jsdelivr CDN dependency so the History tab keeps working with no
// network (and so the CSP needs no script-src exception). All arithmetic is in
// LOCAL time, matching both date-fns' default behaviour and how a workout log
// should read: a session at 11pm belongs to that day, not to UTC's.
// =============================================================================

/** Month/weekday names, built once from Intl so we don't hardcode strings.
 *  Locale is pinned to en-US to match the previous date-fns default output. */
const NAMES = (() => {
    const long  = new Intl.DateTimeFormat('en-US', { month: 'long',  timeZone: 'UTC' });
    const short = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
    const wday  = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
    // 2021-01-03 was a Sunday, so day-of-week and month indices line up with
    // getDay()/getMonth() when we walk forward from it.
    const monthLong  = [], monthShort = [], weekdayLong = [];
    for (let m = 0; m < 12; m++) {
        const d = new Date(Date.UTC(2021, m, 15));
        monthLong.push(long.format(d));
        monthShort.push(short.format(d));
    }
    for (let i = 0; i < 7; i++) {
        weekdayLong.push(wday.format(new Date(Date.UTC(2021, 0, 3 + i))));
    }
    return { monthLong, monthShort, weekdayLong };
})();

const TOKENS = {
    yyyy: d => String(d.getFullYear()),
    MMMM: d => NAMES.monthLong[d.getMonth()],
    MMM:  d => NAMES.monthShort[d.getMonth()],
    EEEE: d => NAMES.weekdayLong[d.getDay()],
    mm:   d => String(d.getMinutes()).padStart(2, '0'),
    d:    d => String(d.getDate()),
    h:    d => String(d.getHours() % 12 || 12),
    a:    d => (d.getHours() < 12 ? 'AM' : 'PM'),
};

// Longest-first alternation so `MMMM` wins over `MMM`, `EEEE` over nothing, etc.
const TOKEN_RE = /yyyy|MMMM|MMM|EEEE|mm|d|h|a/g;

/**
 * Mini date formatter supporting only the tokens this app uses:
 * `yyyy MMMM MMM EEEE d h mm a` — enough for 'MMMM yyyy', 'EEEE, MMM d',
 * and 'h:mm a'.
 *
 * NOTE: this is deliberately not a general date-fns `format`. There is no
 * escaping, so any literal text in the pattern must avoid those token letters
 * (e.g. "day" would expand the `d` and the `a`). Keep patterns punctuation-only
 * between tokens.
 */
export function format(date, pattern) {
    const d = date instanceof Date ? date : new Date(date);
    return pattern.replace(TOKEN_RE, t => TOKENS[t](d));
}

export function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Last day of the month, at 00:00 local (day 0 of the next month). */
export function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

/** Clamps the day like date-fns does: Jan 31 + 1 month → Feb 28/29, not Mar 3. */
export function addMonths(date, amount) {
    const day = date.getDate();
    const d = new Date(date.getFullYear(), date.getMonth(), 1,
                       date.getHours(), date.getMinutes(), date.getSeconds());
    d.setMonth(d.getMonth() + amount);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
    return d;
}

/** Inclusive list of local midnights from `start` through `end`. */
export function eachDayOfInterval({ start, end }) {
    const out = [];
    const cur  = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cur <= last) {
        out.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

/** Stable local-time day identifier, e.g. "2026-08-04". */
export function dayKey(d) {
    const date = d instanceof Date ? d : new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function startOfThisMonth() {
    return startOfMonth(new Date());
}
