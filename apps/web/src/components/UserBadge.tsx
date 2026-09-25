import { useEffect, useState } from "react";
import HistoryTable, { type HistoryEntry, type HistoryStatus } from "./HistoryTable";
import PhotoUploader from "./PhotoUploader";

type SessionUser = {
  id: string;
  email: string;
  name: string;
  photoPath: string | null;
  socialUrl: string | null;
  characterRequest: string | null;
};

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

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 20,
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const textFieldStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 8,
  padding: "14px 16px",
  background: "transparent",
  border: "1px solid var(--gold-soft)",
  color: "var(--fg)",
};

function EmailConfirmStep({
  apiBaseUrl,
  initialEmail,
  initialName,
  onDone,
}: {
  apiBaseUrl: string;
  initialEmail: string;
  initialName: string;
  onDone: (name: string) => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const [emailRes, nameRes] = await Promise.all([
        fetch(`${apiBaseUrl}/auth/email`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }),
        fetch(`${apiBaseUrl}/auth/name`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmedName }),
        }),
      ]);
      if (!emailRes.ok) {
        const data = await emailRes.json();
        setError(data.error ?? "Couldn't save that email — please try again.");
        return;
      }
      if (!nameRes.ok) {
        const data = await nameRes.json();
        setError(data.error ?? "Couldn't save that name — please try again.");
        return;
      }
      onDone(trimmedName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that — please try again.");
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
      <label htmlFor="account-email" style={fieldLabelStyle}>
        Email
      </label>
      <input
        id="account-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={textFieldStyle}
      />
      <label htmlFor="account-shown-name" style={fieldLabelStyle}>
        Shown name
      </label>
      <div style={{ marginTop: 4, fontSize: 11, color: "var(--fg-faint)" }}>
        The name shown publicly if you become champion — on the seat, in the leaderboard.
      </div>
      <input
        id="account-shown-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={textFieldStyle}
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

function NameEditor({
  apiBaseUrl,
  initialName,
  onSaved,
  onUnauthorized,
}: {
  apiBaseUrl: string;
  initialName: string;
  onSaved: (name: string) => void;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/name`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Couldn't save that name — please try again.");
        return;
      }
      const data = await res.json();
      setName(data.name);
      onSaved(data.name);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that name — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <input
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setJustSaved(false);
        }}
        aria-label="Shown name"
        style={{ ...textFieldStyle, marginTop: 10 }}
      />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {justSaved && !error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--gold)" }}>Saved.</div>}
      <button
        onClick={submit}
        disabled={submitting}
        style={{
          width: "100%",
          marginTop: 10,
          padding: 14,
          background: "var(--gold)",
          color: "var(--btn-fg)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: ".24em",
          textTransform: "uppercase",
        }}
      >
        {submitting ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function SocialLinkEditor({
  apiBaseUrl,
  initialUrl,
  onSaved,
  onUnauthorized,
}: {
  apiBaseUrl: string;
  initialUrl: string;
  onSaved: (socialUrl: string | null) => void;
  onUnauthorized: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/social`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socialUrl: url }),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Couldn't save that link — please try again.");
        return;
      }
      const data = await res.json();
      onSaved(data.socialUrl);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that link — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {/* Any social network or personal site — not restricted to Instagram. */}
      <input
        type="text"
        placeholder="https://instagram.com/yourname"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setJustSaved(false);
        }}
        aria-label="Social media link"
        style={{ ...textFieldStyle, marginTop: 10 }}
      />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {justSaved && !error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--gold)" }}>Saved.</div>}
      <button
        onClick={submit}
        disabled={submitting}
        style={{
          width: "100%",
          marginTop: 10,
          padding: 14,
          background: "var(--gold)",
          color: "var(--btn-fg)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: ".24em",
          textTransform: "uppercase",
        }}
      >
        {submitting ? "Saving…" : "Save"}
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
  // Fetched once here (not separately by HistoryTable) — the Photo section's
  // "has this bidder ever paid" gate and the rendered history table both need
  // the exact same /me/history data, and that query is a genuine N+1 on the
  // backend (one extra row read per round the bidder participated in), so
  // fetching it twice on every sidebar open was real duplicate load for no
  // benefit.
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [awaitingEmailConfirm, setAwaitingEmailConfirm] = useState(false);

  // null while unknown (still loading) — the photo uploader is gated on this
  // rather than just being signed in, since uploading a face photo with no
  // paid bid to attach it to has nothing to attach it to. A failed history
  // fetch is treated the same as "no history" for this gate; HistoryTable
  // itself still shows its own distinct error message for that case.
  const hasPaid = historyStatus === "loading" ? null : historyStatus !== "error" && historyStatus.entries.length > 0;

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
        return fetch(`${apiBaseUrl}/me/history`, { credentials: "include" })
          .then((res) => {
            if (!res.ok) throw new Error(`history request failed: ${res.status}`);
            return res.json();
          })
          .then((historyData: { history: HistoryEntry[] }) => {
            if (!cancelled) setHistoryStatus({ entries: historyData.history });
          })
          .catch(() => {
            if (!cancelled) setHistoryStatus("error");
          });
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

  function finishEmailConfirm(name: string) {
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
    setUser((current) => (current ? { ...current, name } : current));
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
              <EmailConfirmStep apiBaseUrl={apiBaseUrl} initialEmail={user.email} initialName={user.name} onDone={finishEmailConfirm} />
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

                <div style={{ flex: 1, overflowY: "auto" }}>
                  <div style={{ padding: "20px 20px 0" }}>
                    <div style={{ fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)" }}>
                      Shown name
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--fg-faint)" }}>
                      The name shown publicly if you become champion — on the seat, in the leaderboard.
                    </div>
                    <NameEditor
                      apiBaseUrl={apiBaseUrl}
                      initialName={user.name}
                      onSaved={(name) => setUser({ ...user, name })}
                      onUnauthorized={() => (window.location.href = "/")}
                    />
                  </div>

                  <div style={{ marginTop: 20, padding: "0 20px" }}>
                    <div style={{ fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)" }}>
                      Photo
                    </div>
                    {hasPaid ? (
                      <PhotoUploader
                        apiBaseUrl={apiBaseUrl}
                        userId={user.id}
                        hasPhoto={!!user.photoPath}
                        onUploaded={(photoPath) => setUser({ ...user, photoPath })}
                        onUnauthorized={() => (window.location.href = "/")}
                        initialCharacterRequest={user.characterRequest ?? ""}
                      />
                    ) : (
                      <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>
                        {hasPaid === null ? "Loading…" : "Available once you've placed a bid."}
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 20, padding: "0 20px" }}>
                    <div style={{ fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)" }}>
                      Social media link
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--fg-faint)" }}>
                      A link to any social network profile — Instagram, X, TikTok, a personal site, whatever you'd
                      like shown alongside your photo if you become champion.
                    </div>
                    <SocialLinkEditor
                      apiBaseUrl={apiBaseUrl}
                      initialUrl={user.socialUrl ?? ""}
                      onSaved={(socialUrl) => setUser({ ...user, socialUrl })}
                      onUnauthorized={() => (window.location.href = "/")}
                    />
                  </div>

                  <div style={{ marginTop: 20, fontSize: 9, letterSpacing: ".28em", textTransform: "uppercase", color: "var(--gold)", padding: "0 20px" }}>
                    History
                  </div>
                  <div style={{ padding: 20 }}>
                    <HistoryTable status={historyStatus} />
                  </div>
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
