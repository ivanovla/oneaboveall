// Outbound "something happened to your bid" messages (email in production —
// see apps/api's ResendNotifier). Optional everywhere it's accepted: the
// engine's bookkeeping must work identically with no notifier at all, and a
// notifier must never be able to break it — callers go through
// notifySafely() below, so a down email provider costs an email, never a
// bid or a settlement.
export type BidNotice = {
  bidderId: string;
  // outbid: the new top bid — the amount they'd now have to beat.
  // won: the amount actually collected from them.
  amountCents: number;
};

export interface Notifier {
  outbid(notice: BidNotice): Promise<void>;
  won(notice: BidNotice): Promise<void>;
}

export const noopNotifier: Notifier = {
  async outbid() {},
  async won() {},
};

export async function notifySafely(kind: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (err) {
    console.error(`notifier: failed to send "${kind}" notification`, err);
  }
}
