export type CaptureResult = { ok: true } | { ok: false; reason: string };

// Every bid is an authorization *hold* for its full amount (a PaymentIntent
// created with capture_method: "manual"), not a charge. The engine only ever
// does two things with a hold afterwards:
export interface PaymentProvider {
  // Drop the hold / hand the money back — when a bid is outbid past the
  // runner-up slot (see recordBid.ts), when a bid turns out not to qualify
  // by the time its webhook lands, or when the round settles to someone
  // else. Must be idempotent and tolerate whatever state the payment is
  // already in (an uncaptured hold is cancelled; a collected one — a bid
  // placed before holds existed — is refunded; an already-cancelled one is
  // a no-op), because the caller marks the bid released only *after* this
  // returns, so a crash in between means it will be called again.
  release(paymentRef: string): Promise<void>;
  // Collect a held bid: the round's winner, at the daily close (see
  // settlement.ts). Already collected → ok (a retry after a crash between
  // capturing and recording that we did). A definitive failure — declined,
  // hold expired or cancelled, payment in a state that can't be captured —
  // resolves to { ok: false } so settlement moves on to the runner-up. A
  // transient failure (network, provider outage, rate limit) must THROW
  // instead: settlement then leaves everything untouched and the next
  // scheduler tick tries the same bid again, rather than wrongly skipping a
  // winner whose card is fine.
  capture(paymentRef: string): Promise<CaptureResult>;
}
