import { useEffect, useState } from "react";
import { formatMoney, formatCountdown, calculateDepositDisplay } from "../lib/format";
import {
  mockCurrentPriceCents,
  mockBiddingWindowClosesAt,
  mockPaymentWindowClosesAt,
  mockReferenceNow,
  mockLeaderboard,
} from "../lib/mockData";
import type { LeaderboardRow } from "../lib/types";

// A one-dollar step above the current price. Renders the "Minimum" figure on
// the bid screen, seeds the input's prefilled value, and acts as the floor
// every derived bid figure is clamped to. Purely cosmetic — there is no
// server-side minimum bid concept in the data this component consumes.
const MIN_BID_INCREMENT_CENTS = 100;

/**
 * Turns the raw, unsanitised string the user typed into a usable cents figure.
 *
 * Mirrors the prototype's
 *   `Math.max(s.current + 1, Number(String(s.bid).replace(/[^\d]/g, "")) || 0)`
 * (design/prototype/one-above-all.dc.html ~line 316), adapted to this app's
 * "dollars in the input, converted to cents exactly once" convention.
 *
 * The input sits directly beneath a comma-formatted "$4,210", so typing
 * "4,300" is the natural thing to do — without stripping separators that fed
 * `Number("4,300") === NaN` straight into four downstream screens as "$NaN".
 * Every non-digit is dropped (commas, spaces, "$", stray letters), an empty
 * or unparseable result falls back to 0, and the figure is finally floored at
 * `minBidCents` so no screen can ever display a bid below what it takes to
 * displace the champion.
 */
function parseBidCents(rawValue: string, minBidCents: number): number {
  const digits = rawValue.replace(/[^\d]/g, "");
  const dollars = digits === "" ? 0 : Number(digits);
  // A long enough run of digits overflows to Infinity; treat that (and any
  // other non-finite result) the same as "nothing usable was typed".
  const cents = Number.isFinite(dollars) ? dollars * 100 : 0;
  return Math.max(minBidCents, cents);
}

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

/**
 * Renders `closesAt` as a live HH:MM:SS countdown.
 *
 * Two constraints shape this:
 *
 * 1. Hydration safety. This island is mounted with `client:idle`, so Astro
 *    server-renders it at *build* time and the browser has to reproduce that
 *    exact markup on hydration. Reading `Date.now()` during render (as
 *    `useState(() => Date.now())` did) bakes the build machine's clock into
 *    the static HTML, which the browser then contradicts — a React hydration
 *    mismatch, plus a stale figure on screen until the idle callback fires.
 *    So the first render is derived purely from fixed data, and the only
 *    `Date.now()` reads happen inside the effect, which never runs on the
 *    server.
 *
 * 2. A frozen mock snapshot. Remaining time is measured from
 *    `mockReferenceNow`, not the real wall clock. The mock dataset is a
 *    snapshot taken at that instant; comparing its fixed close time against
 *    the real clock is what decayed the countdown to a permanent `00:00:00`
 *    in the first place, and no fixed date can survive that comparison for
 *    more than a few hours. Anchoring to the snapshot reproduces the
 *    prototype's own behaviour exactly (it seeds `left` with a literal
 *    6h41m12s and decrements it once a second) while keeping `closesAt`
 *    modelled the way a real API would hand it over — as a timestamp.
 *
 * The ticking is driven by elapsed real time since mount rather than by
 * counting interval fires, so a throttled background tab resumes at the right
 * value instead of drifting.
 */
