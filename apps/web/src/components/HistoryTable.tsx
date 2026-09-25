import { formatMoney } from "../lib/format";

export type BidStatus = "active" | "won" | "refunded";

export type HistoryBid = { amountCents: number; placedAt: string; status: BidStatus };

export type HistoryEntry = {
  roundId: string;
  bids: HistoryBid[];
};

export type HistoryStatus = "loading" | "error" | { entries: HistoryEntry[] };

const STATUS_LABEL: Record<BidStatus, string> = {
  active: "Leading",
  won: "Won",
  refunded: "Outbid — refunded",
};

const STATUS_COLOR: Record<BidStatus, string> = {
  active: "var(--gold)",
  won: "var(--gold)",
  refunded: "var(--fg-dim)",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The account sidebar's personal activity history — every bid this user has
 * ever placed, grouped by round, most recent first. Every bid was a real,
 * full-amount charge at the moment it was placed: "Leading" means it's still
 * unrefunded and the round is in progress, "Won" means it's still unrefunded
 * and the round has closed, "Outbid — refunded" means a later bid displaced
 * it and the money already came back.
 *
 * Purely presentational — `status` is fetched once by UserBadge.tsx (which
 * also needs the same data to decide whether the Photo section is unlocked)
 * and handed down, rather than this component fetching `/me/history` again
 * on its own. Two independent fetches of the same N+1 history query, every
 * time the sidebar opens, was real duplicate load for no benefit.
 */
export default function HistoryTable({ status }: { status: HistoryStatus }) {
  if (status === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (status === "error") {
    return <div style={{ color: "var(--fg-dim)" }}>Couldn't load your history — please try again.</div>;
  }

  if (status.entries.length === 0) {
    return <div style={{ color: "var(--fg-dim)" }}>No activity yet — Displace to place a bid.</div>;
  }

  return (
    <div>
      {status.entries.map((entry) => (
        <div key={entry.roundId} style={{ padding: "14px 0", borderBottom: "1px solid var(--line)" }}>
          {entry.bids.map((bid, i) => (
            <div
              key={i}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: i > 0 ? 6 : 0 }}
            >
              <div>
                <span style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20 }}>
                  {formatMoney(bid.amountCents)}
                </span>
                <span style={{ marginLeft: 10, fontSize: 12, color: "var(--fg-faint)" }}>{formatDate(bid.placedAt)}</span>
              </div>
              <div style={{ fontSize: 11, letterSpacing: ".04em", color: STATUS_COLOR[bid.status] }}>
                {STATUS_LABEL[bid.status]}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
