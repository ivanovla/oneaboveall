import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuctionFlow from "../src/components/AuctionFlow";

// The Displace overlay's "bid" screen renders the real BidFlow, which
// imports these — same mocks as BidFlow.test.tsx.
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

// AuctionFlow checks /auth/me on mount (to route an already-signed-in
// Displace click straight to BidFlow) — real Node fetch is global even
// under jsdom, so without a mock every test would fire a real network
// request. Defaults to signed-out (401), matching the common case; tests
// exercising the signed-in path override this per-test.
beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
});

describe("AuctionFlow", () => {
  it("shows a loading spinner for the price (not a guessed number) and the Displace button on the closed screen", () => {
    render(<AuctionFlow />);
    expect(screen.getByText("Displace")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /loading current price/i })).toBeInTheDocument();
  });

  it("renders a deterministic first countdown frame that ignores the wall clock", () => {
    // The island is server-rendered at build time (client:idle), so the first
    // render must not read Date.now() — otherwise the built HTML disagrees
    // with what the browser computes on hydration. Until the real
    // biddingClosesAt is fetched, the countdown shows a neutral placeholder
    // rather than reading the clock (or showing a number that would then
    // visibly jump once live data arrives).
    // Pinning the clock to the epoch and asserting the placeholder still
    // shows is what proves the render never read it.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      render(<AuctionFlow />);
      expect(screen.getByText("—:--:--")).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("opens the sign-in screen when Displace is clicked", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument();
  });

  // These are real, top-level-navigation links into the live API's OAuth
  // entry points (GET /auth/google, GET /auth/apple) — not client-side
  // handlers — so the browser follows Google/Apple's own redirect chain and
  // lands back on /. No mock sign-in screen exists anymore; the real
  // bid/deposit flow lives in the same Displace overlay's "bid" screen
  // (BidFlow.tsx) once signed in.
  it("wires Continue with Google/Apple to the live API's OAuth entry points", () => {
    render(<AuctionFlow apiBaseUrl="http://api.test" />);
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Continue with Google")).toHaveAttribute("href", "http://api.test/auth/google");
    expect(screen.getByText("Continue with Apple")).toHaveAttribute("href", "http://api.test/auth/apple");
  });

  it("defaults apiBaseUrl to localhost when the caller doesn't supply one", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Continue with Google")).toHaveAttribute("href", "http://127.0.0.1:3001/auth/google");
  });
});

describe("AuctionFlow — already signed in", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // @ts-expect-error test override
    delete window.location;
    // @ts-expect-error test override
    window.location = { href: "" };
  });

  afterEach(() => {
    // @ts-expect-error test override
    window.location = originalLocation;
  });

  it("opens the Displace bid flow directly for an already-signed-in visitor, instead of the sign-in screen", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/auth/me") return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) };
      if (path === "/current-round") return { ok: true, status: 200, json: async () => null };
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    render(<AuctionFlow />);

    // The session check is async; wait for it to settle before clicking,
    // otherwise the click lands during the still-false default state.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:3001/auth/me", { credentials: "include" }));

    fireEvent.click(screen.getByText("Displace"));

    // BidFlow's own loading, then "no round" state — confirms the real
    // component is embedded directly in this overlay, not a sidebar link.
    await waitFor(() => expect(screen.getByText(/no active round/i)).toBeInTheDocument());
    expect(screen.queryByText("Sign in to claim the seat")).not.toBeInTheDocument();
  });

  it("still shows the sign-in screen when the session check fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    render(<AuctionFlow />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument();
  });
});

