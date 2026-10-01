import { buildServer } from "./server";
import { startScheduler } from "./scheduler";
import { stripe } from "./stripeClient";
import { StripePaymentProvider } from "./payments/StripePaymentProvider";
import { ResendNotifier } from "./notifications/ResendNotifier";

// One provider and one notifier for the whole process, shared by the
// webhook (recording bids, releasing outbid holds, outbid emails) and the
// scheduler (capturing winners at the close, won emails).
const provider = new StripePaymentProvider(stripe);
const notifier = new ResendNotifier();

const app = buildServer({ provider, notifier });
const port = Number(process.env.PORT ?? 3001);
// 127.0.0.1 by default so local dev never accidentally accepts connections
// from outside the machine. A container has no "outside" to protect against
// in the same way — its network namespace is already isolated — but it does
// need to accept connections from other pods, so production sets HOST=0.0.0.0
// (see infra/k8s/api.yaml).
const host = process.env.HOST ?? "127.0.0.1";

app.listen({ port, host }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

// Drives bidding-window close/champion-install (see scheduler.ts's own
// comment) — independent of whether the listen callback above has fired
// yet, since it doesn't touch the HTTP server at all.
startScheduler({ provider, notifier });
