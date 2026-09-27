import { describe, it, expect } from "vitest";
import { nextDailyCloseAt, DAILY_CLOSE_HOUR_ET } from "../../src/domain/dailyClose";

describe("nextDailyCloseAt", () => {
  it("returns 4pm ET expressed as 21:00 UTC in winter (EST, UTC-5)", () => {
    const after = new Date("2026-01-15T12:00:00.000Z"); // 7am ET, well before close
    expect(nextDailyCloseAt(after)).toEqual(new Date("2026-01-15T21:00:00.000Z"));
  });

  it("returns 4pm ET expressed as 20:00 UTC in summer (EDT, UTC-4)", () => {
    const after = new Date("2026-07-15T12:00:00.000Z"); // 8am ET, well before close
    expect(nextDailyCloseAt(after)).toEqual(new Date("2026-07-15T20:00:00.000Z"));
  });

  it("rolls to the next day when `after` is exactly at today's close", () => {
    const todaysClose = new Date("2026-01-15T21:00:00.000Z");
    expect(nextDailyCloseAt(todaysClose)).toEqual(new Date("2026-01-16T21:00:00.000Z"));
  });

  it("rolls to the next day when `after` is just past today's close", () => {
    const justAfterClose = new Date("2026-01-15T21:00:01.000Z");
    expect(nextDailyCloseAt(justAfterClose)).toEqual(new Date("2026-01-16T21:00:00.000Z"));
  });

  it("stays on the EST offset the day before the US spring-forward transition", () => {
    // 2026-03-08 is when US clocks spring forward (2am ET) — the day
    // before is still EST (UTC-5) all the way through its own 4pm close.
    const after = new Date("2026-03-07T12:00:00.000Z");
    expect(nextDailyCloseAt(after)).toEqual(new Date("2026-03-07T21:00:00.000Z"));
  });

  it("switches to the EDT offset on the spring-forward transition day itself", () => {
    // The 2am transition has already happened by any time this function is
    // ever called with a same-day `after` (bidding closes at 4pm, never
    // earlier), so this date's close is already in EDT (UTC-4).
    const after = new Date("2026-03-08T12:00:00.000Z");
    expect(nextDailyCloseAt(after)).toEqual(new Date("2026-03-08T20:00:00.000Z"));
  });

  it("switches back to the EST offset on the fall-back transition day", () => {
    // 2026-11-01 is when US clocks fall back (2am ET) to EST.
    const after = new Date("2026-11-01T12:00:00.000Z");
    expect(nextDailyCloseAt(after)).toEqual(new Date("2026-11-01T21:00:00.000Z"));
  });

  it("never returns a close hour other than DAILY_CLOSE_HOUR_ET", () => {
    expect(DAILY_CLOSE_HOUR_ET).toBe(16);
  });
});
