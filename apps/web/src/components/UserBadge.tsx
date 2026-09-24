import { useEffect, useRef, useState } from "react";

type SessionUser = { id: string; email: string; name: string };

const POLL_INTERVAL_MS = 5_000;

const badgeStyle: React.CSSProperties = {
  position: "fixed",
  top: 22,
  left: 24,
  zIndex: 20,
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
  textDecoration: "none",
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

/**
 * A small, always-mounted (`client:load`) badge on the otherwise fully
 * static homepage — the one deliberate exception to "no live widgets on
 * index.astro". Renders nothing at all when signed out, so the static page
 * is visually unchanged for the vast majority of visitors. Signed in, it
 * shows an initial-letter avatar linking to /account, with a shaking red dot
 * when this user has joined the current round but isn't the one currently
 * leading it — the same `isLeading` field LiveAuction.tsx uses, so the two
 * surfaces can never disagree about what "needs your attention" means.
 */
export default function UserBadge({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [notify, setNotify] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function poll() {
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

  if (!user) return null;

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <a
      href="/account"
      style={{ ...badgeStyle, animation: notify ? "badge-shake 3s ease-in-out infinite" : undefined }}
      aria-label={notify ? `${user.name || "Account"} — action needed` : user.name || "Account"}
    >
      {initial || "•"}
      {notify && <span style={dotStyle} aria-hidden="true" />}
    </a>
  );
}
