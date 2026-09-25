import { useEffect, useState } from "react";
import HistoryTable from "./HistoryTable";

type SessionUser = { id: string; email: string; name: string };

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

function EmailConfirmStep({
  apiBaseUrl,
  initialEmail,
  onDone,
}: {
  apiBaseUrl: string;
  initialEmail: string;
  onDone: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/email`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Couldn't save that email — please try again.");
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that email — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>One more thing</div>
      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
        We'll notify you at this address about activity on your bids — including if you're outbid or you win a round.
      </div>
      <label htmlFor="account-email" style={{ display: "block", marginTop: 20, fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--fg-faint)" }}>
        Email
      </label>
      <input
        id="account-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ display: "block", width: "100%", marginTop: 8, padding: "14px 16px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }}
      />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      <button
        onClick={submit}
        disabled={submitting}
        style={{ width: "100%", marginTop: 18, padding: 16, background: "var(--gold)", color: "var(--btn-fg)", fontSize: 12, fontWeight: 600, letterSpacing: ".28em", textTransform: "uppercase" }}
      >
        {submitting ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}

/**
 * A small, always-mounted (rendered inside AuctionFlow.tsx's top-right
 * chrome row, so it hydrates on the same `client:idle` schedule as the rest
 * of that row) badge on the otherwise fully static homepage — the one
 * deliberate exception to "no live widgets on index.astro". Renders nothing
 * at all when signed out, so the static page is visually unchanged for the
 * vast majority of visitors.
 *
 * Signed in, it shows an initial-letter avatar that opens a right-side
 * settings sidebar — account identity, this user's own bid history
 * (HistoryTable.tsx), and sign out — over whatever page you're already on.
 * The actual bid/deposit flow lives elsewhere now (AuctionFlow's own
 * Displace button opens BidFlow.tsx directly), not in this sidebar. The
 * public leaderboard is a separate thing entirely, reachable from the
 * homepage's own Leaderboard chip — this sidebar doesn't duplicate it.
 *
 * Also handles the one-time post-signup email-confirmation step (the
 * `?welcome=1` the OAuth callbacks redirect new signups to).
 *
 * Checks session state exactly once, on mount — no polling. Being outbid
 * is surfaced by email now (see PATCH /auth/email's confirmation copy),
 * not by a live-polled notification dot, so there's nothing here that
 * needs a repeating request to the server.
 */
export default function UserBadge({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [awaitingEmailConfirm, setAwaitingEmailConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setUser(null);
          return;
        }
        return res.json();
      })
      .then((data?: SessionUser) => {
        if (cancelled || !data) return;
        setUser(data);
        if (new URLSearchParams(window.location.search).get("welcome") === "1") {
          setAwaitingEmailConfirm(true);
          setSidebarOpen(true);
        }
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  // Closing with Escape is standard drawer behavior and cheap to support —
  // only listens while the sidebar is open, and never while the email step
  // is forcing the visitor to finish it first.
  useEffect(() => {
    if (!sidebarOpen || awaitingEmailConfirm) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen, awaitingEmailConfirm]);

  function signOut() {
    fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => {
      window.location.href = "/";
    });
  }

  function finishEmailConfirm() {
    // Clears ?welcome=1 so a later refresh of this exact URL doesn't show
    // the step again. Built from the parts rather than
    // `new URL(window.location.href)`, which throws on a relative stub
    // `window.location` (as used in tests).
    const params = new URLSearchParams(window.location.search);
    params.delete("welcome");
    const query = params.toString();
    const newPath = (window.location.pathname || "") + (query ? `?${query}` : "");
    window.history.replaceState(null, "", newPath || "/");
    setAwaitingEmailConfirm(false);
  }

  if (!user) return null;

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <button onClick={() => setSidebarOpen(true)} style={badgeButtonStyle} aria-label={user.name || "Account"}>
        {initial || "•"}
      </button>

      {sidebarOpen && (
        <>
          {!awaitingEmailConfirm && <div style={sidebarOverlayStyle} onClick={() => setSidebarOpen(false)} />}
          <div style={sidebarPanelStyle} role="dialog" aria-label="Account settings">
            {awaitingEmailConfirm ? (
              <EmailConfirmStep apiBaseUrl={apiBaseUrl} initialEmail={user.email} onDone={finishEmailConfirm} />
            ) : (
              <>
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

                <div style={{ marginTop: 20, fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)", padding: "0 20px" }}>
                  History
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
                  <HistoryTable apiBaseUrl={apiBaseUrl} />
                </div>

                <div style={{ padding: 20, borderTop: "1px solid var(--line)" }}>
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
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
