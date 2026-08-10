// =============================================================================
// Units, conversions, and the physiology math.
//
// Everything here is pure: no DOM, no localStorage, no module-level mutable
// state. Functions that used to read the app's `unitMode` global now take the
// unit as a parameter, which is what makes them testable — a unit-conversion
// bug reached hardware once already (see KU_MIN/KU_MAX below).
// =============================================================================

export const KM_PER_MI = 1.609344;
export const LB_PER_KG = 2.20462;
export const CM_PER_IN = 2.54;
export const FT_PER_M  = 3.28084;

/** Walking stride ≈ 0.414 × height (unisex). */
export const STRIDE_FACTOR = 0.414;

/** The treadmill's manual incline switch, in percent. */
export const INCLINE_GRADE = 7;

/**
 * Fallback used ONLY when the user hasn't entered body metrics: firmware
 * doesn't fold the incline switch into its kcal count, so apply a flat ~1.8×
 * at 7% (ACSM walking eq, ~2.5–3 mph). Once a weight is set we integrate the
 * real ACSM equation instead (incline folded in) — see estimateKcalPerMin.
 */
export const INCLINE_KCAL_FACTOR = 1.80;

/** Speed slider ranges, expressed in the user's selected display unit. */
export const SPEED_RANGE = {
    kph: { min: 1.0, max: 6.0, label: 'kph' },
    mph: { min: 0.7, max: 3.8, label: 'mph' },
};

/**
 * The treadmill's speed command is ALWAYS kph × 1000 internally, no matter
 * which unit its screen shows — the unit bit in the command byte only changes
 * the on-screen label, not how the speed value is interpreted. So we keep the
 * target in those native units and convert to/from the user's unit purely for
 * the slider and the readout. (Sending "3.7" while meaning 3.7 mph made the
 * belt run at 3.7 kph ≈ 2.3 mph — the original calibration bug.)
 */
export const KU_MIN = 1000;   // 1.0 kph
export const KU_MAX = 6200;   // ~6.2 kph ≈ 3.85 mph — covers the Deerrun's 3.8 mph cap

export function unitOfDistance(unitMode) {
    return unitMode === 'mph' ? 'mi' : 'km';
}

export function convertDistance(value, from, to) {
    if (!value || from === to) return value;
    return from === 'km' ? value / KM_PER_MI : value * KM_PER_MI;
}

/** User-facing speed (in `unitMode`) → native treadmill units (kph×1000). */
export function userToKU(v, unitMode) {
    const ku = unitMode === 'mph'
        ? Math.round(v * KM_PER_MI * 1000)
        : Math.round(v * 1000);
    return Math.min(KU_MAX, Math.max(KU_MIN, ku));
}

/** Native treadmill units (kph×1000) → user-facing value in `unitMode`. */
export function kuToUser(ku, unitMode) {
    const kph = ku / 1000;
    return unitMode === 'mph' ? kph / KM_PER_MI : kph;
}

/** Stopwatch style: "0:00", "12:34", or "1:02:03" once it passes an hour. */
export function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${s}`
        : `${m}:${s}`;
}

/**
 * Firmware doesn't fold the manual incline switch into its calorie count.
 * Apply a flat correction when the user has selected the incline grade.
 */
export function adjustCalories(rawKcal, inclineMode) {
    const n = Number(rawKcal) || 0;
    return Math.round(inclineMode === INCLINE_GRADE ? n * INCLINE_KCAL_FACTOR : n);
}

/**
 * ACSM walking metabolic equation. The treadmill caps ~3.8 mph, so walking
 * (not running) applies throughout. Returns kcal per minute.
 *   S    = speed in m/min
 *   VO2  = 0.1·S + 1.8·S·grade + 3.5   (ml/kg/min)
 *   kcal/min = VO2 · weightKg · 5 / 1000   (≈5 kcal per L O2)
 * Incline is part of the formula, so no separate factor is needed here.
 */
export function estimateKcalPerMin(speedKph, gradeFrac, weightKg) {
    const S = speedKph * 1000 / 60;
    const vo2 = 0.1 * S + 1.8 * S * gradeFrac + 3.5;
    return vo2 * weightKg * 5 / 1000;
}

/** Walking stride length (m) from standing height (cm). */
export function strideMeters(heightCm) {
    return STRIDE_FACTOR * heightCm / 100;
}
