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
  // A link to any social network profile this occupant attached — never
  // restricted to one platform. Absent (older API deployments) or null (never
  // set) both mean "no link to show".
  socialUrl?: string | null;
  // Set by the operator for a creator whose seat was arranged/paid for —
  // rendered as a "Sponsored creator" tag. Absent on older API deployments,
  // which means "not sponsored".
  sponsored?: boolean;
}

export interface ApiRetinueMember {
  occupantId: string;
  occupantName?: string;
  priceCents: number;
  startedAt: string;
  endedAt: string;
  socialUrl?: string | null;
  sponsored?: boolean;
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
  sponsored?: boolean;
}

// The public, non-personalized GET /current-round payload — polled by the
// homepage chrome (AuctionFlow), BidFlow and the OBS overlay. `leader`,
// `champion` and `recentBids` only ever carry display names (never user ids
// or emails); all three are optional because an older API deployment
// doesn't send them.
export interface ApiPublicPerson {
  name: string;
  sponsored: boolean;
}

export interface ApiRecentBid {
  name: string;
  amountCents: number;
  placedAt: string;
}

export interface ApiCurrentRound {
  roundId: string;
  phase: "bidding" | "closed";
  currentLeaderCents: number;
  biddingClosesAt: string;
  leader?: ApiPublicPerson | null;
  champion?: ApiPublicPerson | null;
  recentBids?: ApiRecentBid[];
}
