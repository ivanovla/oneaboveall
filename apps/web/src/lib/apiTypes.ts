export interface ApiPerson {
  occupantId: string;
  priceCents: number;
  since: string;
}

export interface ApiRetinueMember {
  occupantId: string;
  priceCents: number;
  startedAt: string;
  endedAt: string;
}

export interface ApiSceneResponse {
  champion: ApiPerson | null;
  retinue: ApiRetinueMember[];
}

export interface ApiLeaderboardRow {
  occupantId: string;
  rounds: number;
  totalSpentCents: number;
  totalDurationMs: number;
}
