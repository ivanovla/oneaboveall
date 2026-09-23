import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeClient } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatMoney } from "../lib/format";

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: string;
} | null;

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
 * Normalises what a user typed into a whole-dollar amount by keeping only the
 * LEADING run of digits and truncating at the first non-digit.
 *
 * Whole-dollar bidding is this site's existing convention (`AuctionFlow.tsx`
 * filters the same way) and isn't in question here — cents are never accepted.
 * What matters is what a user who types "15.50" by mistake is left with.
 * Stripping every non-digit anywhere in the string concatenated across the
 * decimal point and produced "1550", silently turning an intended $15.50 into
 * a $1,550 bid. Truncating produces "15" instead: still not what they meant,
 * but visibly so — the field shows exactly the number that will be submitted,
 * rather than one a hundred times larger.
 */
function toWholeDollarDigits(raw: string): string {
  return raw.replace(/\D[\s\S]*$/, "");
}

function BidForm({ apiBaseUrl, currentLeaderCents }: { apiBaseUrl: string; currentLeaderCents: number }) {
  const [bidValue, setBidValue] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "placed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submitBid() {
    // Already enforced by the input's onChange; re-applied here so the
    // submitted amount can never disagree with what the field displays.
    const digits = toWholeDollarDigits(bidValue);
    const amountCents = digits === "" ? 0 : Number(digits) * 100;
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
          onChange={(e) => setBidValue(toWholeDollarDigits(e.target.value))}
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
      const meData = await meRes.json();
      setJoined(!!meData.joined);
    } else if (!data) {
      roundIdRef.current = null;
      setJoined(null);
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
          <Elements stripe={getStripe()} options={{ clientSecret }}>
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
      <div style={fieldLabelStyle}>Current leader</div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
        {formatMoney(round.currentLeaderCents)}
      </div>
      <BidForm apiBaseUrl={apiBaseUrl} currentLeaderCents={round.currentLeaderCents} />
    </div>
  );
}
