import type { BidNotice, Notifier } from "./Notifier";

// In-memory stand-in for tests: records every notification instead of
// sending it.
export class FakeNotifier implements Notifier {
  outbids: BidNotice[] = [];
  wins: BidNotice[] = [];

  async outbid(notice: BidNotice): Promise<void> {
    this.outbids.push(notice);
  }

  async won(notice: BidNotice): Promise<void> {
    this.wins.push(notice);
  }
}
