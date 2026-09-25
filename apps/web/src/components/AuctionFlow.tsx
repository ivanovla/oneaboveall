import { useEffect, useState } from "react";
import { formatMoney, formatCountdown } from "../lib/format";
import { mockCurrentPriceCents, mockBiddingWindowClosesAt, mockReferenceNow, mockLeaderboard } from "../lib/mockData";
import type { LeaderboardRow } from "../lib/types";
import UserBadge from "./UserBadge";

type Screen = "closed" | "auth" | "top";

/**
 * Renders `closesAt` as a live HH:MM:SS countdown.
 *
 * Two constraints shape this:
 *
 * 1. Hydration safety. This island is mounted with `client:idle`, so Astro
 *    server-renders it at *build* time and the browser has to reproduce that
 *    exact markup on hydration. Reading `Date.now()` during render (as
 *    `useState(() => Date.now())` did) bakes the build machine's clock into
 *    the static HTML, which the browser then contradicts — a React hydration
 *    mismatch, plus a stale figure on screen until the idle callback fires.
 *    So the first render is derived purely from fixed data, and the only
 *    `Date.now()` reads happen inside the effect, which never runs on the
 *    server.
 *
 * 2. A frozen mock snapshot. Remaining time is measured from
 *    `mockReferenceNow`, not the real wall clock. The mock dataset is a
 *    snapshot taken at that instant; comparing its fixed close time against
 *    the real clock is what decayed the countdown to a permanent `00:00:00`
 *    in the first place, and no fixed date can survive that comparison for
 *    more than a few hours. Anchoring to the snapshot reproduces the
 *    prototype's own behaviour exactly (it seeds `left` with a literal
 *    6h41m12s and decrements it once a second) while keeping `closesAt`
 *    modelled the way a real API would hand it over — as a timestamp.
 *
 *    KNOWN GAP — deliberate, tracked. The API exposes only `getScene` /
 *    `getLeaderboard`; there is no round state fetch on the public homepage,
 *    so this countdown is still a demo figure rather than a real bidding
 *    window close time. The real bidding/deposit flow lives at
 *    /account/auction (LiveAuction.tsx), which polls the real
 *    `GET /current-round` for a real `biddingClosesAt`.
 *
 * The ticking is driven by elapsed real time since mount rather than by
 * counting interval fires, so a throttled background tab resumes at the right
 * value instead of drifting.
 */
function useCountdown(closesAt: Date): string {
  const remainingAtSnapshotMs = closesAt.getTime() - mockReferenceNow.getTime();
  const [elapsedSinceMountMs, setElapsedSinceMountMs] = useState(0);

  useEffect(() => {
    const mountedAt = Date.now();
    const id = setInterval(() => setElapsedSinceMountMs(Date.now() - mountedAt), 1000);
    return () => clearInterval(id);
  }, []);

  return formatCountdown(remainingAtSnapshotMs - elapsedSinceMountMs);
}

const overlayShellStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "var(--scrim)",
  backdropFilter: "blur(18px)",
  overflow: "auto",
};

const overlayPanelStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 472,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  boxShadow: "0 40px 120px rgba(0,0,0,.6)",
  animation: "rise .28s ease both",
};

const overlayHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 20px",
  borderBottom: "1px solid var(--line)",
};

const overlayBodyStyle: React.CSSProperties = {
  padding: "28px 26px 30px",
};

const headingStyle: React.CSSProperties = {
  fontFamily: "'Cormorant Garamond', Georgia, serif",
  fontSize: 36,
  lineHeight: 1.06,
};

// The two fixed top-right chrome chips (theme toggle + Leaderboard), styled
// identically in the prototype.
const chromeButtonStyle: React.CSSProperties = {
  padding: "8px 13px",
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "var(--on-scene-dim)",
  border: "1px solid var(--line)",
  background: "var(--scene-chip)",
  backdropFilter: "blur(8px)",
};

// Keep in sync with the pre-paint theme script in layouts/BaseLayout.astro,
// which reads the same key before this island ever hydrates.
const THEME_STORAGE_KEY = "oneabobeall:theme";

/**
 * Drives the `data-theme` attribute on <html>, which tokens.css keys its
 * light palette (and the scene's `--shade` blend) off.
 *
 * `document` is deliberately never touched during render: this island is
 * server-rendered at build time, so the first client render has to match the
 * static HTML. The button label is seeded with the dark-theme default (it
 * names the theme it would switch *to*, as in the prototype) and corrected in
 * an effect once the real, possibly persisted, theme is known.
 */
function useThemeToggle(): { label: string; toggle: () => void } {
  const [isLight, setIsLight] = useState(false);

  useEffect(() => {
    setIsLight(document.documentElement.dataset.theme === "light");
  }, []);

  function toggle() {
    const root = document.documentElement;
    const nextIsLight = root.dataset.theme !== "light";
    if (nextIsLight) {
      root.dataset.theme = "light";
    } else {
      delete root.dataset.theme;
    }
    setIsLight(nextIsLight);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextIsLight ? "light" : "dark");
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The
      // toggle still works for this page view; it just won't be remembered.
    }
  }

  return { label: isLight ? "Dark" : "Light", toggle };
}

function OverlayShell({
  stepLabel,
  onClose,
  children,
}: {
  stepLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={overlayShellStyle}>
      <div style={overlayPanelStyle}>
        <div style={overlayHeaderStyle}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            {stepLabel}
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 11,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: "var(--fg-faint)",
            }}
          >
            Close
          </button>
        </div>
        <div style={overlayBodyStyle}>{children}</div>
      </div>
    </div>
  );
}

const signInLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: 16,
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  fontSize: 13,
  letterSpacing: ".04em",
  color: "var(--fg)",
};

export default function AuctionFlow({
  initialScreen = "closed",
  leaderboard = mockLeaderboard,
  // The price the seat currently costs — i.e. the reigning champion's
  // priceCents. pages/index.astro passes the real, adapted champion's price
  // here, so the headline figure above the Displace button is the same number
  // the scene's own tooltip shows for the champion rendered right above it.
  // Defaults to the mock constant so this component still renders standalone
  // (tests, any caller with no live data) exactly as it did before.
  currentPriceCents = mockCurrentPriceCents,
  // Base URL of the live API — "Continue with Google/Apple" below are real,
  // top-level-navigation links into it (GET /auth/google, GET /auth/apple),
  // not client-side calls, so the browser follows the provider's redirect
  // chain and lands back on /account (see authGoogle.ts/authApple.ts).
  apiBaseUrl = "http://127.0.0.1:3001",
}: {
  initialScreen?: Screen;
  leaderboard?: LeaderboardRow[];
  currentPriceCents?: number;
  apiBaseUrl?: string;
} = {}) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  // null while unknown (first render, before the check resolves) — Displace
  // falls back to the sign-in screen in that window rather than waiting,
  // since a signed-out visitor is by far the common case and the check
  // resolves in well under the time it takes to actually click the button.
  const [signedIn, setSignedIn] = useState(false);
  const theme = useThemeToggle();
  const clock = useCountdown(mockBiddingWindowClosesAt);
  const priceLabel = formatMoney(currentPriceCents);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (!cancelled) setSignedIn(res.ok);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  function closeOverlay() {
    setScreen("closed");
  }

  // Already signed in — the real bid/deposit flow lives at /account/auction,
  // so Displace goes straight there instead of showing sign-in links a
  // signed-in visitor has no use for.
  function handleDisplace() {
    if (signedIn) {
      window.location.href = "/account/auction";
      return;
    }
    setScreen("auth");
  }

  return (
    <div>
      <div
        style={{
          position: "fixed",
          top: 22,
          right: 24,
          display: "flex",
          gap: 6,
          alignItems: "center",
          zIndex: 20,
        }}
      >
        <button onClick={theme.toggle} style={chromeButtonStyle} aria-label={`Switch to ${theme.label.toLowerCase()} theme`}>
          {theme.label}
        </button>
        <button onClick={() => setScreen("top")} style={chromeButtonStyle}>
          Leaderboard
        </button>
        <UserBadge apiBaseUrl={apiBaseUrl} />
      </div>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "150px 20px 34px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          zIndex: 15,
          color: "var(--on-scene)",
          background:
            "linear-gradient(to top, rgba(6,5,2,.86) 0%, rgba(6,5,2,.66) 42%, rgba(6,5,2,0) 100%)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".32em",
              textTransform: "uppercase",
              color: "var(--on-scene-faint)",
            }}
          >
            Current price of the seat
          </div>
          <div
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: "clamp(46px, 7vw, 88px)",
              lineHeight: 0.92,
              letterSpacing: "-.02em",
            }}
          >
            {priceLabel}
          </div>
        </div>
        <button
          onClick={handleDisplace}
          style={{
            padding: "19px 58px",
            background: "var(--gold)",
            color: "var(--btn-fg)",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: ".42em",
            textTransform: "uppercase",
            boxShadow: "0 18px 48px rgba(201,164,92,.22)",
          }}
        >
          Displace
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 12, color: "var(--on-scene-dim)" }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--gold)",
              animation: "breathe 2.4s infinite",
            }}
          />
          <span>Bidding window closes in</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--on-scene)", letterSpacing: ".06em" }}>
            {clock}
          </span>
        </div>
      </div>

      {screen === "auth" && (
        <OverlayShell stepLabel="Sign in" onClose={closeOverlay}>
          <div style={headingStyle}>Sign in to claim the seat</div>
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
            One account, one bid per round.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 24 }}>
            <a href={`${apiBaseUrl}/auth/google`} style={signInLinkStyle}>
              Continue with Google
            </a>
            <a href={`${apiBaseUrl}/auth/apple`} style={signInLinkStyle}>
              Continue with Apple
            </a>
          </div>
          <div style={{ marginTop: 18, fontSize: 11, lineHeight: 1.6, color: "var(--fg-faint)" }}>
            Terms of participation and deposit rules are on the rules page.
          </div>
        </OverlayShell>
      )}

      {screen === "top" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "var(--scrim)",
            backdropFilter: "blur(20px)",
            overflow: "auto",
          }}
        >
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto",
              padding: "clamp(28px, 7vh, 72px) 22px 80px",
              animation: "rise .3s ease both",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: ".3em", textTransform: "uppercase", color: "var(--gold)" }}>
                  Leaderboard
                </div>
                <div
                  style={{
                    fontFamily: "'Cormorant Garamond', Georgia, serif",
                    fontSize: "clamp(38px, 6vw, 60px)",
                    lineHeight: 1.02,
                    marginTop: 10,
                  }}
                >
                  Who held the seat the longest
                </div>
              </div>
              <button
                onClick={closeOverlay}
                style={{
                  flex: "0 0 auto",
                  padding: "10px 15px",
                  border: "1px solid var(--line)",
                  fontSize: 10,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--fg-dim)",
                }}
              >
                Close
              </button>
            </div>
            <div style={{ marginTop: 38, borderTop: "1px solid var(--line)" }}>
              {leaderboard.map((row, i) => (
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
            <div style={{ marginTop: 20, fontSize: 11, color: "var(--fg-faint)" }}>
              Cumulative time at the head of the table. Data since March 3, 2026.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
