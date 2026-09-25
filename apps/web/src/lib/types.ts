export interface Person {
  occupantId: string;
  name: string;
  priceCents: number;
  // Reign start. For the champion, "time held so far" is computed client-side
  // as `now - since` (it keeps ticking up) — never baked in as a static string.
  // For a retinue member, since is still stored for the "since"/period line,
  // but their held-duration is over and reported via heldLabel instead.
  since: Date;
  // Fixed "1d 4h"-style duration string for a retinue member, whose reign has
  // already ended — never recomputed. Unused for the champion.
  heldLabel: string;
  // A link to any social network profile (Instagram, X, TikTok, a personal
  // site, …) — never restricted to one platform.
  socialUrl?: string;
}

export interface Scene {
  champion: Person;
  retinue: Person[];
}

export interface LeaderboardRow {
  occupantId: string;
  name: string;
  rounds: number;
  totalSpentCents: number;
  totalDurationLabel: string;
}
