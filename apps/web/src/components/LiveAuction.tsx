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

let stripePromise: Promise<StripeClient | null> | null = null;
function getStripe(): Promise<StripeClient | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(import.meta.env.STRIPE_PUBLISHABLE_KEY ?? "");
  }
  return stripePromise;
}

function JoinPaymentForm({ apiBaseUrl, roundId, onJoined }: { apiBaseUrl: string; roundId: string; onJoined: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    // The deposit is confirmed on the client, but joinRound runs from the
    // webhook, which can land a moment after this — poll /rounds/:id/me until
    // it reflects the join rather than assuming it's instant.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${apiBaseUrl}/rounds/${roundId}/me`, { credentials: "include" });
      const data = await res.json();
      if (data.joined) {
        onJoined();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    setError("Payment succeeded, but joining is taking longer than expected — refresh in a moment.");
    setSubmitting(false);
  }

  return (
    <div style={{ marginTop: 18 }}>
      <PaymentElement />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      <button onClick={handleConfirm} disabled={submitting} style={primaryButtonStyle}>
        {submitting ? "Confirming…" : "Confirm payment"}
      </button>
    </div>
  );
}

export default function LiveAuction({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [joined, setJoined] = useState<boolean | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const roundIdRef = useRef<string | null>(null);

  async function poll() {
    const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
    const data: CurrentRoundInfo = await res.json();
    setRound(data);

    if (data && data.roundId !== roundIdRef.current) {
      roundIdRef.current = data.roundId;
      const meRes = await fetch(`${apiBaseUrl}/rounds/${data.roundId}/me`, { credentials: "include" });
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

  async function startJoin() {
    if (!round) return;
    const res = await fetch(`${apiBaseUrl}/rounds/${round.roundId}/join`, { method: "POST", credentials: "include" });
    const data = await res.json();
    setClientSecret(data.clientSecret);
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
          <button onClick={startJoin} style={primaryButtonStyle}>
            Join
          </button>
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
      <div style={{ marginTop: 18 }}>
        <label htmlFor="live-auction-bid" style={fieldLabelStyle}>
          Your bid, $
        </label>
        <input id="live-auction-bid" type="text" style={{ display: "block", width: "100%", marginTop: 8, padding: "12px 14px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }} />
      </div>
      <button style={primaryButtonStyle}>Place bid</button>
    </div>
  );
}
