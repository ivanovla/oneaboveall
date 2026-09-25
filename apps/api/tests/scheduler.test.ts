import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("engine/engine/scheduler", () => ({
  tick: vi.fn(),
}));

import { tick } from "engine/engine/scheduler";
import { startScheduler } from "../src/scheduler";

describe("startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(tick).mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.WEB_REBUILD_URL;
  });

  // startScheduler() reads SCHEDULER_INTERVAL_MS once, at module import time
  // (like stripeClient.ts reads its own env vars) — so tests can't override
  // it per-case and instead advance fake timers by this same default the
  // module already picked up.
  const DEFAULT_INTERVAL_MS = 3000;

  it("calls tick() on every interval, using the current time", async () => {
    vi.mocked(tick).mockResolvedValue(undefined);

    startScheduler();
    expect(tick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 2);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("posts to WEB_REBUILD_URL when tick() reports a newly installed champion", async () => {
    process.env.WEB_REBUILD_URL = "http://web-rebuilder.internal/rebuild";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(tick).mockImplementation(async (_now, onInstalled) => {
      onInstalled?.("bidder-1");
    });

    startScheduler();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith("http://web-rebuilder.internal/rebuild", { method: "POST" });
  });

  it("never calls fetch when WEB_REBUILD_URL is unset", async () => {
    const fetchMock = vi.mocked(fetch);
    vi.mocked(tick).mockImplementation(async (_now, onInstalled) => {
      onInstalled?.("bidder-1");
    });

    startScheduler();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs and keeps rescheduling when tick() itself rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(tick).mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(undefined);

    startScheduler();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("logs but does not throw when the rebuild trigger fetch fails", async () => {
    process.env.WEB_REBUILD_URL = "http://web-rebuilder.internal/rebuild";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error("connection refused"));
    vi.mocked(tick).mockImplementation(async (_now, onInstalled) => {
      onInstalled?.("bidder-1");
    });

    startScheduler();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

    errorSpy.mockRestore();
  });
});
