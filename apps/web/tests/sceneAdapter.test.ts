import { describe, it, expect } from "vitest";
import { adaptScene, adaptLeaderboardRow, formatDurationLabel } from "../src/lib/sceneAdapter";
import type { ApiSceneResponse, ApiLeaderboardRow } from "../src/lib/apiTypes";

describe("formatDurationLabel", () => {
  it("formats whole days, rounding down", () => {
    expect(formatDurationLabel(950_400_000)).toBe("11d"); // 11 days exactly
    expect(formatDurationLabel(100_800_000)).toBe("1d"); // 28h -> 1 full day
  });

  it("floors to 0d for anything under a day", () => {
    expect(formatDurationLabel(3_600_000)).toBe("0d");
  });
});

describe("adaptScene", () => {
  // occupantName is what real API responses carry (see the API's /scene
  // route, which joins users.name); a UUID occupantId must never reach the
  // rendered name.
  it("uses the API's resolved occupantName as the display name, not the raw UUID id", () => {
    const api: ApiSceneResponse = {
      champion: {
        occupantId: "3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77",
        occupantName: "Mark Vilensky",
        priceCents: 421_000,
        since: "2026-08-09T10:20:00.000Z",
      },
      retinue: [
        {
          occupantId: "6c21f7aa-0b4e-4f2c-9c1d-8a3e5d6b2f10",
          occupantName: "Daniel Crowe",
          priceCents: 398_000,
          startedAt: "2026-08-08T00:00:00.000Z",
          endedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    };

    const scene = adaptScene(api)!;

    expect(scene.champion.name).toBe("Mark Vilensky");
    expect(scene.champion.name).not.toMatch(/^[0-9a-f]{8}-/);
    expect(scene.retinue[0].name).toBe("Daniel Crowe");
    // The raw id is still carried through for keying/linking.
    expect(scene.champion.occupantId).toBe("3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77");
  });

  it("falls back to occupantId when the API omits or empties occupantName", () => {
    const api: ApiSceneResponse = {
      champion: { occupantId: "bootstrap-champ", priceCents: 421_000, since: "2026-08-09T10:20:00.000Z" },
      retinue: [
        { occupantId: "seeded-1", occupantName: "", priceCents: 398_000, startedAt: "2026-08-08T00:00:00.000Z", endedAt: "2026-08-09T00:00:00.000Z" },
      ],
    };

    const scene = adaptScene(api)!;

    expect(scene.champion.name).toBe("bootstrap-champ");
    expect(scene.retinue[0].name).toBe("seeded-1");
  });

  it("maps a populated scene, defaulting the display name to occupantId", () => {
    const api: ApiSceneResponse = {
      champion: { occupantId: "mark-vilensky", priceCents: 421_000, since: "2026-08-09T10:20:00.000Z" },
      retinue: [
        { occupantId: "daniel-crowe", priceCents: 398_000, startedAt: "2026-08-08T00:00:00.000Z", endedAt: "2026-08-09T00:00:00.000Z" },
      ],
    };

    const scene = adaptScene(api);

    expect(scene).not.toBeNull();
    expect(scene!.champion.occupantId).toBe("mark-vilensky");
    expect(scene!.champion.name).toBe("mark-vilensky");
    expect(scene!.champion.priceCents).toBe(421_000);
    expect(scene!.champion.since).toEqual(new Date("2026-08-09T10:20:00.000Z"));
    // Deliberately empty, and load-bearing: the champion's reign is still
    // running, so Scene.astro computes the held time live from `since` and
    // ignores this field for them. A non-empty value here would mean a stale
    // duration could be rendered instead.
    expect(scene!.champion.heldLabel).toBe("");
    expect(scene!.retinue).toHaveLength(1);
    expect(scene!.retinue[0].heldLabel).toBe("1d");
  });

  it("returns null when there is no champion", () => {
    expect(adaptScene({ champion: null, retinue: [] })).toBeNull();
  });
});

describe("adaptScene — malformed payloads", () => {
  // These all have to throw rather than return a partly-valid object. An
  // `Invalid Date` passed through would only fail later, inside Scene.astro's
  // Intl formatter, bypassing index.astro's malformed-body fallback (and its
  // REQUIRE_LIVE_DATA gate) and crashing the build from a file that has no
  // fallback of its own.
  it("throws on an unparseable champion `since`", () => {
    const api = {
      champion: { occupantId: "mark-vilensky", priceCents: 421_000, since: "not a date" },
      retinue: [],
    } as ApiSceneResponse;

    expect(() => adaptScene(api)).toThrow(/champion\.since is not a parseable date/);
  });

  it("throws on unparseable retinue timestamps, naming the offending index", () => {
    const base = {
      champion: { occupantId: "mark-vilensky", priceCents: 421_000, since: "2026-08-09T10:20:00.000Z" },
    };

    expect(() =>
      adaptScene({
        ...base,
        retinue: [
          { occupantId: "daniel-crowe", priceCents: 398_000, startedAt: "2026-08-08T00:00:00.000Z", endedAt: "2026-08-09T00:00:00.000Z" },
          { occupantId: "osei-adjei", priceCents: 364_000, startedAt: "???", endedAt: "2026-08-08T00:00:00.000Z" },
        ],
      }),
    ).toThrow(/retinue\[1\]\.startedAt is not a parseable date/);

    expect(() =>
      adaptScene({
        ...base,
        retinue: [
          { occupantId: "daniel-crowe", priceCents: 398_000, startedAt: "2026-08-08T00:00:00.000Z", endedAt: "" },
        ],
      }),
    ).toThrow(/retinue\[0\]\.endedAt is not a parseable date/);
  });

  it("throws when retinue is not an array", () => {
    const api = {
      champion: { occupantId: "mark-vilensky", priceCents: 421_000, since: "2026-08-09T10:20:00.000Z" },
      retinue: null,
    } as unknown as ApiSceneResponse;

    expect(() => adaptScene(api)).toThrow(/retinue is not an array/);
  });

  // The absent-champion contract survives all of the above: nobody in the
  // seat yet is a legitimate state, not a malformed body.
  it("still returns null for an absent champion, without validating the rest", () => {
    expect(adaptScene({ champion: null, retinue: null } as unknown as ApiSceneResponse)).toBeNull();
  });
});

describe("adaptLeaderboardRow", () => {
  it("maps an API row, formatting the duration and defaulting the name to occupantId", () => {
    const api: ApiLeaderboardRow = { occupantId: "alice", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: 950_400_000 };
    const row = adaptLeaderboardRow(api);

    expect(row.occupantId).toBe("alice");
    expect(row.name).toBe("alice");
    expect(row.rounds).toBe(6);
    expect(row.totalSpentCents).toBe(1_840_000);
    expect(row.totalDurationLabel).toBe("11d");
  });

  it("uses the API's resolved occupantName as the display name, not the raw UUID id", () => {
    const api: ApiLeaderboardRow = {
      occupantId: "3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77",
      occupantName: "Lena Ortiz",
      rounds: 6,
      totalSpentCents: 1_840_000,
      totalDurationMs: 950_400_000,
    };

    const row = adaptLeaderboardRow(api);

    expect(row.name).toBe("Lena Ortiz");
    expect(row.name).not.toMatch(/^[0-9a-f]{8}-/);
  });

  it("throws on a non-numeric duration instead of rendering \"NaNd\"", () => {
    const api = { occupantId: "alice", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: "a while" };

    expect(() => adaptLeaderboardRow(api as unknown as ApiLeaderboardRow)).toThrow(
      /totalDurationMs for "alice" is not a finite number/,
    );
  });
});