describe("AuctionFlow — photo reminder", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // @ts-expect-error test override
    delete window.location;
    // @ts-expect-error test override
    window.location = { href: "" };
  });

  afterEach(() => {
    // @ts-expect-error test override
    window.location = originalLocation;
  });

  function mockFetch(opts: { photoPath: string | null; isLeading: boolean }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/auth/me") return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A", photoPath: opts.photoPath }) };
      if (path === "/current-round") return { ok: true, status: 200, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, status: 200, json: async () => ({ isLeading: opts.isLeading }) };
      if (path === "/auth/photo" && init?.method === "POST") return { ok: true, status: 200, json: async () => ({ photoPath: "u1.jpg" }) };
      if (path === "/auth/character-request" && init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ characterRequest: null }) };
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  it("pops up asking for a photo when the signed-in visitor is currently leading with no photo on file", async () => {
    global.fetch = mockFetch({ photoPath: null, isLeading: true });
    render(<AuctionFlow />);

    await waitFor(() => expect(screen.getByText(/add your photo/i)).toBeInTheDocument());
    expect(screen.getByText(/you're currently leading/i)).toBeInTheDocument();
  });

  it("does not pop up when a photo is already on file", async () => {
    global.fetch = mockFetch({ photoPath: "u1.jpg", isLeading: true });
    render(<AuctionFlow />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:3001/auth/me", { credentials: "include" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/add your photo/i)).not.toBeInTheDocument();
  });

  it("does not pop up when the visitor isn't currently leading", async () => {
    global.fetch = mockFetch({ photoPath: null, isLeading: false });
    render(<AuctionFlow />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:3001/rounds/round-1/me", { credentials: "include" }));
    expect(screen.queryByText(/add your photo/i)).not.toBeInTheDocument();
  });

  it("never overrides a screen the visitor already navigated to themselves", async () => {
    global.fetch = mockFetch({ photoPath: null, isLeading: true });
    render(<AuctionFlow />);

    // Click Displace immediately, before the reminder's own fetch chain (which
    // starts on mount too) has resolved — the reminder must not clobber it
    // once its own check comes back.
    fireEvent.click(screen.getByText("Displace"));
    await waitFor(() => expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument());

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument();
    expect(screen.queryByText(/add your photo/i)).not.toBeInTheDocument();
  });

  it("closes once a photo is successfully uploaded", async () => {
    global.fetch = mockFetch({ photoPath: null, isLeading: true });
    render(<AuctionFlow />);

    await waitFor(() => expect(screen.getByText(/add your photo/i)).toBeInTheDocument());

    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload photo"));

    await waitFor(() => expect(screen.queryByText(/add your photo/i)).not.toBeInTheDocument());
  });
});

describe("AuctionFlow — live price", () => {
  // Neither figure is guessed at from build-time data anymore — both start
  // as a loading state (a spinner for the price, a placeholder for the
  // countdown) and switch to the real value the instant this fetch resolves,
  // so nothing ever visibly jumps from one number to a different one.
  it("shows the live current-round leader once the fetch resolves, replacing the spinner", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 555_500, biddingClosesAt: "2026-09-23T12:00:00.000Z" }),
        };
      }
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;

    render(<AuctionFlow />);
    expect(screen.getByRole("status", { name: /loading current price/i })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("$5,555")).toBeInTheDocument());
    expect(screen.queryByRole("status", { name: /loading current price/i })).not.toBeInTheDocument();
  });

  it("keeps showing the spinner when there's no active round to poll", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, status: 200, json: async () => null };
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;

    render(<AuctionFlow />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:3001/current-round", { credentials: "include" }));
    expect(screen.getByRole("status", { name: /loading current price/i })).toBeInTheDocument();
  });

  // The matching case for "Bidding window closes in": it used to always
  // count down from the same fixed mock target (~6h41m on every reload),
  // never the real round's actual close time.
  it("switches the countdown to the live bidding window close time once the fetch resolves", async () => {
    const liveClosesAt = new Date(Date.now() + 2 * 60 * 60 * 1000 + 30_000); // ~2h from now
    global.fetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, biddingClosesAt: liveClosesAt.toISOString() }),
        };
      }
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;

    render(<AuctionFlow />);
    // First frame, before live data has arrived: a neutral placeholder, not
    // a guessed number that would then jump.
    expect(screen.getByText("—:--:--")).toBeInTheDocument();

    // Once the fetch resolves and the 1s ticker has fired at least once, the
    // countdown switches to the real close time (~2h remaining here) —
    // never the fixed "06:41:xx" mock figure.
    await waitFor(() => expect(screen.getByText(/^0[12]:(59|00):\d\d$/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/^06:41:/)).not.toBeInTheDocument();
  });
});

describe("AuctionFlow — theme toggle", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it("flips data-theme on <html> and relabels itself", () => {
    render(<AuctionFlow />);
    const toggle = screen.getByRole("button", { name: /switch to light theme/i });
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("oneabobeall:theme")).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("oneabobeall:theme")).toBe("dark");
  });
});

describe("AuctionFlow — leaderboard", () => {
  it("opens the leaderboard from the closed screen and lists every mock row", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Leaderboard"));
    expect(screen.getByText("Who held the seat the longest")).toBeInTheDocument();
    for (const row of [
      "Mark Vilensky",
      "Osei Adjei",
      "Daniel Crowe",
      "Felix Lang",
      "Y. Kimura",
      "Arthur Lemeshev",
      "Timur Aslanov",
      "Paul Renier",
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
  });

  it("closes the leaderboard and returns to the closed screen", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Leaderboard"));
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByText("Who held the seat the longest")).not.toBeInTheDocument();
    expect(screen.getByText("Displace")).toBeInTheDocument();
  });
});
