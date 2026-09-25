import { loadStripe, type Stripe as StripeClient, type Appearance } from "@stripe/stripe-js";

// Mirrors tokens.css's dark-theme palette (account-area UI doesn't expose
// the homepage's light/dark toggle, so it always renders dark). Stripe's
// Appearance API needs literal color values, not CSS custom properties, so
// these are copied rather than read from the stylesheet — keep them in sync
// with tokens.css's `:root` block by hand if that palette ever changes.
export const stripeAppearance: Appearance = {
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

// Module-scope singleton: loadStripe() injects a script tag the first time
// it runs, so every caller on the page must share one promise rather than
// each mounting Stripe.js separately.
let stripePromise: Promise<StripeClient | null> | null = null;
export function getStripe(): Promise<StripeClient | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(import.meta.env.PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");
  }
  return stripePromise;
}
