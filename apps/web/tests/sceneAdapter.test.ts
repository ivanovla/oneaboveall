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
  it("maps a populated scene, using occupantId as the display name", () => {
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
    expect(scene!.retinue).toHaveLength(1);
    expect(scene!.retinue[0].heldLabel).toBe("1d");
  });

  it("returns null when there is no champion", () => {
    expect(adaptScene({ champion: null, retinue: [] })).toBeNull();
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
});
