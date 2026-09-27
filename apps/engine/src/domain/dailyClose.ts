// Bidding always closes at a fixed wall-clock hour in the US Eastern time
// zone, not a fixed duration after the round started — so a round's actual
// length varies (a round that starts right after the champion-processing
// gap ends up close to 21h; one started mid-afternoon by a fresh bootstrap
// could be much shorter), but the close time itself is predictable for
// visitors: always DAILY_CLOSE_HOUR_ET, every day.
//
// "America/New_York" (not a fixed UTC offset) is deliberate: it tracks the
// EST/EDT transition automatically via the JS engine's own IANA time zone
// database, so 16:00 ET stays 16:00 ET across the March/November clock
// changes instead of silently drifting to 15:00 or 17:00 local time.
const TIME_ZONE = "America/New_York";
export const DAILY_CLOSE_HOUR_ET = 16; // 4pm ET

const DAY_MS = 24 * 60 * 60 * 1000;

// The UTC instant, as milliseconds, that `date` reads as when its wall-clock
// components (in `timeZone`) are reinterpreted as if they were already UTC.
// Comparing this against `date`'s own UTC milliseconds is what lets
// `zonedTimeToUtc` below recover `timeZone`'s current offset without
// parsing a "GMT-4"-style string.
function wallClockInZoneAsUtcMillis(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  // Some engines report midnight as hour "24" with hour12: false.
  const hour = get("hour") % 24;
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
}

function getZonedYMD(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// The UTC instant corresponding to `hour`:00:00 wall-clock time on the given
// Y/M/D in `timeZone`. Two correction passes (rather than one) handle the
// rare case where the first guess's offset differs from the target
// instant's actual offset — i.e. the target date sits right at a DST
// transition.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const zonedAsUtc = wallClockInZoneAsUtcMillis(new Date(guess), timeZone);
    guess += target - zonedAsUtc;
  }
  return new Date(guess);
}

// The next instant, strictly after `after`, at which it is
// DAILY_CLOSE_HOUR_ET in America/New_York. If `after` itself is already
// exactly at that instant, "next" still means the following day's — a
// round's bidding is never open for zero duration.
export function nextDailyCloseAt(after: Date): Date {
  const { year, month, day } = getZonedYMD(after, TIME_ZONE);
  const todaysClose = zonedTimeToUtc(year, month, day, DAILY_CLOSE_HOUR_ET, TIME_ZONE);
  if (todaysClose.getTime() > after.getTime()) return todaysClose;

  // Today's close has already passed (or is this exact instant) — probe a
  // day ahead and re-derive the Y/M/D from `timeZone`'s own calendar, not
  // UTC's, so this can't skip or repeat a day across a UTC-day boundary.
  const probe = getZonedYMD(new Date(todaysClose.getTime() + DAY_MS), TIME_ZONE);
  return zonedTimeToUtc(probe.year, probe.month, probe.day, DAILY_CLOSE_HOUR_ET, TIME_ZONE);
}
