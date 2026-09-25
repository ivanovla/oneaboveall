import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeClient, type Appearance } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatMoney } from "../lib/format";

// Mirrors tokens.css's dark-theme palette (the account pages don't expose
// the homepage's light/dark toggle, so they always render dark). Stripe's
// Appearance API needs literal color values, not CSS custom properties, so
// these are copied rather than read from the stylesheet — keep them in sync
// with tokens.css's `:root` block by hand if that palette ever changes.
const stripeAppearance: Appearance = {
  theme: "night",
  variables: {
    colorPrimary: "#c9a45c", // --gold
    colorBackground: "#15110a", // opaque stand-in for --panel-2 over --void
    colorText: "#f0e7d6", // --fg
    colorTextSecondary: "rgba(240, 231, 214, .56)", // --fg-dim
    colorTextPlaceholder: "rgba(240, 231, 214, .3)", // --fg-faint
    colorDanger: "#e0483e",
    fontFamily: "Manrope, Helvetica, Arial, sans-serif",
    fontSizeBase: "14px",
    borderRadius: "0px", // this design never rounds a corner
    spacingUnit: "4px",
  },
  rules: {
    ".Label": {
      fontSize: "9px",
      letterSpacing: ".16em",
      textTransform: "uppercase",
      color: "rgba(240, 231, 214, .3)",
    },
    ".Input": {
      border: "1px solid rgba(201, 164, 92, .34)", // --gold-soft
      boxShadow: "none",
    },
    ".Input:focus": {
      border: "1px solid #c9a45c",
      boxShadow: "none",
    },
    ".Tab": {
      border: "1px solid rgba(201, 164, 92, .22)", // --line
      boxShadow: "none",
    },
    ".Tab:hover": {
      border: "1px solid rgba(201, 164, 92, .34)",
    },
    ".Tab--selected": {
      border: "1px solid #c9a45c",
      boxShadow: "none",
    },
  },
};

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: string;
} | null;

// The fields beyond `joined` are only present once joined === true, and even
// then only when the caller actually asked for them (the mocked-out `{joined:
// true}` shape used by several tests omits them) — every read of them must
// tolerate `undefined`.
type Participation = {
  joined: boolean;
  depositCents?: number;
  isLeading?: boolean;
};

const POLL_INTERVAL_MS = 5_000;

const boxStyle: React.CSSProperties = {
  padding: "20px 22px",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  maxWidth: 420,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 18,
  padding: 16,
  background: "var(--gold)",
  color: "var(--btn-fg)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".28em",
  textTransform: "uppercase",
};

/**
 * A session can be revoked at any point *after* this component mounted — a
 * sign-out in another tab, or the session simply expiring while the auction
 * page sat open. `AccountShell.tsx` only checks `/auth/me` once, on mount, so
 * nothing else notices. Every endpoint this component talks to is
 * session-gated, so a 401 from any of them is that signal.
 *
 * Without this, a 401 from `/rounds/:id/me` parses as `{}`, `meData.joined`
 * reads `undefined`, and the now-signed-out user is shown the "Join" card —
 * which then dead-ends the moment they click it.
 *
 * Redirects to the same place, the same way, as `AccountShell.tsx`'s own 401
 * branch, so a revoked session always lands in one predictable spot.
 */
function redirectToSignedOut(): void {
  window.location.href = "/";
}

let stripePromise: Promise<StripeClient | null> | null = null;
function getStripe(): Promise<StripeClient | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(import.meta.env.PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");
  }
  return stripePromise;
}

