import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import UserBadge from "../src/components/UserBadge";

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "" };
});

function mockFetch(handlers: { me?: unknown; round?: unknown; participation?: unknown; logoutOk?: boolean }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/auth/logout" && init?.method === "POST") {
      return { ok: handlers.logoutOk ?? true, status: 200, json: async () => ({ loggedOut: true }) };
    }
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

  it("does not throw an unhandled rejection when the poll's fetch itself rejects", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { container } = render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // No badge renders (never got a successful /auth/me), and — the actual
    // point of this test — nothing here throws past a catch, since Vitest
    // fails the run on any unhandled rejection even if every assertion
    // below passes.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an initial-letter badge button when signed in, no round in play", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument();
  });

  it("shows the shaking notification dot when joined but not currently leading", async () => {
    global.fetch = mockFetch({
      me: { id: "u1", email: "a@example.com", name: "Alex" },
      round: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: true, depositCents: 10_000, isLeading: false },
    }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex — action needed" })).toBeInTheDocument());
  });

  it("opens the settings sidebar on click, showing identity and nav links", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    expect(screen.getByRole("dialog", { name: /account settings/i })).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    expect(screen.getByText("Auction")).toHaveAttribute("href", "/account/auction");
    expect(screen.getByText("Leaderboard")).toHaveAttribute("href", "/account/leaderboard");
  });

  it("closes the sidebar via the Close button", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the sidebar on Escape", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sign out (inside the sidebar) POSTs /auth/logout and redirects to /", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    fireEvent.click(screen.getByText("Sign out"));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("http://api.test/auth/logout", { method: "POST", credentials: "include" }),
    );
    await waitFor(() => expect(window.location.href).toBe("/"));
  });
});
