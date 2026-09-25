import { useEffect, useState } from "react";
import { formatMoney } from "../lib/format";
import { adaptLeaderboardRow } from "../lib/sceneAdapter";
import type { ApiLeaderboardRow } from "../lib/apiTypes";
import type { LeaderboardRow } from "../lib/types";

type Status = "loading" | "error" | { rows: LeaderboardRow[] };

/**
 * The account-area counterpart to AuctionFlow's leaderboard overlay on the
 * public homepage — same data (`GET /leaderboard`, public, no session
 * needed), same row styling, but rendered as this page's own content rather
 * than a modal, and fetched client-side (this page is served fully static,
 * see astro.config.mjs's `output: "static"`, so an Astro frontmatter fetch
 * here would only ever run once at build time, not per visit).
 */
export default function LeaderboardTable({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/leaderboard`)
      .then((res) => {
        if (!res.ok) throw new Error(`leaderboard request failed: ${res.status}`);
        return res.json();
      })
      .then((data: ApiLeaderboardRow[]) => {
        if (cancelled) return;
        setStatus({ rows: data.map(adaptLeaderboardRow) });
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
    return <div style={{ color: "var(--fg-dim)" }}>Couldn't load the leaderboard — please try again.</div>;
  }

  if (status.rows.length === 0) {
    return <div style={{ color: "var(--fg-dim)" }}>No completed reigns yet.</div>;
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div
        style={{
          fontFamily: "'Cormorant Garamond', Georgia, serif",
          fontSize: "clamp(32px, 5vw, 44px)",
          lineHeight: 1.05,
        }}
      >
        Who held the seat the longest
      </div>
      <div style={{ marginTop: 28, borderTop: "1px solid var(--line)" }}>
        {status.rows.map((row, i) => (
          <div
            key={row.occupantId}
            style={{
              display: "grid",
              gridTemplateColumns: "38px 1fr auto auto",
              gap: "clamp(10px, 3vw, 28px)",
              alignItems: "center",
              padding: "17px 4px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 22, color: "var(--gold)" }}>
              {String(i + 1).padStart(2, "0")}
            </div>
            <div>
              <div style={{ fontSize: 15 }}>{row.name}</div>
              <div style={{ marginTop: 3, fontSize: 11, color: "var(--fg-faint)" }}>
                {row.rounds} round{row.rounds === 1 ? "" : "s"}
              </div>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>
              {formatMoney(row.totalSpentCents)}
            </div>
            <div
              style={{
                textAlign: "right",
                minWidth: 74,
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: 21,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {row.totalDurationLabel}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
