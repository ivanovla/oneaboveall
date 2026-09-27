import { useEffect, useState } from "react";
import { chromeButtonStyle } from "./chromeStyles";

// Never shown below this, even fresh off a brand-new database — a "0 views"
// counter reads as an empty site, which defeats the point of showing one at
// all. Once the real count overtakes it, the real count is what's shown.
const MIN_DISPLAYED_VIEWS = 211;

/**
 * Fixed top-left counter of how many times the homepage has been loaded.
 * POSTs to /page-views once per mount (i.e. once per real page view — this
 * never runs at build time, since apps/web is static output) and displays
 * whatever count comes back, floored at MIN_DISPLAYED_VIEWS.
 *
 * Deliberately its own component/island rather than folded into
 * AuctionFlow.tsx: it has no session, auth, or bidding state to share with
 * that component, so giving it one keeps AuctionFlow from growing a concern
 * that isn't its own.
 */
export default function ViewCounter({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/page-views`, { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && typeof data?.count === "number") setCount(data.count);
      })
      .catch(() => {
        // No fallback needed — the floor below already covers a failed
        // fetch the same way it covers a fresh, empty counter.
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  const displayed = Math.max(count ?? 0, MIN_DISPLAYED_VIEWS);

  return (
    <div
      style={{
        position: "fixed",
        top: 22,
        left: 24,
        zIndex: 20,
      }}
    >
      <div style={chromeButtonStyle} role="status" aria-label="Page views">
        {displayed.toLocaleString()} views
      </div>
    </div>
  );
}
