// `occupantId` is a signed-in user's UUID primary key — never something a
// human should read. `occupantName` is the display name the API resolves for
// it (the user's `name`, or the raw id as a fallback when the occupant has no
// user row or an empty name). It's optional here only so an older API
// deployment that predates the join still adapts instead of throwing; the
// adapter falls back to `occupantId` in that case.
export interface ApiPerson {
  occupantId: string;
  occupantName?: string;
  priceCents: number;
  since: string;
}

export interface ApiRetinueMember {
  occupantId: string;
  occupantName?: string;
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
  occupantName?: string;
  rounds: number;
  totalSpentCents: number;
  totalDurationMs: number;
}
