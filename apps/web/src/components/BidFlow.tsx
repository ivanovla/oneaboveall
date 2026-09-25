import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatMoney } from "../lib/format";
import { getStripe, stripeAppearance } from "../lib/stripe";
import { toBidInputValue, toWholeDollarCents } from "../lib/bidInput";

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
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
 * Mounted once a join PaymentIntent's `clientSecret` is in hand — confirms
 * the deposit, then polls `/rounds/:id/me` until the webhook-driven join
 * lands (it can arrive a moment after the client-side confirmation), then
 * hands control back to `onPaid` to submit the bid amount that triggered
 * the join in the first place.
 */
function PaymentStep({ apiBaseUrl, roundId, onPaid }: { apiBaseUrl: string; roundId: string; onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pollJoinStatus() {
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
        if (data.joined) {
          onPaid();
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
 * The unified Displace flow: type a bid, pay if this is the first bid this
 * round (join + deposit), or submit it as a free re-bid if already joined,
 * then a required photo and an optional Instagram link. One step at a time,
 * in the same overlay Displace already opens — no separate "join" step
 * shown to the visitor, even though the two API calls underneath are
 * unchanged (POST /rounds/:id/join, POST /bids).
 */
export default function BidFlow({ apiBaseUrl, onDone }: { apiBaseUrl: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>("amount");
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [alreadyJoined, setAlreadyJoined] = useState<boolean | null>(null);
  const [bidValue, setBidValue] = useState("");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [instagramUrl, setInstagramUrl] = useState("");
  const [socialError, setSocialError] = useState<string | null>(null);

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
      setAlreadyJoined(!!meData.joined);
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

  async function submitBidAmount(amountCents: number) {
    const res = await fetch(`${apiBaseUrl}/bids`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents }),
    });
    if (res.status === 401) {
      redirectToSignedOut();
      return false;
    }
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Bid was rejected.");
      return false;
    }
    return true;
  }

  async function handleSubmitAmount() {
    if (round === "loading" || !round || alreadyJoined === null) return;
    const amountCents = toWholeDollarCents(bidValue);
    if (amountCents <= round.currentLeaderCents) {
      setError(`Your bid must be higher than ${formatMoney(round.currentLeaderCents)}.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (alreadyJoined) {
        const ok = await submitBidAmount(amountCents);
        if (ok) setStep("photo");
        return;
      }

      const res = await fetch(`${apiBaseUrl}/rounds/${round.roundId}/join`, { method: "POST", credentials: "include" });
      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Couldn't start the deposit — please try again.");
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

  async function handlePaid() {
    if (round === "loading" || !round) return;
    const amountCents = toWholeDollarCents(bidValue);
    const ok = await submitBidAmount(amountCents);
    if (ok) setStep("photo");
  }

  async function uploadPhoto() {
    if (!photoFile) {
      setPhotoError("Choose a photo first.");
      return;
    }
    setSubmitting(true);
    setPhotoError(null);
    try {
      const form = new FormData();
      form.append("photo", photoFile);
      // No content-type header set deliberately — the browser fills in
      // multipart/form-data with the correct boundary itself; setting it
      // by hand would drop that boundary and break the upload.
      const res = await fetch(`${apiBaseUrl}/auth/photo`, { method: "POST", credentials: "include", body: form });
      if (res.status === 401) {
        redirectToSignedOut();
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setPhotoError(data.error ?? "Couldn't upload that photo — please try again.");
        return;
      }
      setStep("social");
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Couldn't upload that photo — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveSocial() {
    setSubmitting(true);
    setSocialError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/social`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instagramUrl }),
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

  // Only reachable once `round` is a real round — `alreadyJoined` is never
  // set when there's no round to check participation against (the effect
  // returns right after `setRound(null)`), so gating on it *before* the
  // `!round` check above would leave this stuck on "Loading…" forever
  // whenever there's genuinely no active round.
  if (alreadyJoined === null) {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
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
        {!alreadyJoined && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--fg-faint)" }}>
            A deposit of {formatMoney(round.depositCents)} is charged now to enter this round.
          </div>
        )}
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
        <div style={fieldLabelStyle}>Deposit required to enter</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, marginTop: 6 }}>
          {formatMoney(round.depositCents)}
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
          Front-facing photo, full face, no glasses or headwear.
        </div>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Photo"
          onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
          style={{ display: "block", width: "100%", marginTop: 16, fontSize: 12, color: "var(--fg-dim)" }}
        />
        {photoError && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{photoError}</div>}
        <button onClick={uploadPhoto} disabled={submitting} style={primaryButtonStyle}>
          {submitting ? "Uploading…" : "Upload photo"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24 }}>Attach social media</div>
      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>Optional.</div>
      <label htmlFor="bid-flow-instagram" style={{ ...fieldLabelStyle, display: "block", marginTop: 20 }}>
        Instagram URL
      </label>
      <input
        id="bid-flow-instagram"
        type="text"
        placeholder="https://instagram.com/yourname"
        value={instagramUrl}
        onChange={(e) => setInstagramUrl(e.target.value)}
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
