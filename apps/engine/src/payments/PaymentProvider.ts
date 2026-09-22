export interface PaymentProvider {
  // Off-session because the engine itself initiates this — no bidder is
  // present in a browser at the moment a round resolves. paymentMethodRef is
  // the Stripe PaymentMethod id saved when this bidder paid their deposit
  // (see joinRound), and customerRef is the Stripe Customer it was attached
  // to at that time — a saved PaymentMethod is only reusable in a later,
  // separate PaymentIntent when that PaymentIntent names the same Customer,
  // so both refs are required. "requires_action" covers a bank declining the
  // charge pending additional authentication (SCA/PSD2) — treated identically
  // to "failed" by every caller in this codebase; see roundResolution.ts.
  //
  // Only genuine card outcomes are reported through this return type. An
  // infrastructure failure (network, auth, rate limit, malformed request) is
  // expected to THROW rather than be flattened into "failed": callers turn
  // "failed" into a forfeited deposit plus a ban, which must never be the
  // consequence of our own outage.
  chargeRemainderOffSession(
    customerRef: string,
    paymentMethodRef: string,
    amountCents: number,
  ): Promise<"succeeded" | "requires_action" | "failed">;
  refund(depositRef: string): Promise<void>;
}
