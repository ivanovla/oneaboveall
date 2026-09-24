import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import UserBadge from "../src/components/UserBadge";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(handlers: { me?: unknown; round?: unknown; participation?: unknown }) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/auth/me") {
      return handlers.me === undefined
        ? { ok: false, status: 401 }
        : { ok: true, status: 200, json: async () => handlers.me };
    }
    if (path === "/current-round") {
      return { ok: true, status: 200, json: async () => (handlers.round === undefined ? null : handlers.round) };
    }
    if (path.match(/^\/rounds\/.+\/me$/)) {
      return { ok: true, status: 200, json: async () => handlers.participation };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("UserBadge", () => {
  it("renders nothing when signed out", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    const { container } = render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an initial-letter badge linking to /account when signed in, no round in play", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    expect(screen.getByRole("link")).toHaveAttribute("href", "/account");
  });

  it("falls back to the email's first letter when name is empty", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "zeta@example.com", name: "" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Z")).toBeInTheDocument());
  });

  it("shows no notification dot when the user is currently leading", async () => {
    global.fetch = mockFetch({
      me: { id: "u1", email: "a@example.com", name: "Alex" },
      round: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: true, depositCents: 10_000, isLeading: true },
    }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("link")).toHaveAttribute("aria-label", "Alex"));
  });

  it("shows the shaking notification dot when joined but not currently leading", async () => {
    global.fetch = mockFetch({
      me: { id: "u1", email: "a@example.com", name: "Alex" },
      round: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: true, depositCents: 10_000, isLeading: false },
    }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("link")).toHaveAttribute("aria-label", "Alex — action needed"));
  });

  it("shows no notification dot when the user hasn't joined the current round", async () => {
    global.fetch = mockFetch({
      me: { id: "u1", email: "a@example.com", name: "Alex" },
      round: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("link")).toHaveAttribute("aria-label", "Alex"));
  });
});
