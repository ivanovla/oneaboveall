import { eq } from "drizzle-orm";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import type { BidNotice, Notifier } from "engine/notifications/Notifier";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "oneaboveall <noreply@oneaboveall.org>";
const DEFAULT_APP_URL = "https://oneaboveall.org";

type Recipient = { email: string; photoPath: string | null };

export type ResendNotifierOptions = {
  apiKey?: string;
  from?: string;
  appUrl?: string;
  // Injectable for tests; defaults to the users table. bidderId is a
  // users.id (see schema.ts).
  lookupUser?: (bidderId: string) => Promise<Recipient | null>;
};

async function lookupUserInDb(bidderId: string): Promise<Recipient | null> {
  const [row] = await db
    .select({ email: users.email, photoPath: users.photoPath })
    .from(users)
    .where(eq(users.id, bidderId))
    .limit(1);
  return row ?? null;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Outbid / won emails via Resend's HTTP API — a plain fetch, no SDK, since
// it's one POST. Every failure (no such user, Resend down, a rejected
// request) is caught and logged here: the engine already wraps notifier
// calls defensively, but an email is never worth an exception reaching
// payment bookkeeping.
//
// Plain-text bodies on purpose: nothing user-supplied is interpolated except
// the amount, and text renders everywhere without an HTML template to keep
// escaped and in sync.
export class ResendNotifier implements Notifier {
  private readonly apiKey: string | undefined;
  private readonly from: string;
  private readonly appUrl: string;
  private readonly lookupUser: (bidderId: string) => Promise<Recipient | null>;
  private warnedMissingKey = false;

  // Defaults read from the environment at construction (once, at boot),
  // the same way stripeClient.ts reads its own config. An explicitly passed
  // `apiKey: undefined` means "disabled", not "fall back to the env".
  constructor(options: ResendNotifierOptions = {}) {
    this.apiKey = "apiKey" in options ? options.apiKey : process.env.RESEND_API_KEY || undefined;
    this.from = options.from ?? (process.env.EMAIL_FROM || DEFAULT_FROM);
    this.appUrl = (options.appUrl ?? (process.env.PUBLIC_APP_URL || DEFAULT_APP_URL)).replace(/\/+$/, "");
    this.lookupUser = options.lookupUser ?? lookupUserInDb;
  }

  async outbid({ bidderId, amountCents }: BidNotice): Promise<void> {
    await this.send(bidderId, "outbid", () => ({
      subject: "You've been outbid on oneaboveall.org",
      text: [
        `Someone just outbid you — the top bid is now ${formatUsd(amountCents)}.`,
        "",
        "You won't be charged for a bid that doesn't win: its hold on your card is released (at the latest when bidding closes at 4 PM ET).",
        "",
        `Want the seat back? Bid again: ${this.appUrl}`,
      ].join("\n"),
    }));
  }

  async won({ bidderId, amountCents }: BidNotice): Promise<void> {
    await this.send(bidderId, "won", (recipient) => ({
      subject: "You won the seat",
      text: [
        `Congratulations — your bid of ${formatUsd(amountCents)} won the seat on oneaboveall.org. Your card has now been charged.`,
        "",
        ...(recipient.photoPath
          ? []
          : [`We don't have your photo yet — please upload one so we can draw you in: ${this.appUrl}`, ""]),
        "Your art appears on the site around 7 PM ET today.",
        "",
        this.appUrl,
      ].join("\n"),
    }));
  }

  private async send(
    bidderId: string,
    kind: string,
    compose: (recipient: Recipient) => { subject: string; text: string },
  ): Promise<void> {
    if (!this.apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        console.warn("ResendNotifier: RESEND_API_KEY is not set — outbid/won emails are disabled.");
      }
      return;
    }

    try {
      const recipient = await this.lookupUser(bidderId);
      if (!recipient) {
        console.error(`ResendNotifier: no user ${bidderId}; "${kind}" email not sent`);
        return;
      }
      const { subject, text } = compose(recipient);
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [recipient.email], subject, text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`ResendNotifier: "${kind}" email for ${bidderId} rejected with ${res.status} ${detail}`);
      }
    } catch (err) {
      console.error(`ResendNotifier: failed to send "${kind}" email for ${bidderId}`, err);
    }
  }
}
