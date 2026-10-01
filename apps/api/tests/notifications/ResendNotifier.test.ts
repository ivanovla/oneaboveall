import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "engine/db/client";
import { users } from "engine/db/schema";
import { ResendNotifier } from "../../src/notifications/ResendNotifier";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

const user = (overrides: Partial<{ email: string; photoPath: string | null }> = {}) =>
  vi.fn(async () => ({ email: "bidder@example.com", photoPath: null, ...overrides }));

function sentEmail(): { url: string; init: RequestInit; body: any } {
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe("ResendNotifier", () => {
  it("sends an outbid email through the Resend API with a link back to the site", async () => {
    const notifier = new ResendNotifier({ apiKey: "re_test", appUrl: "https://oneaboveall.org", lookupUser: user() });

    await notifier.outbid({ bidderId: "u1", amountCents: 12_345 });

    const { url, init, body } = sentEmail();
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(body.to).toEqual(["bidder@example.com"]);
    expect(body.from).toBe("oneaboveall <noreply@oneaboveall.org>");
    expect(body.subject).toBe("You've been outbid on oneaboveall.org");
    expect(body.text).toContain("$123.45");
    expect(body.text).toContain("https://oneaboveall.org");
  });

  it("uses EMAIL_FROM when configured", async () => {
    const notifier = new ResendNotifier({ apiKey: "re_test", from: "Seat <seat@example.org>", lookupUser: user() });
    await notifier.outbid({ bidderId: "u1", amountCents: 100 });
    expect(sentEmail().body.from).toBe("Seat <seat@example.org>");
  });

  it("asks a winner without a photo to upload one", async () => {
    const notifier = new ResendNotifier({ apiKey: "re_test", appUrl: "https://oneaboveall.org", lookupUser: user({ photoPath: null }) });

    await notifier.won({ bidderId: "u1", amountCents: 50_000 });

    const { body } = sentEmail();
    expect(body.subject).toBe("You won the seat");
    expect(body.text).toContain("$500.00");
    expect(body.text).toMatch(/upload/i);
    expect(body.text).toContain("7 PM ET");
    expect(body.text).toContain("https://oneaboveall.org");
  });

  it("does not ask a winner who already uploaded a photo to upload one", async () => {
    const notifier = new ResendNotifier({ apiKey: "re_test", lookupUser: user({ photoPath: "abc.jpg" }) });
    await notifier.won({ bidderId: "u1", amountCents: 50_000 });
    expect(sentEmail().body.text).not.toMatch(/upload/i);
  });

  it("skips sending, warning only once, when no API key is configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookupUser = user();
    const notifier = new ResendNotifier({ apiKey: undefined, lookupUser });

    await notifier.outbid({ bidderId: "u1", amountCents: 100 });
    await notifier.won({ bidderId: "u1", amountCents: 100 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupUser).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs and resolves when Resend answers with an error status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => "invalid from" });
    const notifier = new ResendNotifier({ apiKey: "re_test", lookupUser: user() });

    await expect(notifier.outbid({ bidderId: "u1", amountCents: 100 })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs and resolves when the request itself fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const notifier = new ResendNotifier({ apiKey: "re_test", lookupUser: user() });

    await expect(notifier.won({ bidderId: "u1", amountCents: 100 })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs and resolves, sending nothing, when the user can't be found or looked up", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = new ResendNotifier({ apiKey: "re_test", lookupUser: vi.fn(async () => null) });
    const broken = new ResendNotifier({
      apiKey: "re_test",
      lookupUser: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    await expect(missing.outbid({ bidderId: "u1", amountCents: 100 })).resolves.toBeUndefined();
    await expect(broken.outbid({ bidderId: "u1", amountCents: 100 })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("looks the bidder's email up in the users table by default", async () => {
    const [row] = await db
      .insert(users)
      .values({ provider: "google", providerId: `resend-test-${Date.now()}`, email: "dbuser@example.com", name: "DB User" })
      .returning();
    try {
      const notifier = new ResendNotifier({ apiKey: "re_test" });
      await notifier.won({ bidderId: row.id, amountCents: 100 });
      expect(sentEmail().body.to).toEqual(["dbuser@example.com"]);
      expect(sentEmail().body.text).toMatch(/upload/i);
    } finally {
      await db.delete(users).where(eq(users.id, row.id));
    }
  });
});
