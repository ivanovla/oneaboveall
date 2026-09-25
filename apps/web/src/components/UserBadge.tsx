import { useEffect, useRef, useState } from "react";

type SessionUser = { id: string; email: string; name: string };

const POLL_INTERVAL_MS = 5_000;

// Matches the homepage's other top-right chrome chips (Light/Leaderboard in
// AuctionFlow.tsx) in size and border/background treatment, but round —
// this one renders a name-initial "avatar", the rest render short labels.
const badgeButtonStyle: React.CSSProperties = {
  position: "relative",
  width: 30,
  height: 30,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--btn-fg)",
  background: "var(--gold)",
  border: "1px solid var(--line)",
};

const dotStyle: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: -2,
  width: 9,
  height: 9,
  borderRadius: "50%",
  background: "#e0483e",
  border: "2px solid var(--void)",
};

const sidebarOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  background: "var(--scrim)",
  backdropFilter: "blur(6px)",
};

const sidebarPanelStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  zIndex: 61,
  width: "min(360px, 100vw)",
  background: "var(--panel)",
  borderLeft: "1px solid var(--line)",
  boxShadow: "-40px 0 120px rgba(0,0,0,.6)",
  display: "flex",
  flexDirection: "column",
  animation: "slide-in-right .25s ease both",
};

const sidebarHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 20px",
  borderBottom: "1px solid var(--line)",
};

const sidebarNavLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "14px 20px",
  fontSize: 13,
  letterSpacing: ".04em",
  color: "var(--fg)",
  borderBottom: "1px solid var(--line)",
};

/**
 * A small, always-mounted (rendered inside AuctionFlow.tsx's top-right
 * chrome row, so it hydrates on the same `client:idle` schedule as the rest
 * of that row) badge on the otherwise fully static homepage — the one
 * deliberate exception to "no live widgets on index.astro". Renders nothing
 * at all when signed out, so the static page is visually unchanged for the
 * vast majority of visitors. Signed in, it shows an initial-letter avatar
 * that opens a right-side settings sidebar (account identity, links to the
 * real Auction/Leaderboard pages, sign out) instead of navigating away —
 * the account area's actual pages are still real, separate routes for
 * anyone who lands on them directly or bookmarks them, this is just a
 * quick-access panel over whatever page you're already on.
 *
 * The shaking red dot fires when this user has joined the current round but
 * isn't the one currently leading it — the same `isLeading` field
 * LiveAuction.tsx uses, so the two surfaces can never disagree about what
 * "needs your attention" means.
 */
export default function UserBadge({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [notify, setNotify] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function poll() {
      // A network blip here (fetch rejecting outright, not just a non-OK
      // response) must not become an unhandled rejection that fires again
      // every POLL_INTERVAL_MS — fail closed to "no badge state changes
      // this tick" and let the next interval retry.
      try {
        const meRes = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
        if (cancelledRef.current) return;
        if (!meRes.ok) {
          setUser(null);
          setNotify(false);
          return;
        }
        const meData: SessionUser = await meRes.json();
        if (cancelledRef.current) return;
        setUser(meData);

        const roundRes = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
        if (cancelledRef.current) return;
        const round = roundRes.ok ? await roundRes.json() : null;
        if (!round) {
          setNotify(false);
          return;
        }

        const participationRes = await fetch(`${apiBaseUrl}/rounds/${round.roundId}/me`, { credentials: "include" });
        if (cancelledRef.current) return;
        if (!participationRes.ok) {
          setNotify(false);
          return;
        }
        const participation = await participationRes.json();
        if (cancelledRef.current) return;
        setNotify(!!participation.joined && participation.isLeading === false);
      } catch {
        // Leave user/notify at whatever they last were — a transient
        // failure shouldn't make a signed-in badge disappear.
      }
    }

    poll();

    let intervalId: ReturnType<typeof setInterval> | null = null;
    function startPolling() {
      if (intervalId) return;
      intervalId = setInterval(poll, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        poll();
        startPolling();
      }
    }

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelledRef.current = true;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [apiBaseUrl]);

  // Closing with Escape is standard drawer behavior and cheap to support —
  // only listens while the sidebar is actually open.
  useEffect(() => {
    if (!sidebarOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen]);

  function signOut() {
    fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => {
      window.location.href = "/";
    });
  }

  if (!user) return null;

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <button
        onClick={() => setSidebarOpen(true)}
        style={{ ...badgeButtonStyle, animation: notify ? "badge-shake 3s ease-in-out infinite" : undefined }}
        aria-label={notify ? `${user.name || "Account"} — action needed` : user.name || "Account"}
      >
        {initial || "•"}
        {notify && <span style={dotStyle} aria-hidden="true" />}
      </button>

      {sidebarOpen && (
        <>
          <div style={sidebarOverlayStyle} onClick={() => setSidebarOpen(false)} />
          <div style={sidebarPanelStyle} role="dialog" aria-label="Account settings">
            <div style={sidebarHeaderStyle}>
              <div style={{ fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)" }}>
                Settings
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                style={{ fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--fg-faint)" }}
              >
                Close
              </button>
            </div>

            <div style={{ padding: "20px 20px 0" }}>
              <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>
                {user.name || "Account"}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "var(--fg-dim)" }}>{user.email}</div>
            </div>

            <div style={{ marginTop: 24 }}>
              <a href="/account/auction" style={sidebarNavLinkStyle}>
                Auction
              </a>
              <a href="/account/leaderboard" style={{ ...sidebarNavLinkStyle, borderBottom: "none" }}>
                Leaderboard
              </a>
            </div>

            <div style={{ marginTop: "auto", padding: 20, borderTop: "1px solid var(--line)" }}>
              <button
                onClick={signOut}
                style={{
                  width: "100%",
                  padding: 14,
                  border: "1px solid var(--line)",
                  background: "var(--panel-2)",
                  fontSize: 11,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--fg-dim)",
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
