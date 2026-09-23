import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import LiveAuction from "../src/components/LiveAuction";

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => ({
    confirmPayment: vi.fn(async () => ({ error: undefined })),
  })),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: vi.fn(async () => ({ error: undefined })) }),
  useElements: () => ({}),
}));

// Same window.location stubbing as AccountShell.test.tsx: jsdom refuses to
// perform a real navigation, so the component's `window.location.href = "/"`
// has to land on a plain object the tests can read back. Done in beforeEach
// (not afterEach) so it holds for the very first test too, whatever order
// they run in.
beforeEach(() => {
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "" };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockFetchSequence(responses: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/current-round") return { ok: true, json: async () => responses.currentRound };
    if (path.match(/^\/rounds\/.+\/me$/)) return { ok: true, json: async () => responses.participation };
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("LiveAuction", () => {
  it("shows a loading state before the first fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows the Join card when the signed-in user hasn't joined", async () => {
    global.fetch = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/join/i)).toBeInTheDocument());
    expect(screen.getByText("$100")).toBeInTheDocument(); // depositCents: 10_000 -> formatMoney -> "$100"
  });

  it("shows the bid form when the signed-in user has already joined", async () => {
    global.fetch = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: true },
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
  });

  it("shows a null-round state when there's no active reign yet", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (new URL(url).pathname === "/current-round") return { ok: true, json: async () => null };
      throw new Error("should not call /rounds/:id/me with no round");
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/no active round/i)).toBeInTheDocument());
  });

  it("re-polls /current-round every 5s while the tab is visible", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("pauses polling when the tab is hidden and resumes on visible", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const callsWhileHidden = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsWhileHidden); // no new calls while hidden

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileHidden); // an immediate re-fetch on becoming visible
  });

  it("clicking Join creates a PaymentIntent and mounts the Stripe payment form", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: false }) };
      if (path === "/rounds/round-1/join" && init?.method === "POST") return { ok: true, json: async () => ({ clientSecret: "pi_1_secret_x", depositCents: 10_000 }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Join")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Join"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/rounds/round-1/join", { method: "POST", credentials: "include" }));
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
  });

  it("clicking Join when the request fails shows an error and re-enables the button", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: false }) };
      if (path === "/rounds/round-1/join" && init?.method === "POST") throw new Error("Network error");
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Join")).toBeInTheDocument());

    const joinButton = screen.getByText("Join") as HTMLButtonElement;
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinButton.disabled).toBe(false)); // button re-enabled after error
    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument()); // error message shown
  });

  it("submitting a bid calls POST /bids and shows a confirmation", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: true }) };
      if (path === "/bids" && init?.method === "POST") return { ok: true, json: async () => ({ bidId: "bid-1" }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByText("Place bid"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/bids", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 150_000 }),
      }),
    );
    await waitFor(() => expect(screen.getByText(/bid placed/i)).toBeInTheDocument());
  });

  it("shows the engine's rejection reason when a bid is invalid", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: true }) };
      if (path === "/bids" && init?.method === "POST") return { ok: false, status: 422, json: async () => ({ error: "Bid must be at least $1 above the current leader." }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "500" } });
    fireEvent.click(screen.getByText("Place bid"));

    await waitFor(() => expect(screen.getByText("Bid must be at least $1 above the current leader.")).toBeInTheDocument());
  });

  it("truncates a mistyped decimal at the decimal point instead of concatenating across it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: true }) };
      if (path === "/bids" && init?.method === "POST") return { ok: true, json: async () => ({ bidId: "bid-2" }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    const bidInput = screen.getByLabelText(/your bid/i) as HTMLInputElement;
    // Bidding here is whole dollars only (AuctionFlow.tsx does the same), so
    // "15.50" can't be accepted as $15.50 either way. What this locks in is
    // WHICH whole-dollar value a mistyped decimal collapses to: truncating at
    // the first non-digit leaves "15", where stripping every non-digit
    // anywhere in the string used to leave "1550" — an amount 100x larger
    // than intended, which the user had no obvious reason to re-read before
    // clicking Place bid.
    fireEvent.change(bidInput, { target: { value: "15.50" } });
    expect(bidInput.value).toBe("15");

    fireEvent.click(screen.getByText("Place bid"));

    // $15, matching exactly what the field now displays.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/bids", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 1_500 }),
      }),
    );
  });

  // A non-2xx from /rounds/:id/join carries `{ error }` and no clientSecret.
  // Reading clientSecret off it unconditionally set it to `undefined`, so the
  // Join card silently re-rendered unchanged — no Stripe form, no reason why.
  it("clicking Join on a rejected join (403) surfaces the error and leaves the button usable", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, status: 200, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, status: 200, json: async () => ({ joined: false }) };
      if (path === "/rounds/round-1/join" && init?.method === "POST") {
        return { ok: false, status: 403, json: async () => ({ error: "You are banned from bidding until 2026-10-01." }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Join")).toBeInTheDocument());

    const joinButton = screen.getByText("Join") as HTMLButtonElement;
    fireEvent.click(joinButton);

    await waitFor(() => expect(screen.getByText("You are banned from bidding until 2026-10-01.")).toBeInTheDocument());
    expect(joinButton.disabled).toBe(false);
    // Still the Join card, not a half-mounted Stripe form with no secret.
    expect(screen.queryByTestId("payment-element")).not.toBeInTheDocument();
  });

  // AccountShell only checks the session once, on mount. A sign-out in
  // another tab (or plain expiry) while this page is open shows up here, as a
  // 401 on the next poll — which previously read `joined: undefined` and put
  // the Join card in front of a signed-out user.
  it("redirects to / when /rounds/:id/me 401s after mount, instead of showing the Join card", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, status: 200, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: false, status: 401, json: async () => ({ error: "Not signed in." }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(window.location.href).toBe("/"));
    expect(screen.queryByText("Join")).not.toBeInTheDocument();
  });

  it("redirects to / when /current-round itself 401s after mount", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "Not signed in." }) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  // pollJoinStatus runs immediately after the card was charged: an uncaught
  // rejection there left `submitting` true forever, disabling the only
  // control ("Check status") the user had left.
  it("a network failure while polling join status shows an error and re-enables Check status", async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, status: 200, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") {
        meCalls++;
        // The first call is LiveAuction's own mount poll (user hasn't
        // joined); every later one comes from pollJoinStatus, and that is
        // the loop whose rejection used to escape uncaught.
        if (meCalls === 1) return { ok: true, status: 200, json: async () => ({ joined: false }) };
        throw new Error("Network error");
      }
      if (path === "/rounds/round-1/join" && init?.method === "POST") return { ok: true, status: 200, json: async () => ({ clientSecret: "pi_1_secret_x", depositCents: 10_000 }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Join")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Join"));
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());

    // Confirm the (mocked, always-succeeding) Stripe payment, which hands off
    // to pollJoinStatus.
    fireEvent.click(screen.getByText("Confirm payment"));

    await waitFor(() => expect(screen.getByText(/couldn't check your join status/i)).toBeInTheDocument());
    const checkButton = screen.getByText("Check status") as HTMLButtonElement;
    expect(checkButton.disabled).toBe(false);
  });
});