function useCountdown(closesAt: Date): string {
  const remainingAtSnapshotMs = closesAt.getTime() - mockReferenceNow.getTime();
  const [elapsedSinceMountMs, setElapsedSinceMountMs] = useState(0);

  useEffect(() => {
    const mountedAt = Date.now();
    const id = setInterval(() => setElapsedSinceMountMs(Date.now() - mountedAt), 1000);
    return () => clearInterval(id);
  }, []);

  return formatCountdown(remainingAtSnapshotMs - elapsedSinceMountMs);
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
  animation: "rise .28s ease both",
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

// One heading style for every overlay screen (auth/bid/lead/pay/upload/
// pending/missed). The prototype itself drifted between 34px/1.08, 36px/1.06
// and 34px/1.1 across those seven screens; 36px/1.06 is the value its three
// most recent screens (lead/pay/upload) settled on, so it wins here rather
// than the three ad-hoc sizes this file had grown.
const headingStyle: React.CSSProperties = {
  fontFamily: "'Cormorant Garamond', Georgia, serif",
  fontSize: 36,
  lineHeight: 1.06,
};

// The two fixed top-right chrome chips (theme toggle + Leaderboard), styled
// identically in the prototype.
const chromeButtonStyle: React.CSSProperties = {
  padding: "8px 13px",
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "var(--on-scene-dim)",
  border: "1px solid var(--line)",
  background: "var(--scene-chip)",
  backdropFilter: "blur(8px)",
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

// Keep in sync with the pre-paint theme script in layouts/BaseLayout.astro,
// which reads the same key before this island ever hydrates.
const THEME_STORAGE_KEY = "oneabobeall:theme";

/**
 * Drives the `data-theme` attribute on <html>, which tokens.css keys its
 * light palette (and the scene's `--shade` blend) off.
 *
 * `document` is deliberately never touched during render: this island is
 * server-rendered at build time, so the first client render has to match the
 * static HTML. The button label is seeded with the dark-theme default (it
 * names the theme it would switch *to*, as in the prototype) and corrected in
 * an effect once the real, possibly persisted, theme is known.
 */
function useThemeToggle(): { label: string; toggle: () => void } {
  const [isLight, setIsLight] = useState(false);

  useEffect(() => {
    setIsLight(document.documentElement.dataset.theme === "light");
  }, []);

  function toggle() {
    const root = document.documentElement;
    const nextIsLight = root.dataset.theme !== "light";
    if (nextIsLight) {
      root.dataset.theme = "light";
    } else {
      delete root.dataset.theme;
    }
    setIsLight(nextIsLight);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextIsLight ? "light" : "dark");
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The
      // toggle still works for this page view; it just won't be remembered.
    }
  }

  return { label: isLight ? "Dark" : "Light", toggle };
}

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

