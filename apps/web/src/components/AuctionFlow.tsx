import { useEffect, useState } from "react";
import { formatMoney, formatCountdown } from "../lib/format";
import { mockLeaderboard } from "../lib/mockData";
import type { LeaderboardRow } from "../lib/types";
import type { ApiCurrentRound, ApiPublicPerson } from "../lib/apiTypes";
import { sendAttributionIfNeeded } from "../lib/attribution";
import UserBadge from "./UserBadge";
import BidFlow from "./BidFlow";
import PhotoUploader from "./PhotoUploader";
import ViewCounter from "./ViewCounter";
import { chromeButtonStyle, sponsoredTagStyle } from "./chromeStyles";

type Screen = "closed" | "auth" | "bid" | "top" | "photoReminder";

/**
 * Renders a live HH:MM:SS countdown to `closesAt` — the real
 * `biddingClosesAt` from `GET /current-round`, fetched once by the caller
 * and handed down (see the poll effect below). `closesAt` is a fixed
 * timestamp for as long as the current round is running, so once it's
 * known, ticking it down is pure client-side arithmetic against the
 * browser's own clock — nothing here ever needs to ask the server what the
 * remaining time is, only what the close time itself is.
 *
 * Deliberately shows a neutral placeholder, not a guessed number, before
 * `closesAt` is known: this island is mounted with `client:idle`, so Astro
 * server-renders it at *build* time and the browser has to reproduce that
 * exact markup on hydration — reading `Date.now()` during render would bake
 * the build machine's clock into the static HTML, which the browser then
 * contradicts. An earlier version filled that gap with a fixed demo
 * countdown instead, which meant every page load visibly *jumped* from that
 * made-up figure to the real one the instant the fetch resolved. A
 * placeholder has nothing to jump from.
 */
function useCountdown(closesAt: Date | null): string {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!closesAt) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [closesAt]);

  if (!closesAt || nowMs === null) return "—:--:--";
  return formatCountdown(closesAt.getTime() - nowMs);
}

// Stands in for the headline price while it's still unconfirmed (before the
// first /current-round fetch resolves — see the poll effect below). Sized to
// roughly match the price text's own footprint so the swap from spinner to
// number doesn't visibly shift the layout around it.
const priceSpinnerStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  margin: "6px 0",
  border: "3px solid var(--on-scene-faint)",
  borderTopColor: "var(--gold)",
  borderRadius: "50%",
  animation: "spin .9s linear infinite",
};

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
// identically in the prototype. Shared with ViewCounter.tsx — see
// chromeStyles.ts.

