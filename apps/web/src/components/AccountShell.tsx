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

export default function AccountShell({
  apiBaseUrl,
  children,
}: {
  apiBaseUrl: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) {
          setStatus("redirecting");
          window.location.href = "/";
          return;
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

  return (
    <div style={{ minHeight: "100vh", background: "var(--void)", color: "var(--fg)" }}>
      <div style={headerStyle}>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20 }}>oneabobeall</div>
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
