import { useEffect, useState } from "react";
import { formatMoney, formatCountdown, calculateDepositDisplay } from "../lib/format";
import { mockCurrentPriceCents, mockBiddingWindowClosesAt } from "../lib/mockData";

// A one-dollar step above the current price, used only to render the "Minimum"
// figure on the bid screen. Purely cosmetic — there is no server-side minimum
// bid concept in the mock data this task consumes.
const MIN_BID_INCREMENT_CENTS = 100;

type Screen =
  | "closed"
  | "auth"
  | "bid"
  | "lead"
  | "pay"
  | "upload"
  | "pending"
  | "missed"
  | "top";

type PaymentProvider = "ru" | "intl";

function useCountdown(closesAt: Date): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return formatCountdown(closesAt.getTime() - now);
}

const overlayShellStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "var(--scrim)",
  backdropFilter: "blur(18px)",
  overflow: "auto",
};

const overlayPanelStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 472,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  boxShadow: "0 40px 120px rgba(0,0,0,.6)",
};

const overlayHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 20px",
  borderBottom: "1px solid var(--line)",
};

const overlayBodyStyle: React.CSSProperties = {
  padding: "28px 26px 30px",
};

const headingStyle: React.CSSProperties = {
  fontFamily: "'Cormorant Garamond', Georgia, serif",
  fontSize: 34,
  lineHeight: 1.08,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const boxStyle: React.CSSProperties = {
  flex: 1,
  padding: "15px 16px",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 24,
  padding: 18,
  background: "var(--gold)",
  color: "var(--btn-fg)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".34em",
  textTransform: "uppercase",
};

function OverlayShell({
  stepLabel,
  onClose,
  children,
}: {
  stepLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={overlayShellStyle}>
      <div style={overlayPanelStyle}>
        <div style={overlayHeaderStyle}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            {stepLabel}
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 11,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: "var(--fg-faint)",
            }}
          >
            Close
          </button>
        </div>
        <div style={overlayBodyStyle}>{children}</div>
      </div>
    </div>
  );
}