// Keep in sync with the pre-paint theme script in layouts/BaseLayout.astro,
// which reads the same key before this island ever hydrates.
const THEME_STORAGE_KEY = "oneaboveall:theme";

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
  // Base URL of the live API — "Continue with Google/Apple" below are real,
  // top-level-navigation links into it (GET /auth/google, GET /auth/apple),
  // not client-side calls, so the browser follows the provider's redirect
  // chain and lands back on / (see authGoogle.ts/authApple.ts).
  apiBaseUrl = "http://127.0.0.1:3001",
}: {
  initialScreen?: Screen;
  leaderboard?: LeaderboardRow[];
  apiBaseUrl?: string;
} = {}) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  // null while unknown (first render, before the check resolves) — Displace
  // falls back to the sign-in screen in that window rather than waiting,
  // since a signed-out visitor is by far the common case and the check
  // resolves in well under the time it takes to actually click the button.
  const [signedIn, setSignedIn] = useState(false);
  // The signed-in user's id — needed to hand to the photo-reminder's
  // PhotoUploader below. Distinct from UserBadge's own copy of this same
  // session check; each widget owns its own fetch rather than one being
  // threaded through the other.
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  // null until the first live fetch resolves — the headline shows a spinner
  // until then rather than a build/SSR-time price that might already be
  // wrong. pages/index.astro used to pass that build-time price in as a
  // fallback (the reigning champion's priceCents, fetched from /scene at
  // build time); dropped in favor of only ever showing a number this
  // component has itself confirmed live, matching biddingClosesAt below —
  // no guess that can later visibly jump to a different real value.
  const [liveLeaderCents, setLiveLeaderCents] = useState<number | null>(null);
  // Same reasoning as `liveLeaderCents` above, for the "Bidding window
  // closes in" line — see useCountdown's own doc comment.
  const [liveBiddingClosesAt, setLiveBiddingClosesAt] = useState<Date | null>(null);
  // Who holds the top bid right now — the "Leading: NAME" line under the
  // price, the whole point of which is to make visitors want to knock that
  // person off. `undefined` = not known (no fetch yet, or an older API that
  // doesn't send it: render nothing); `null` = nobody has bid this round.
  const [liveLeader, setLiveLeader] = useState<ApiPublicPerson | null | undefined>(undefined);
  const theme = useThemeToggle();
  const clock = useCountdown(liveBiddingClosesAt);
  const priceLabel = liveLeaderCents === null ? null : formatMoney(liveLeaderCents);

  // One combined effect for everything that needs a session check and/or the
  // live round: the price/countdown poll, the sign-in check, and the
  // photo-reminder nudge all used to fetch independently, which meant a
  // signed-in visitor missing a photo triggered *two* separate
  // /current-round requests on the very same page load. `authPromise`
  // resolves exactly once and every poll tick awaits it before deciding
  // whether to run the (also one-time) photo-reminder check — that ordering
  // guarantees correctness without racing whichever fetch happens to land
  // first, and without a second fetch of the busiest route in the service.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let needsPhotoReminder = false;
    let photoReminderChecked = false;
    const POLL_INTERVAL_MS = 8000;

    const authPromise = fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (cancelled) return null;
        setSignedIn(res.ok);
        return res.ok ? res.json() : null;
      })
      .then((data: { id: string; photoPath: string | null } | null) => {
        if (cancelled || !data) return;
        setSessionUserId(data.id);
        if (!data.photoPath) needsPhotoReminder = true;
        // First moment we know who this visitor is: hand the streamer
        // attribution captured at landing (lib/attribution.ts) to their
        // account. Fire-and-forget and once per browser — it never throws
        // and has nothing to show.
        void sendAttributionIfNeeded(apiBaseUrl);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });

    // Currently paid (leading the active round) but no photo on file: the
    // mandatory photo step in BidFlow (see BidFlow.tsx's "photo" step) may
    // have been abandoned after paying — a real bid with no photo attached is
    // an incomplete participation, so prompt for it here too. Piggybacks on
    // the round id the poll below already fetched rather than re-fetching
    // it, and only ever runs once per mount (`photoReminderChecked`), not on
    // every subsequent poll tick.
    function checkPhotoReminder(roundId: string) {
      if (photoReminderChecked) return;
      photoReminderChecked = true;
      fetch(`${apiBaseUrl}/rounds/${roundId}/me`, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((me: { isLeading: boolean } | null) => {
          if (cancelled || !me?.isLeading) return;
          // Never clobber a screen the visitor already navigated to
          // themselves (e.g. they clicked Displace while this was in flight).
          setScreen((current) => (current === "closed" ? "photoReminder" : current));
        })
        .catch(() => {
          // Best-effort nudge — nothing to surface if this particular check
          // fails; the reminder just won't show for this page load.
        });
    }

    // Keeps the headline price *and* the bidding-window countdown live while
    // the tab is open, not just accurate at the moment this page happened to
    // render. Self-rescheduling rather than setInterval so a slow response
    // can't pile up overlapping requests, and paused entirely while the tab
    // is hidden (resuming with an immediate refresh when it becomes visible
    // again) rather than burning polls a backgrounded tab has no use for.
    async function poll() {
      try {
        const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
        if (!cancelled && res.ok) {
          const data: ApiCurrentRound | null = await res.json();
          if (!cancelled) {
            setLiveLeaderCents(data ? data.currentLeaderCents : null);
            setLiveLeader(data ? data.leader : undefined);
            // Same round → same close time on every poll — keep the same
            // Date *reference* rather than swapping in an equal-but-new one
            // each tick, so useCountdown's effect (keyed on this value)
            // doesn't restart its ticker every 8 seconds for no reason.
            setLiveBiddingClosesAt((prev) => {
              if (!data) return null;
              const nextMs = new Date(data.biddingClosesAt).getTime();
              return prev && prev.getTime() === nextMs ? prev : new Date(nextMs);
            });
            if (data) {
              await authPromise;
              if (!cancelled && needsPhotoReminder) checkPhotoReminder(data.roundId);
            }
          }
        }
      } catch {
        // Transient failure — the next poll (or the build-time fallback
        // price) covers it; nothing to surface for a background refresh.
      }
      if (!cancelled && document.visibilityState !== "hidden") {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (!timer) {
        poll();
      }
    }

    poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [apiBaseUrl]);

  function closeOverlay() {
    setScreen("closed");
  }

  // Escape closes whichever overlay is open (sign-in, Displace, the photo
  // reminder, the leaderboard) — same action as each one's own Close button,
  // just from the keyboard. Matches UserBadge's own sidebar, which already
  // does this.
  useEffect(() => {
    if (screen === "closed") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setScreen("closed");
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [screen]);

  // Already signed in — go straight to the bid entry, skipping the sign-in
  // links a signed-in visitor has no use for.
  function handleDisplace() {
    setScreen(signedIn ? "bid" : "auth");
  }

  return (
    <div>
      <ViewCounter apiBaseUrl={apiBaseUrl} />
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
          {priceLabel === null ? (
            <div style={priceSpinnerStyle} role="status" aria-label="Loading current price" />
          ) : (
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
          )}
          {priceLabel !== null && liveLeader !== undefined && (
            <div style={{ fontSize: 12, letterSpacing: ".04em", color: "var(--on-scene-dim)" }}>
              {liveLeader === null ? (
                "No bids yet this round"
              ) : (
                <>
                  Leading: <span style={{ color: "var(--on-scene)", fontWeight: 600 }}>{liveLeader.name}</span>
                  {liveLeader.sponsored && <span style={sponsoredTagStyle}>Sponsored</span>}
                </>
              )}
            </div>
          )}
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
            By continuing you agree to the{" "}
            <a href="/terms" style={{ textDecoration: "underline" }}>Terms</a> and{" "}
            <a href="/privacy" style={{ textDecoration: "underline" }}>Privacy Policy</a>.
          </div>
        </OverlayShell>
      )}

      {screen === "bid" && (
        <OverlayShell stepLabel="Displace" onClose={closeOverlay}>
          <BidFlow apiBaseUrl={apiBaseUrl} onDone={closeOverlay} />
        </OverlayShell>
      )}

      {screen === "photoReminder" && sessionUserId && (
        <OverlayShell stepLabel="Photo" onClose={closeOverlay}>
          <div style={headingStyle}>Add your photo</div>
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
            You're currently leading — a photo is required to complete your participation.
          </div>
          <PhotoUploader
            apiBaseUrl={apiBaseUrl}
            userId={sessionUserId}
            hasPhoto={false}
            submitLabel="Upload photo"
            onUploaded={closeOverlay}
            onUnauthorized={closeOverlay}
          />
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
                    <div style={{ fontSize: 15 }}>
                      {row.name}
                      {row.sponsored && <span style={sponsoredTagStyle}>Sponsored</span>}
                    </div>
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
