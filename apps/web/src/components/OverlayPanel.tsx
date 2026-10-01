import { useEffect, useState } from "react";
import { formatCountdown, formatMoney } from "../lib/format";
import type { ApiCurrentRound } from "../lib/apiTypes";

// The OBS overlay (pages/overlay.astro): a compact live panel a streamer
// adds as a Browser Source on top of their stream — the cheapest possible
// "go take the seat" ad. It polls the same public, cached GET /current-round
// the homepage does, so a thousand viewers' worth of streams costs the API
// nothing extra per viewer: only the streamer's one OBS instance polls.

const POLL_INTERVAL_MS = 5000;

// Hard-coded rather than the site's theme tokens: this renders inside OBS,
// on top of arbitrary video, and has to stay legible regardless of any
// light/dark preference — a semi-opaque dark panel with the site's gold.
const GOLD = "#c9a45c";
const TEXT = "#f3ead8";
const DIM = "rgba(243, 234, 216, .66)";
const FAINT = "rgba(243, 234, 216, .42)";

const panelStyle: React.CSSProperties = {
  width: 360,
  boxSizing: "border-box",
  padding: "14px 16px 13px",
  background: "rgba(10, 8, 5, .82)",
  border: `1px solid rgba(201, 164, 92, .45)`,
  borderLeft: `3px solid ${GOLD}`,
  color: TEXT,
  fontFamily: "Manrope, Helvetica, Arial, sans-serif",
  boxShadow: "0 10px 30px rgba(0,0,0,.45)",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".22em",
  textTransform: "uppercase",
  color: FAINT,
};

const tagStyle: React.CSSProperties = {
  display: "inline-block",
  marginLeft: 6,
  padding: "0 5px",
  border: `1px solid rgba(201, 164, 92, .6)`,
  fontSize: 8,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: GOLD,
  verticalAlign: "middle",
};

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** "HH:MM:SS" until the close; the after-close line once it has passed. */
export function overlayCountdownLabel(closesAtMs: number, nowMs: number): string {
  const remaining = closesAtMs - nowMs;
  // Bidding closes at 4 PM ET; the new champion is installed after the
  // ~3h processing gap (see the engine's dailyClose / roundResolution).
  if (remaining <= 0) return "Bidding closed — new champion at ~7 PM ET";
  return formatCountdown(remaining);
}

function readCompactFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("compact") === "1";
  } catch {
    return false;
  }
}

export default function OverlayPanel({
  apiBaseUrl = "http://127.0.0.1:3001",
  // Normally read from `?compact=1` — a prop only so tests can set it.
  compact: compactProp,
}: {
  apiBaseUrl?: string;
  compact?: boolean;
}) {
  const [round, setRound] = useState<ApiCurrentRound | null | "loading">("loading");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [compact] = useState(() => compactProp ?? readCompactFlag());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Self-rescheduling (not setInterval) so a slow response can't stack
    // up overlapping requests. No visibility pausing, unlike AuctionFlow:
    // OBS renders a Browser Source without it ever being a "visible tab".
    async function poll() {
      try {
        // No credentials: the route is public and must not vary by viewer.
        const res = await fetch(`${apiBaseUrl}/current-round`);
        if (!cancelled && res.ok) {
          const data: ApiCurrentRound | null = await res.json();
          if (!cancelled) setRound(data);
        }
      } catch {
        // Transient — keep showing the last good data; next poll retries.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (round === "loading" || round === null) {
    return (
      <div style={panelStyle}>
        <div style={{ ...eyebrowStyle, color: GOLD }}>oneaboveall.org</div>
        <div style={{ marginTop: 6, fontSize: 12, color: DIM }}>{round === "loading" ? "Loading…" : "No active round right now"}</div>
      </div>
    );
  }

  const closesAtMs = new Date(round.biddingClosesAt).getTime();
  const closed = closesAtMs - nowMs <= 0;
  const recentBids = round.recentBids ?? [];

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", color: GOLD }}>
          oneaboveall.org
        </div>
        <div style={{ ...eyebrowStyle, ...ellipsis }}>
          {round.champion ? (
            <>
              Seat: <span style={{ color: TEXT }}>{round.champion.name}</span>
              {round.champion.sponsored && <span style={tagStyle}>Sponsored</span>}
            </>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginTop: 8 }}>
        <div>
          <div style={eyebrowStyle}>Price to take the seat</div>
          <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, lineHeight: 1, marginTop: 2 }}>
            {formatMoney(round.currentLeaderCents)}
          </div>
        </div>
        <div style={{ textAlign: "right", minWidth: 0 }}>
          <div style={eyebrowStyle}>{closed ? "Status" : "Bidding closes in"}</div>
          <div
            style={{
              marginTop: 3,
              fontSize: closed ? 11 : 18,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: ".04em",
              color: closed ? DIM : TEXT,
            }}
          >
            {overlayCountdownLabel(closesAtMs, nowMs)}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 9, paddingTop: 8, borderTop: "1px solid rgba(243,234,216,.14)", fontSize: 13, ...ellipsis }}>
        {round.leader ? (
          <>
            <span style={{ color: DIM }}>Leading: </span>
            <span style={{ fontWeight: 600 }}>{round.leader.name}</span>
            {round.leader.sponsored && <span style={tagStyle}>Sponsored</span>}
          </>
        ) : (
          <span style={{ color: DIM }}>No bids yet</span>
        )}
      </div>

      {!compact && recentBids.length > 0 && (
        <ul aria-label="Recent bids" style={{ listStyle: "none", margin: "7px 0 0", padding: 0 }}>
          {recentBids.map((bid, i) => (
            <li
              key={`${bid.placedAt}-${i}`}
              style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, lineHeight: 1.65, color: i === 0 ? TEXT : DIM }}
            >
              <span style={ellipsis}>{bid.name}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{formatMoney(bid.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