function JoinPaymentForm({ apiBaseUrl, roundId, onJoined }: { apiBaseUrl: string; roundId: string; onJoined: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pollJoinStatus() {
    setSubmitting(true);
    setError(null);

    // This loop runs immediately after the user's card was charged, so a
    // fetch rejecting here (a network blip, the tab losing connectivity) is
    // the worst possible moment to get stuck: without the catch below, the
    // rejection escaped uncaught, `submitting` never went back to false, and
    // the "Check status" button stayed disabled forever with a completed
    // payment and no joined round. Same try/catch shape as `submitBid` and
    // `startJoin`.
    try {
      // Poll /rounds/:id/me until it reflects the join, the webhook-driven
      // join can land a moment after the client-side confirmation.
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${apiBaseUrl}/rounds/${roundId}/me`, { credentials: "include" });
        if (res.status === 401) {
          redirectToSignedOut();
          return;
        }
        const data = await res.json();
        if (data.joined) {
          onJoined();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setError("Checking status is taking longer than expected — try again in a moment.");
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't check your join status (${err.message}) — your payment went through; try again in a moment.`
          : "Couldn't check your join status — your payment went through; try again in a moment.",
      );
    }
    // Deliberately here rather than in a `finally`: both `return`s above are
    // success/redirect paths that hand the screen off to something else, and
    // re-enabling the button on those would just flash a stale control on a
    // component that is about to be replaced. Every path that leaves the user
    // on this form falls through to here and re-enables "Check status".
    setSubmitting(false);
  }

  async function handleConfirm() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed.");
      setSubmitting(false);
      return;
    }

    // Payment succeeded on the client side, now poll for webhook-driven join
    setPaymentConfirmed(true);
    await pollJoinStatus();
  }

  return (
    <div style={{ marginTop: 18 }}>
      <PaymentElement />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {paymentConfirmed ? (
        <button onClick={pollJoinStatus} disabled={submitting} style={primaryButtonStyle}>
          {submitting ? "Checking status…" : "Check status"}
        </button>
      ) : (
        <button onClick={handleConfirm} disabled={submitting} style={primaryButtonStyle}>
          {submitting ? "Confirming…" : "Confirm payment"}
        </button>
      )}
    </div>
  );
}

/**
 * What the bid field is allowed to display as the user types: digits plus at
 * most one decimal point.
 *
 * The decimal point is deliberately NOT stripped here. This input is a
 * controlled component (`value={bidValue}`), so every keystroke's onChange
 * sees the *previous accepted value* with one character inserted — not the
 * user's full intent. Any rule that drops the "." therefore drops it again on
 * every subsequent keystroke, and the digits after it simply append to the
 * digits before it. Typing "15.50" one character at a time under a
 * strip-the-dot rule goes "1" -> "15" -> "15" -> "155" -> "1550", which is
 * the original 100x bug, reproduced keystroke by keystroke. A single
 * whole-string change event hides this completely, which is why the earlier
 * truncate-at-first-non-digit attempt looked fixed and was not.
 *
 * So the field simply shows what was typed, and the whole-dollar rounding
 * happens once, at submit time, in `toWholeDollarCents` below.
 */
function toBidInputValue(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  // Keep the first ".", drop any later ones, so "1.5.5" can't reach parseFloat.
  return `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, "")}`;
}

/**
 * Converts the displayed field value to the whole-dollar amount in cents that
 * actually gets bid.
 *
 * Whole-dollar bidding is this site's existing convention (`AuctionFlow.tsx`
 * works the same way) and isn't in question — cents are never accepted. What
 * changed is how a typed decimal collapses to one: flooring "15.50" gives
 * $15, the honest reading of what the user typed and visibly what the field
 * shows, instead of the $1,550 that digit-concatenation produced.
 *
 * An empty field, a lone ".", or anything else parseFloat can't read yields
 * 0 — the same guard the previous `digits === "" ? 0 : ...` provided, so an
 * empty bid still reaches the server and gets its normal validation error.
 */
function toWholeDollarCents(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) * 100 : 0;
}

