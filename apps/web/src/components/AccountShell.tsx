import { useEffect, useState } from "react";

type SessionUser = { id: string; email: string; name: string };
type Status = "checking" | "signed-in" | "redirecting";

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "18px 24px",
  borderBottom: "1px solid var(--line)",
};

const navStyle: React.CSSProperties = {
  display: "flex",
  gap: 18,
  fontSize: 12,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

const chromeButtonStyle: React.CSSProperties = {
  padding: "8px 13px",
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420, padding: "28px 26px", border: "1px solid var(--line)", background: "var(--panel-2)" }}>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28 }}>One more thing</div>
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
    </div>
  );
}

export default function AccountShell({
  apiBaseUrl,
  children,
}: {
  apiBaseUrl: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<Status>("checking");
  const [user, setUser] = useState<SessionUser | null>(null);
  // Only true right after the very first sign-in (the OAuth callback's
  // ?welcome=1 flag, see authGoogle.ts/authApple.ts) — never on a later,
  // ordinary visit.
  const [awaitingEmailConfirm, setAwaitingEmailConfirm] = useState(false);

  useEffect(() => {
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) {
          setStatus("redirecting");
          window.location.href = "/";
          return;
        }
        return res.json();
      })
      .then((data?: SessionUser) => {
        if (!data) return;
        setUser(data);
        if (new URLSearchParams(window.location.search).get("welcome") === "1") {
          setAwaitingEmailConfirm(true);
        }
        setStatus("signed-in");
      })
      .catch(() => {
        setStatus("redirecting");
        window.location.href = "/";
      });
  }, [apiBaseUrl]);

  function signOut() {
    fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => {
      window.location.href = "/";
    });
  }

  if (status !== "signed-in") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)" }}>
        Checking session…
      </div>
    );
  }

  if (awaitingEmailConfirm && user) {
    return (
      <EmailConfirmStep
        apiBaseUrl={apiBaseUrl}
        initialEmail={user.email}
        onDone={() => {
          // Clears ?welcome=1 so a later refresh of this exact URL doesn't
          // show the step again. Built from the parts rather than
          // `new URL(window.location.href)`, which throws on the relative
          // stub `window.location` used in tests.
          const params = new URLSearchParams(window.location.search);
          params.delete("welcome");
          const query = params.toString();
          const newPath = (window.location.pathname || "") + (query ? `?${query}` : "");
          window.history.replaceState(null, "", newPath || "/");
          setAwaitingEmailConfirm(false);
        }}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--void)", color: "var(--fg)" }}>
      <div style={headerStyle}>
        <a href="/" style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, color: "var(--fg)" }}>
          oneabobeall
        </a>
        <div style={navStyle}>
          <a href="/account/auction">Auction</a>
          <a href="/account/leaderboard">Leaderboard</a>
        </div>
        <button onClick={signOut} style={chromeButtonStyle}>
          Sign out
        </button>
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  );
}
