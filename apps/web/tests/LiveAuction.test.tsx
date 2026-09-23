import { describe, it, expect, vi, afterEach } from "vitest";
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
});