function BidForm({ apiBaseUrl, currentLeaderCents }: { apiBaseUrl: string; currentLeaderCents: number }) {
  const [bidValue, setBidValue] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "placed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submitBid() {
    // The one place whole-dollar rounding happens — deliberately at submit,
    // not in onChange, so the field can keep showing exactly what was typed.
    const amountCents = toWholeDollarCents(bidValue);
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch(`${apiBaseUrl}/bids`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });

      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Bid was rejected.");
        setStatus("idle");
        return;
      }

      setStatus("placed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place bid — please try again.");
      setStatus("idle");
    }
  }

  return (
    <>
      <div style={{ marginTop: 18 }}>
        <label htmlFor="live-auction-bid" style={fieldLabelStyle}>
          Your bid, $
        </label>
        <input
          id="live-auction-bid"
          type="text"
          value={bidValue}
          onChange={(e) => setBidValue(toBidInputValue(e.target.value))}
          style={{ display: "block", width: "100%", marginTop: 8, padding: "12px 14px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }}
        />
      </div>
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {status === "placed" && <div style={{ marginTop: 10, fontSize: 12, color: "var(--gold)" }}>Bid placed — you can raise it again any time.</div>}
      <button onClick={submitBid} disabled={status === "submitting"} style={primaryButtonStyle}>
        {status === "submitting" ? "Placing…" : "Place bid"}
      </button>
    </>
  );
}

export default function LiveAuction({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [joined, setJoined] = useState<boolean | null>(null);
  const [myDepositCents, setMyDepositCents] = useState<number | null>(null);
  const [isLeading, setIsLeading] = useState<boolean | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [joiningInFlight, setJoiningInFlight] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const roundIdRef = useRef<string | null>(null);

  async function poll() {
    const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
    if (res.status === 401) {
      redirectToSignedOut();
      return;
    }
    const data: CurrentRoundInfo = await res.json();
    setRound(data);

    if (data && data.roundId !== roundIdRef.current) {
      roundIdRef.current = data.roundId;
      const meRes = await fetch(`${apiBaseUrl}/rounds/${data.roundId}/me`, { credentials: "include" });
      // A 401 here means the session was revoked or expired after this page
      // loaded. Reading on would give `meData.joined === undefined`, i.e.
      // `setJoined(false)`, showing the Join card to a signed-out user.
      if (meRes.status === 401) {
        redirectToSignedOut();
        return;
      }
      const meData: Participation = await meRes.json();
      setJoined(!!meData.joined);
      setMyDepositCents(typeof meData.depositCents === "number" ? meData.depositCents : null);
      setIsLeading(typeof meData.isLeading === "boolean" ? meData.isLeading : null);
    } else if (!data) {
      roundIdRef.current = null;
      setJoined(null);
      setMyDepositCents(null);
      setIsLeading(null);
    }
  }

  useEffect(() => {
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
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl]);

  async function startJoin(roundId: string) {
    setJoiningInFlight(true);
    setJoinError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/rounds/${roundId}/join`, { method: "POST", credentials: "include" });

      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }

      // Every non-2xx from this endpoint returns `{ error: "..." }` and no
      // clientSecret: a banned bidder (403), a round that closed while this
      // page sat open (409), an already-joined bidder (409). Reading
      // `data.clientSecret` off those bodies set it to `undefined`, so the
      // Join button simply re-rendered with nothing shown and no reason
      // given. Same `!res.ok` -> `data.error` shape `submitBid` uses.
      if (!res.ok) {
        const data = await res.json();
        setJoinError(data.error ?? "Couldn't start the join — please try again.");
        return;
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Failed to start join process — please try again.");
    } finally {
      setJoiningInFlight(false);
    }
  }

  if (round === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!round) {
    return <div style={{ color: "var(--fg-dim)" }}>No active round right now.</div>;
  }

  if (joined === null) {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!joined) {
    return (
      <div style={boxStyle}>
        <div style={fieldLabelStyle}>Deposit required to enter</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, marginTop: 6 }}>
          {formatMoney(round.depositCents)}
        </div>
        {clientSecret ? (
          <Elements stripe={getStripe()} options={{ clientSecret, appearance: stripeAppearance }}>
            <JoinPaymentForm apiBaseUrl={apiBaseUrl} roundId={round.roundId} onJoined={() => setJoined(true)} />
          </Elements>
        ) : (
          <>
            <button onClick={() => startJoin(round.roundId)} disabled={joiningInFlight} style={primaryButtonStyle}>
              {joiningInFlight ? "Starting…" : "Join"}
            </button>
            {joinError && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{joinError}</div>}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={boxStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={fieldLabelStyle}>Current leader</div>
          <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
            {formatMoney(round.currentLeaderCents)}
          </div>
        </div>
        {myDepositCents !== null && (
          <div style={{ textAlign: "right" }}>
            <div style={fieldLabelStyle}>Your deposit held</div>
            <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
              {formatMoney(myDepositCents)}
            </div>
          </div>
        )}
      </div>
      {isLeading !== null && (
        <div style={{ marginTop: 10, fontSize: 12, color: isLeading ? "var(--gold)" : "var(--fg-dim)" }}>
          {isLeading ? "You're currently leading." : "You're not the current leader."}
        </div>
      )}
      <BidForm apiBaseUrl={apiBaseUrl} currentLeaderCents={round.currentLeaderCents} />
    </div>
  );
}