export default function AuctionFlow({
  initialScreen = "closed",
  leaderboard = mockLeaderboard,
  // The price the seat currently costs — i.e. the reigning champion's
  // priceCents. pages/index.astro passes the real, adapted champion's price
  // here, so the headline figure above the Displace button is the same number
  // the scene's own tooltip shows for the champion rendered right above it.
  // Defaults to the mock constant so this component still renders standalone
  // (tests, any caller with no live data) exactly as it did before.
  currentPriceCents = mockCurrentPriceCents,
}: {
  initialScreen?: Screen;
  leaderboard?: LeaderboardRow[];
  currentPriceCents?: number;
} = {}) {
  const minBidCents = currentPriceCents + MIN_BID_INCREMENT_CENTS;

  const [screen, setScreen] = useState<Screen>(initialScreen);
  // The raw string shown in the bid input on first paint: one increment above
  // the current price (with the mock price, the prototype's `bid: 4211`).
  // Derived purely from props, so the server-rendered HTML and the browser's
  // first hydration render agree — see useCountdown's note on `client:idle`.
  const [bidValue, setBidValue] = useState(() => String(Math.round(minBidCents / 100)));
  const [paymentProvider, setPaymentProvider] = useState<PaymentProvider>("ru");
  const [consent, setConsent] = useState(false);
  const theme = useThemeToggle();

  // KNOWN GAP — deliberate, tracked. Unlike the price and the leaderboard,
  // both countdowns are still driven by mock constants frozen at
  // `mockReferenceNow`, even when everything else on the page is live. The
  // API exposes only `getScene` / `getLeaderboard`; there is no round or
  // offer state on it yet, so the real "bidding window closes at" and
  // "payment window closes at" instants simply aren't available to fetch.
  // Closing this needs a round-state API surface first, at which point these
  // become props threaded from index.astro the same way `currentPriceCents`
  // and `leaderboard` are. Until then the countdowns are demo figures, and
  // the whole bid/pay flow below them is still a non-transacting mock.
  const clock = useCountdown(mockBiddingWindowClosesAt);
  const payClock = useCountdown(mockPaymentWindowClosesAt);

  const priceLabel = formatMoney(currentPriceCents);
  const minBidLabel = formatMoney(minBidCents);

  // `bidValue` is the raw string the user typed, and stays that way — the
  // <input> below shows it back verbatim, separators and all. Every *derived*
  // figure goes through `parseBidCents` instead, which sanitises and floors
  // it, so the deposit / lead / pay / missed screens can never render "$NaN"
  // or a sub-minimum bid no matter what was typed. Cents conversion happens
  // exactly once, here; every downstream computation works in cents.
  const bidCents = parseBidCents(bidValue, minBidCents);
  const depositCents = calculateDepositDisplay(bidCents);
  // Same bidCents/depositCents carried over from the bid screen — no re-parsing.
  const remainderCents = bidCents - depositCents;

  const payProviderLabel =
    paymentProvider === "ru"
      ? "YooKassa · charged in rubles at the CBR rate"
      : "Stripe · charged in US dollars";

  const geoNote =
    paymentProvider === "ru"
      ? "IP detected as Russian — YooKassa selected. You can switch manually."
      : "Visa / Mastercard, charged in US dollars.";

  function closeOverlay() {
    setScreen("closed");
  }

  return (
    <div>
      <div
        style={{
          position: "fixed",
          top: 22,
          right: 24,
          display: "flex",
          gap: 6,
          alignItems: "center",
          zIndex: 20,
        }}
      >
        <button onClick={theme.toggle} style={chromeButtonStyle} aria-label={`Switch to ${theme.label.toLowerCase()} theme`}>
          {theme.label}
        </button>
        <button onClick={() => setScreen("top")} style={chromeButtonStyle}>
          Leaderboard
        </button>
      </div>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "150px 20px 34px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          zIndex: 15,
          color: "var(--on-scene)",
          background:
            "linear-gradient(to top, rgba(6,5,2,.86) 0%, rgba(6,5,2,.66) 42%, rgba(6,5,2,0) 100%)",
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
              animation: "breathe 2.4s infinite",
            }}
          />
          <span>Bidding window closes in</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--on-scene)", letterSpacing: ".06em" }}>
            {clock}
          </span>
        </div>
      </div>

      {screen === "auth" && (
        <OverlayShell stepLabel="Step 1 · Sign in" onClose={closeOverlay}>
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
        <OverlayShell stepLabel="Step 2 · Bid" onClose={closeOverlay}>
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
                  borderColor: paymentProvider === "ru" ? "var(--gold)" : "var(--line)",
                  background: paymentProvider === "ru" ? "var(--gold)" : "var(--panel-2)",
                  color: paymentProvider === "ru" ? "var(--btn-fg)" : "var(--fg)",
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
                  borderColor: paymentProvider === "intl" ? "var(--gold)" : "var(--line)",
                  background: paymentProvider === "intl" ? "var(--gold)" : "var(--panel-2)",
                  color: paymentProvider === "intl" ? "var(--btn-fg)" : "var(--fg)",
                }}
              >
                Stripe · Intl
              </button>
            </div>
            <div style={{ marginTop: 9, fontSize: 11, color: "var(--fg-faint)" }}>{geoNote}</div>
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
        <OverlayShell stepLabel="Step 3 · Queue" onClose={closeOverlay}>
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
          <div style={{ ...headingStyle, marginTop: 12 }}>
            Bid {formatMoney(bidCents)} accepted
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.65, color: "var(--fg-dim)" }}>
            The seat is yours if no one outbids you before the window closes. Queue snapshot at 9:00
            PM MSK.
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
            onClick={() => setScreen("pay")}
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

      {screen === "pay" && (
        <OverlayShell stepLabel="Step 4 · Balance" onClose={closeOverlay}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            You won the round
          </div>
          <div style={{ ...headingStyle, marginTop: 12 }}>Remaining balance due</div>
          <div style={{ marginTop: 26, textAlign: "center" }}>
            <div
              style={{
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: 64,
                lineHeight: 1,
                letterSpacing: "-.02em",
              }}
            >
              {formatMoney(remainderCents)}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-dim)" }}>
              Bid {formatMoney(bidCents)} minus deposit {formatMoney(depositCents)}
            </div>
          </div>
          <div
            style={{
              marginTop: 26,
              padding: 20,
              border: "1px solid var(--gold-soft)",
              textAlign: "center",
              background: "var(--panel-2)",
            }}
          >
            <div style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--fg-faint)" }}>
              Payment window closes in
            </div>
            <div
              style={{
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: 52,
                lineHeight: 1.05,
                marginTop: 6,
                fontVariantNumeric: "tabular-nums",
                color: "var(--gold)",
              }}
            >
              {payClock}
            </div>
          </div>
          <button onClick={() => setScreen("upload")} style={primaryButtonStyle}>
            Pay {formatMoney(remainderCents)}
          </button>
          <div style={{ marginTop: 13, textAlign: "center", fontSize: 11, color: "var(--fg-faint)" }}>
            {payProviderLabel}
          </div>
        </OverlayShell>
      )}

      {screen === "upload" && (
        <OverlayShell stepLabel="Step 5 · Photo" onClose={closeOverlay}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--gold)",
            }}
          >
            Paid
          </div>
          <div style={{ ...headingStyle, marginTop: 12 }}>Send your face</div>
          <div style={{ marginTop: 11, fontSize: 13, lineHeight: 1.65, color: "var(--fg-dim)" }}>
            Front-facing photo, full face, no glasses or headwear.
          </div>
          <div
            style={{
              marginTop: 22,
              aspectRatio: "4 / 3",
              border: "1px dashed var(--gold-soft)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              background: "var(--panel-2)",
            }}
          >
            <div
              style={{
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 11,
                letterSpacing: ".12em",
                color: "var(--fg-faint)",
              }}
            >
              selfie · jpg / png · up to 12 MB
            </div>
            <button
              style={{
                padding: "12px 26px",
                border: "1px solid var(--gold-soft)",
                fontSize: 11,
                letterSpacing: ".22em",
                textTransform: "uppercase",
                color: "var(--gold)",
              }}
            >
              Choose file
            </button>
          </div>
          <button
            onClick={() => setConsent((c) => !c)}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              textAlign: "left",
              marginTop: 20,
              padding: "14px 15px",
              border: "1px solid var(--line)",
              width: "100%",
              background: "var(--panel-2)",
            }}
          >
            <span
              style={{
                flex: "0 0 18px",
                width: 18,
                height: 18,
                border: "1px solid var(--gold)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                color: "var(--btn-fg)",
                background: consent ? "var(--gold)" : "transparent",
              }}
            >
              {consent ? "✓" : ""}
            </span>
            <span style={{ fontSize: 12, lineHeight: 1.55, color: "var(--fg-dim)" }}>
              I agree to have my photo published on the homepage and in the champions archive.
            </span>
          </button>
          <button
            onClick={() => setScreen("pending")}
            disabled={!consent}
            style={{
              width: "100%",
              marginTop: 20,
              padding: 18,
              background: "var(--gold)",
              color: "var(--btn-fg)",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: ".34em",
              textTransform: "uppercase",
              opacity: consent ? 1 : 0.34,
              cursor: consent ? "pointer" : "not-allowed",
            }}
          >
            Submit
          </button>
        </OverlayShell>
      )}

      {screen === "pending" && (
        <OverlayShell stepLabel="Step 6 · Waiting" onClose={closeOverlay}>
          <div style={{ padding: "24px 0 20px", textAlign: "center" }}>
            <div
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "var(--gold)",
                margin: "0 auto",
                animation: "breathe 2.2s infinite",
              }}
            />
            <div style={{ ...headingStyle, marginTop: 22 }}>The scene is updating</div>
            <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.7, color: "var(--fg-dim)" }}>
              The shot is being re-composed with you at the center. Usually takes a few minutes — feel
              free to close this page, we'll notify you.
            </div>
            <button
              onClick={closeOverlay}
              style={{
                marginTop: 26,
                padding: "15px 34px",
                border: "1px solid var(--gold-soft)",
                fontSize: 11,
                letterSpacing: ".26em",
                textTransform: "uppercase",
                color: "var(--gold)",
              }}
            >
              Back to the scene
            </button>
          </div>
        </OverlayShell>
      )}

      {screen === "missed" && (
        <OverlayShell stepLabel="Round missed" onClose={closeOverlay}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "var(--fg-faint)",
            }}
          >
            Payment window closed
          </div>
          <div style={{ ...headingStyle, marginTop: 12 }}>
            The seat moved to the next in line
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.7, color: "var(--fg-dim)" }}>
            The remaining balance didn't arrive before the daily window closed, so the offer passed to
            the second in queue.
          </div>
          <div style={{ marginTop: 22, border: "1px solid var(--line)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "14px 16px",
                borderBottom: "1px solid var(--line)",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--fg-dim)" }}>Deposit</span>
              <span>{formatMoney(depositCents)} forfeited</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "14px 16px",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--fg-dim)" }}>Participation</span>
              <span>3-round pause</span>
            </div>
          </div>
          <div style={{ marginTop: 16, fontSize: 12, lineHeight: 1.6, color: "var(--fg-faint)" }}>
            Next eligible bid: August 14. If your payment was delayed, reach out and we'll sort it out.
          </div>
          <button
            onClick={closeOverlay}
            style={{
              width: "100%",
              marginTop: 22,
              padding: 16,
              border: "1px solid var(--line)",
              fontSize: 11,
              letterSpacing: ".26em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            Back to the scene
          </button>
        </OverlayShell>
      )}

      {screen === "top" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "var(--scrim)",
            backdropFilter: "blur(20px)",
            overflow: "auto",
          }}
        >
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto",
              padding: "clamp(28px, 7vh, 72px) 22px 80px",
              animation: "rise .3s ease both",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: ".3em", textTransform: "uppercase", color: "var(--gold)" }}>
                  Leaderboard
                </div>
                <div
                  style={{
                    fontFamily: "'Cormorant Garamond', Georgia, serif",
                    fontSize: "clamp(38px, 6vw, 60px)",
                    lineHeight: 1.02,
                    marginTop: 10,
                  }}
                >
                  Who held the seat the longest
                </div>
              </div>
              <button
                onClick={closeOverlay}
                style={{
                  flex: "0 0 auto",
                  padding: "10px 15px",
                  border: "1px solid var(--line)",
                  fontSize: 10,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--fg-dim)",
                }}
              >
                Close
              </button>
            </div>
            <div style={{ marginTop: 38, borderTop: "1px solid var(--line)" }}>
              {leaderboard.map((row, i) => (
                <div
                  key={row.occupantId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "38px 1fr auto auto",
                    gap: "clamp(10px, 3vw, 28px)",
                    alignItems: "center",
                    padding: "17px 4px",
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 22, color: "var(--gold)" }}>
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <div style={{ fontSize: 15 }}>{row.name}</div>
                    <div style={{ marginTop: 3, fontSize: 11, color: "var(--fg-faint)" }}>
                      {row.rounds} round{row.rounds === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 12, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>
                    {formatMoney(row.totalSpentCents)}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      minWidth: 74,
                      fontFamily: "'Cormorant Garamond', Georgia, serif",
                      fontSize: 21,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {row.totalDurationLabel}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 20, fontSize: 11, color: "var(--fg-faint)" }}>
              Cumulative time at the head of the table. Data since March 3, 2026.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
