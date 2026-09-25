import { useEffect, useState } from "react";
import { formatMoney } from "../lib/format";

type DepositStatus = "held" | "refunded" | "forfeited" | "applied";

type HistoryEntry = {
  roundId: string;
  depositCents: number;
  depositStatus: DepositStatus;
  joinedAt: string;
  bids: { amountCents: number; placedAt: string }[];
};

type Status = "loading" | "error" | { entries: HistoryEntry[] };

const STATUS_LABEL: Record<DepositStatus, string> = {
  held: "In progress",
  applied: "Won — deposit applied",
  refunded: "Not selected — deposit refunded",
  forfeited: "Forfeited",
};

const STATUS_COLOR: Record<DepositStatus, string> = {
  held: "var(--fg-dim)",
  applied: "var(--gold)",
  refunded: "var(--fg-dim)",
  forfeited: "#e0483e",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The account sidebar's personal activity history — every round this user
 * has joined, most recent first, with their own bids in each (never
 * another bidder's, and never the round's overall leader). Replaces the
 * sidebar's earlier read-only public leaderboard, which just duplicated
 * what the homepage's own Leaderboard button already shows.
 */
export default function HistoryTable({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/me/history`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`history request failed: ${res.status}`);
        return res.json();
      })
      .then((data: { history: HistoryEntry[] }) => {
        if (cancelled) return;
        setStatus({ entries: data.history });
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  if (status === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (status === "error") {
    return <div style={{ color: "var(--fg-dim)" }}>Couldn't load your history — please try again.</div>;
  }

  if (status.entries.length === 0) {
    return <div style={{ color: "var(--fg-dim)" }}>No activity yet — Displace to join a round.</div>;
  }

  return (
    <div>
      {status.entries.map((entry) => (
        <div key={entry.roundId} style={{ padding: "14px 0", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--fg-faint)" }}>{formatDate(entry.joinedAt)}</div>
            <div style={{ fontSize: 11, letterSpacing: ".04em", color: STATUS_COLOR[entry.depositStatus] }}>
              {STATUS_LABEL[entry.depositStatus]}
            </div>
          </div>
          <div style={{ marginTop: 6, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 22 }}>
            {formatMoney(entry.depositCents)} deposit
          </div>
          {entry.bids.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-dim)" }}>
              {entry.bids.length} bid{entry.bids.length === 1 ? "" : "s"}, highest{" "}
              {formatMoney(Math.max(...entry.bids.map((b) => b.amountCents)))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
