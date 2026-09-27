import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../src/server";
import { __resetCacheForTests } from "../src/routes/pageViews";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/db/repository", () => ({
  incrementPageViews: vi.fn(async (by: number = 1) => by),
}));

beforeEach(() => {
  __resetCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /page-views", () => {
  it("flushes immediately on the very first call, returning a real count", async () => {
    const { incrementPageViews } = await import("engine/db/repository");
    vi.mocked(incrementPageViews).mockResolvedValueOnce(1);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/page-views" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 1 });
    expect(incrementPageViews).toHaveBeenCalledWith(1);
  });

  it("batches rapid calls — no further DB write until the interval is due", async () => {
    const { incrementPageViews } = await import("engine/db/repository");
    vi.mocked(incrementPageViews).mockResolvedValueOnce(1);

    const app = buildServer();
    await app.inject({ method: "POST", url: "/page-views" }); // cold-start flush: total becomes 1
    vi.mocked(incrementPageViews).mockClear();

    const second = await app.inject({ method: "POST", url: "/page-views" });
    const third = await app.inject({ method: "POST", url: "/page-views" });

    // Neither call is due for another flush yet (same instant, per Date.now
    // — see the next test for the interval actually elapsing), so the count
    // is served entirely from the in-memory estimate — no further DB write.
    expect(incrementPageViews).not.toHaveBeenCalled();
    expect(second.json()).toEqual({ count: 2 });
    expect(third.json()).toEqual({ count: 3 });
  });

  it("flushes the accumulated batch once the interval has elapsed, without blocking the response on it", async () => {
    const { incrementPageViews } = await import("engine/db/repository");
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    vi.mocked(incrementPageViews).mockResolvedValueOnce(1);

    const app = buildServer();
    await app.inject({ method: "POST", url: "/page-views" }); // cold-start flush, total = 1
    await app.inject({ method: "POST", url: "/page-views" }); // pending = 1, not due yet
    vi.mocked(incrementPageViews).mockClear();
    vi.mocked(incrementPageViews).mockResolvedValueOnce(3); // total(1) + this flush's batch of 2

    // 5+ seconds later — past FLUSH_INTERVAL_MS.
    nowSpy.mockReturnValue(1_005_001);
    const response = await app.inject({ method: "POST", url: "/page-views" });

    // The response never waited on the DB write — `pending` still carries
    // this call's view, so the count it answers with is already correct
    // (total(1) + pending(2): the earlier unflushed view plus this one).
    expect(response.json()).toEqual({ count: 3 });
    expect(incrementPageViews).toHaveBeenCalledWith(2);

    // Give the fire-and-forget flush's already-resolved mock promise a turn
    // to settle (a macrotask runs after the microtask queue drains), then
    // confirm it landed: `total` caught up and `pending` drained to 0.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settled = await app.inject({ method: "POST", url: "/page-views" });
    expect(settled.json()).toEqual({ count: 4 }); // total(3) + this new call's pending(1)
  });

  it("keeps retrying a failed flush instead of losing those views", async () => {
    const { incrementPageViews } = await import("engine/db/repository");
    vi.mocked(incrementPageViews).mockRejectedValueOnce(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/page-views" });

    // The cold-start flush failed, so there is no confirmed total yet — the
    // response still answers from the pending count rather than erroring.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 1 });

    vi.mocked(incrementPageViews).mockResolvedValueOnce(2);
    const retry = await app.inject({ method: "POST", url: "/page-views" });

    // Neither the failed view nor this new one was lost — the retry flushes
    // both together.
    expect(incrementPageViews).toHaveBeenLastCalledWith(2);
    expect(retry.json()).toEqual({ count: 2 });
  });
});
