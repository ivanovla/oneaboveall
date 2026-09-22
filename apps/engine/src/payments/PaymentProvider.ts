export interface PaymentProvider {
  // Off-session because the engine itself initiates this — no bidder is
  // present in a browser at the moment a round resolves. paymentMethodRef is
  // the Stripe PaymentMethod id saved when this bidder paid their deposit
  // (see joinRound). "requires_action" covers a bank declining the charge
  // pending additional authentication (SCA/PSD2) — treated identically to
  // "failed" by every caller in this codebase; see roundResolution.ts.
  chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed">;
  refund(depositRef: string): Promise<void>;
}