export default function AuctionFlow() {
  const [screen, setScreen] = useState<Screen>("closed");
  const [bidValue, setBidValue] = useState("");
  const [paymentProvider, setPaymentProvider] = useState<PaymentProvider>("ru");

  const clock = useCountdown(mockBiddingWindowClosesAt);

  const priceLabel = formatMoney(mockCurrentPriceCents);
  const minBidLabel = formatMoney(mockCurrentPriceCents + MIN_BID_INCREMENT_CENTS);

  // The bid input holds a whole-dollar figure exactly as the user typed it
  // (matching the prototype's `s.bid` convention). It is converted to cents
  // exactly once, here, and every downstream computation works in cents.
  const bidCents = Number(bidValue) * 100;
  const depositCents = calculateDepositDisplay(bidCents);

  function closeOverlay() {
    setScreen("closed");
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          color: "var(--on-scene)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".32em",
              textTransform: "uppercase",
              color: "var(--on-scene-faint)",
            }}
          >
            Current price of the seat
          </div>
          <div
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: "clamp(46px, 7vw, 88px)",
              lineHeight: 0.92,
              letterSpacing: "-.02em",
            }}
          >
            {priceLabel}
          </div>
        </div>
        <button
          onClick={() => setScreen("auth")}
          style={{
            padding: "19px 58px",
            background: "var(--gold)",
            color: "var(--btn-fg)",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: ".42em",
            textTransform: "uppercase",
            boxShadow: "0 18px 48px rgba(201,164,92,.22)",
          }}
        >
          Displace
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 12, color: "var(--on-scene-dim)" }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--gold)",
            }}
          />
          <span>Bidding window closes in</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--on-scene)", letterSpacing: ".06em" }}>
            {clock}
          </span>
        </div>
      </div>

      {screen === "auth" && (
        <OverlayShell stepLabel="Sign in" onClose={closeOverlay}>
          <div style={headingStyle}>Sign in to claim the seat</div>
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: "var(--fg-dim)" }}>
            One account, one bid per round.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 24 }}>
            <button
              onClick={() => setScreen("bid")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: 16,
                border: "1px solid var(--line)",
                background: "var(--panel-2)",
                fontSize: 13,
                letterSpacing: ".04em",
              }}
            >
              Continue with Google
            </button>
            <button
              onClick={() => setScreen("bid")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: 16,
                border: "1px solid var(--line)",
                background: "var(--panel-2)",
                fontSize: 13,
                letterSpacing: ".04em",
              }}
            >
              Continue with Apple
            </button>
          </div>
          <div style={{ marginTop: 18, fontSize: 11, lineHeight: 1.6, color: "var(--fg-faint)" }}>
            Terms of participation and deposit rules are on the rules page.
          </div>
        </OverlayShell>
      )}

      {screen === "bid" && (
        <OverlayShell stepLabel="Bid" onClose={closeOverlay}>
          <div style={headingStyle}>Your bid</div>
          <div style={{ display: "flex", gap: 14, marginTop: 22 }}>
            <div style={boxStyle}>
              <div style={fieldLabelStyle}>Must beat</div>
              <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 5 }}>
                {priceLabel}
              </div>
            </div>
            <div style={boxStyle}>
              <div style={fieldLabelStyle}>Minimum</div>
              <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 5 }}>
                {minBidLabel}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <label htmlFor="auction-flow-bid" style={fieldLabelStyle}>
              Your bid, $
            </label>
            <input
              id="auction-flow-bid"
              type="text"
              value={bidValue}
              onChange={(e) => setBidValue(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: 8,
                padding: "16px 18px",
                background: "transparent",
                border: "1px solid var(--gold-soft)",
                color: "var(--fg)",
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: 34,
                letterSpacing: ".01em",
                outline: "none",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 12,
              marginTop: 20,
              padding: "16px 18px",
              border: "1px solid var(--line)",
              background: "var(--panel-2)",
            }}
          >
            <div>
              <div style={{ fontSize: 13 }}>Deposit charged now</div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--fg-dim)" }}>
                10% of the bid, capped at $1,000
              </div>
            </div>
            <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 30, whiteSpace: "nowrap" }}>
              {formatMoney(depositCents)}
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <div style={fieldLabelStyle}>Deposit payment method</div>
            <div style={{ display: "flex", gap: 9, marginTop: 9 }}>
              <button
                onClick={() => setPaymentProvider("ru")}
                style={{
                  flex: 1,
                  padding: 14,
                  fontSize: 12,
                  border: "1px solid",
                  borderColor: paymentProvider === "ru" ? "var(--gold-soft)" : "var(--line)",
                  background: "var(--panel-2)",
                  color: "var(--fg)",
                }}
              >
                YooKassa · RU
              </button>
              <button
                onClick={() => setPaymentProvider("intl")}
                style={{
                  flex: 1,
                  padding: 14,
                  fontSize: 12,
                  border: "1px solid",
                  borderColor: paymentProvider === "intl" ? "var(--gold-soft)" : "var(--line)",
                  background: "var(--panel-2)",
                  color: "var(--fg)",
                }}
              >
                Stripe · Intl
              </button>
            </div>
            <div style={{ marginTop: 9, fontSize: 11, color: "var(--fg-faint)" }}>
              RU cards use YooKassa; everyone else uses Stripe.
            </div>
          </div>
          <button onClick={() => setScreen("lead")} style={primaryButtonStyle}>
            Place deposit
          </button>
          <div style={{ marginTop: 14, textAlign: "center", fontSize: 12, color: "var(--fg-dim)" }}>
            Bidding window:{" "}
            <span style={{ color: "var(--fg)", fontVariantNumeric: "tabular-nums" }}>{clock}</span>
          </div>
        </OverlayShell>
      )}

      {screen === "lead" && (
        <OverlayShell stepLabel="You're in line" onClose={closeOverlay}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            You're first in line
          </div>
          <div
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 36,
              lineHeight: 1.06,
              marginTop: 12,
            }}
          >
            Bid {formatMoney(bidCents)} accepted
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.65, color: "var(--fg-dim)" }}>
            The seat is yours if no one outbids you before the window closes.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 22 }}>
            <div style={boxStyle}>
              <div style={fieldLabelStyle}>Deposit held</div>
              <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 26, marginTop: 5 }}>
                {formatMoney(depositCents)}
              </div>
            </div>
            <div style={boxStyle}>
              <div style={fieldLabelStyle}>Until snapshot</div>
              <div
                style={{
                  fontFamily: "'Cormorant Garamond', Georgia, serif",
                  fontSize: 26,
                  marginTop: 5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {clock}
              </div>
            </div>
          </div>
          <button
            onClick={closeOverlay}
            style={{
              width: "100%",
              marginTop: 22,
              padding: 16,
              border: "1px solid var(--gold-soft)",
              fontSize: 12,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            Round closed — continue
          </button>
        </OverlayShell>
      )}
    </div>
  );
}
