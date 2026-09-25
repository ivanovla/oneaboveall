export interface PaymentProvider {
  // Every bid is charged in full, on-session, at bid time — the only payment
  // operation the engine itself ever initiates afterwards is handing money
  // back: when a bid is outbid (see recordBid.ts) or, less commonly, when an
  // already-succeeded charge turns out not to qualify by the time its
  // webhook lands.
  refund(paymentRef: string): Promise<void>;
}
