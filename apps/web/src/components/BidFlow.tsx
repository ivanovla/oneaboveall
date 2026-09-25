import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatMoney } from "../lib/format";
import { getStripe, stripeAppearance } from "../lib/stripe";
import { toBidInputValue, toWholeDollarCents } from "../lib/bidInput";
import PhotoUploader from "./PhotoUploader";

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "closed";
  currentLeaderCents: number;
  biddingClosesAt: string;
} | null;

type Step = "amount" | "payment" | "photo" | "social";

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

const secondaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 10,
  padding: 14,
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  fontSize: 11,
  letterSpacing: ".2em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 8,
  padding: "16px 18px",
  background: "transparent",
  border: "1px solid var(--gold-soft)",
  color: "var(--fg)",
  fontFamily: "'Cormorant Garamond', Georgia, serif",
  fontSize: 28,
  outline: "none",
};

function redirectToSignedOut(): void {
  window.location.href = "/";
}

/**
 * Mounted once a bid PaymentIntent's `clientSecret` is in hand — confirms
 * the charge, then polls `/rounds/:id/me` until the webhook-driven bid lands
 * (it can arrive a moment after the client-side confirmation) and this
 * bidder shows up as the round's leader.
 */
function PaymentStep({ apiBaseUrl, roundId, onPaid }: { apiBaseUrl: string; roundId: string; onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pollBidStatus() {
    setSubmitting(true);
    setError(null);
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${apiBaseUrl}/rounds/${roundId}/me`, { credentials: "include" });
        if (res.status === 401) {
          redirectToSignedOut();
          return;
        }
        const data = await res.json();
        if (data.isLeading) {
          onPaid();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setError("Checking status is taking longer than expected — try again in a moment.");
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't check your bid status (${err.message}) — your payment went through; try again in a moment.`
          : "Couldn't check your bid status — your payment went through; try again in a moment.",
      );
    }
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

    setPaymentConfirmed(true);
    await pollBidStatus();
  }

  return (
    <div style={{ marginTop: 18 }}>
      <PaymentElement />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {paymentConfirmed ? (
        <button onClick={pollBidStatus} disabled={submitting} style={primaryButtonStyle}>
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
 * The unified Displace flow: type a bid, pay the full amount immediately,
 * then a required photo and an optional Instagram link. One step at a time,
 * in the same overlay Displace already opens.
 *
 * There is no separate "join" step and no deposit — every bid is a real,
 * full-amount charge the instant it's placed. If it's later outbid, the
 * whole amount is refunded automatically. A bidder who is already the
 * round's leader cannot raise their own bid (they have to be outbid by
 * someone else first) — `isLeading` gates the amount step for that case.
 */
export default function BidFlow({ apiBaseUrl, onDone }: { apiBaseUrl: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>("amount");
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [isLeading, setIsLeading] = useState<boolean | null>(null);
  const [bidValue, setBidValue] = useState("");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<{ id: string; photoPath: string | null; characterRequest: string | null } | null>(
    null,
  );
  const [socialUrl, setSocialUrl] = useState("");
  const [socialError, setSocialError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { id: string; photoPath: string | null; characterRequest: string | null } | null) => {
        if (!cancelled && data) setSessionUser({ id: data.id, photoPath: data.photoPath, characterRequest: data.characterRequest });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
      if (cancelled) return;
      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }
      const data: CurrentRoundInfo = await res.json();
      if (cancelled) return;
      setRound(data);
      if (!data) return;

      const meRes = await fetch(`${apiBaseUrl}/rounds/${data.roundId}/me`, { credentials: "include" });
      if (cancelled) return;
      if (meRes.status === 401) {
        redirectToSignedOut();
        return;
      }
      const meData = await meRes.json();
      if (cancelled) return;
      setIsLeading(!!meData.isLeading);
      // A pre-filled minimum (current price + $1) saves a first-time bidder
      // a trip to figure out what "you must beat this" even means in
      // dollars, matching AuctionFlow's original prefill behavior.
      if (data) setBidValue(String(Math.round(data.currentLeaderCents / 100) + 1));
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  async function handleSubmitAmount() {
    if (round === "loading" || !round) return;
    const amountCents = toWholeDollarCents(bidValue);
    if (amountCents <= round.currentLeaderCents) {
      setError(`Your bid must be higher than ${formatMoney(round.currentLeaderCents)}.`);
      return;
    }

    setSubmitting(true);
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
        setError(data.error ?? "Couldn't start the payment — please try again.");
        return;
      }
      const data = await res.json();
      setClientSecret(data.clientSecret);
      setStep("payment");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handlePaid() {
    setStep("photo");
  }

  async function saveSocial() {
    setSubmitting(true);
    setSocialError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/social`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socialUrl }),
      });
      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setSocialError(data.error ?? "Couldn't save that link — please try again.");
        return;
      }
      onDone();
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : "Couldn't save that link — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (round === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!round) {
    return <div style={{ color: "var(--fg-dim)" }}>No active round right now.</div>;
  }

  // Only reachable once `round` is a real round — `isLeading` is never set
  // when there's no round to check against (the effect returns right after
  // `setRound(null)`), so gating on it *before* the `!round` check above
  // would leave this stuck on "Loading…" forever whenever there's genuinely
  // no active round.
  if (isLeading === null) {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (isLeading && step === "amount") {
    return (
      <div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>You're already leading</div>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
          Your bid of {formatMoney(round.currentLeaderCents)} is the current top bid. You can raise it again once
          someone else outbids you. If nobody does before this round closes, the seat is yours.
        </div>
      </div>
    );
  }

  if (step === "amount") {
    return (
      <div>
        <div style={fieldLabelStyle}>Must beat</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
          {formatMoney(round.currentLeaderCents)}
        </div>
        <label htmlFor="bid-flow-amount" style={{ ...fieldLabelStyle, display: "block", marginTop: 20 }}>
          Your bid, $
        </label>
        <input
          id="bid-flow-amount"
          type="text"
          value={bidValue}
          onChange={(e) => setBidValue(toBidInputValue(e.target.value))}
          style={inputStyle}
        />
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--fg-faint)" }}>
          Charged in full now. Refunded in full if someone outbids you.
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
        <button onClick={handleSubmitAmount} disabled={submitting} style={primaryButtonStyle}>
          {submitting ? "Please wait…" : "Displace"}
        </button>
      </div>
    );
  }

  if (step === "payment") {
    if (!clientSecret) return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
    return (
      <div>
        <div style={fieldLabelStyle}>Your bid</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, marginTop: 6 }}>
          {formatMoney(toWholeDollarCents(bidValue))}
        </div>
        <Elements stripe={getStripe()} options={{ clientSecret, appearance: stripeAppearance }}>
          <PaymentStep apiBaseUrl={apiBaseUrl} roundId={round.roundId} onPaid={handlePaid} />
        </Elements>
      </div>
    );
  }

  if (step === "photo") {
    return (
      <div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>Send your face</div>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
          You can change this anytime from your account settings.
        </div>
        {sessionUser ? (
          <PhotoUploader
            apiBaseUrl={apiBaseUrl}
            userId={sessionUser.id}
            hasPhoto={!!sessionUser.photoPath}
            submitLabel="Upload photo"
            onUploaded={() => setStep("social")}
            onUnauthorized={redirectToSignedOut}
            initialCharacterRequest={sessionUser.characterRequest ?? ""}
          />
        ) : (
          <div style={{ marginTop: 16, color: "var(--fg-dim)" }}>Loading…</div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>Attach social media</div>
      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>Optional.</div>
      <label htmlFor="bid-flow-social" style={{ ...fieldLabelStyle, display: "block", marginTop: 20 }}>
        Social media link
      </label>
      {/* Any social network or personal site — not restricted to Instagram. */}
      <input
        id="bid-flow-social"
        type="text"
        placeholder="https://instagram.com/yourname"
        value={socialUrl}
        onChange={(e) => setSocialUrl(e.target.value)}
        style={{ ...inputStyle, fontFamily: "inherit", fontSize: 14 }}
      />
      {socialError && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{socialError}</div>}
      <button onClick={saveSocial} disabled={submitting} style={primaryButtonStyle}>
        {submitting ? "Saving…" : "Save"}
      </button>
      <button onClick={onDone} style={secondaryButtonStyle}>
        Skip
      </button>
    </div>
  );
}
