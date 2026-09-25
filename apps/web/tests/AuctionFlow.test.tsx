import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuctionFlow from "../src/components/AuctionFlow";

// The account sidebar's Auction tab renders the real LiveAuction, which
// imports these — same mocks as LiveAuction.test.tsx/UserBadge.test.tsx.
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
// Displace click to the account sidebar) — real Node fetch is global even
// under jsdom, so without a mock every test would fire a real network
// request. Defaults to signed-out (401), matching the common case; tests
// exercising the signed-in path override this per-test.
beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
});

describe("AuctionFlow", () => {
  it("shows the current price and Displace button on the closed screen", () => {
    render(<AuctionFlow />);
    expect(screen.getByText("Displace")).toBeInTheDocument();
    expect(screen.getByText("$4,210")).toBeInTheDocument();
  });

  it("renders the champion price it is given, not the mock constant", () => {
    // index.astro passes the resolved scene's champion price here, so the
    // headline figure can't drift from the price the Scene tooltip shows for
    // the champion rendered directly above it.
    render(<AuctionFlow currentPriceCents={987_600} />);
    expect(screen.getByText("$9,876")).toBeInTheDocument();
    expect(screen.queryByText("$4,210")).not.toBeInTheDocument();
  });

  it("renders a deterministic first countdown frame that ignores the wall clock", () => {
    // The island is server-rendered at build time (client:idle), so the first
    // render must not read Date.now() — otherwise the built HTML disagrees
    // with what the browser computes on hydration. The countdown is measured
    // from the mock snapshot instead, giving the prototype's demo figure
    // regardless of what today's date happens to be.
    // Pinning the clock to the epoch would show a ~500,000-hour countdown if
    // the render read it; the assertion below only holds if it doesn't.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      render(<AuctionFlow />);
      expect(screen.getByText("06:41:12")).toBeInTheDocument();
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
  // bid/deposit flow lives in the account sidebar's Auction tab
  // (LiveAuction.tsx, see UserBadge.tsx) once signed in.
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

  it("opens the account sidebar on the Auction tab for an already-signed-in visitor, instead of the sign-in screen", async () => {
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

    expect(screen.getByRole("dialog", { name: /account settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auction" })).toHaveStyle({ background: "var(--gold)" });
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
