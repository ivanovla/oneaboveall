import type { Scene, Person, LeaderboardRow } from "./types";
import type { ApiSceneResponse, ApiRetinueMember, ApiLeaderboardRow } from "./apiTypes";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatDurationLabel(ms: number): string {
  return `${Math.floor(ms / MS_PER_DAY)}d`;
}

function adaptRetinueMember(api: ApiRetinueMember): Person {
  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    priceCents: api.priceCents,
    since: new Date(api.startedAt),
    heldLabel: formatDurationLabel(new Date(api.endedAt).getTime() - new Date(api.startedAt).getTime()),
  };
}

export function adaptScene(api: ApiSceneResponse): Scene | null {
  if (!api.champion) return null;

  return {
    champion: {
      occupantId: api.champion.occupantId,
      name: api.champion.occupantId,
      priceCents: api.champion.priceCents,
      since: new Date(api.champion.since),
      heldLabel: "",
    },
    retinue: api.retinue.map(adaptRetinueMember),
  };
}

export function adaptLeaderboardRow(api: ApiLeaderboardRow): LeaderboardRow {
  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    rounds: api.rounds,
    totalSpentCents: api.totalSpentCents,
    totalDurationLabel: formatDurationLabel(api.totalDurationMs),
  };
}
