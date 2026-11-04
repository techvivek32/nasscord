/**
 * US Eastern time helpers. E*TRADE ends every token at midnight Eastern, so the service needs
 * "the next 00:00 in America/New_York" as a UTC instant, correct across daylight-saving changes.
 */

const ZONE = "America/New_York";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * Wall-clock parts in New York for an instant.
 * @param {number} ms
 */
export function etParts(ms) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) {
    if (type !== "literal") p[type] = Number(value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Offset of New York from UTC at an instant, in ms (negative: -5 h or -4 h). @param {number} ms */
function offsetAt(ms) {
  const p = etParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant of a New York wall-clock time.
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @param {number} [hour] @param {number} [minute]
 */
export function etToUtc(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetAt(guess);
  // One more pass settles the answer when the guess straddled a DST change.
  t = guess - offsetAt(t);
  return t;
}

/**
 * The next midnight in New York strictly after `ms`.
 * @param {number} ms
 */
export function nextMidnightEt(ms) {
  const p = etParts(ms);
  // Date.UTC rolls day 32 over into the next month, which is what we want.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return etToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/** "2026-11-03" in New York. @param {number} ms */
export function etDateKey(ms) {
  const p = etParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** @param {number | null | undefined} ms */
export const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** @param {string | null | undefined} s @returns {number | null} */
export const parseTime = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
