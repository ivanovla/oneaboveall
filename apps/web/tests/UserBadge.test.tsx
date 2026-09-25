import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import UserBadge from "../src/components/UserBadge";

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "", search: "", pathname: "/" };
});

function mockFetch(handlers: {
  me?: unknown;
  round?: unknown;
  participation?: unknown;
  history?: unknown[];
  logoutOk?: boolean;
  patchEmailOk?: boolean;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/auth/logout" && init?.method === "POST") {
      return { ok: handlers.logoutOk ?? true, status: 200, json: async () => ({ loggedOut: true }) };
    }
    if (path === "/auth/email" && init?.method === "PATCH") {
      return handlers.patchEmailOk === false
        ? { ok: false, status: 400, json: async () => ({ error: "a valid email is required" }) }
        : { ok: true, status: 200, json: async () => ({ id: "u1", email: "new@example.com", name: "Alex" }) };
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
    if (path === "/me/history") {
      return { ok: true, status: 200, json: async () => ({ history: handlers.history ?? [] }) };
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

  it("opens the settings sidebar on click, showing identity and the real history", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    expect(screen.getByRole("dialog", { name: /account settings/i })).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    // HistoryTable's own empty-state copy — confirms the real component is
    // embedded, not a link out to a page.
    await waitFor(() => expect(screen.getByText(/no activity yet/i)).toBeInTheDocument());
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

describe("UserBadge — post-signup email confirmation", () => {
  it("forces the email-confirm step open when the URL carries ?welcome=1, prefilled with the OAuth email", async () => {
    // @ts-expect-error test override
    window.location = { href: "/?welcome=1", search: "?welcome=1", pathname: "/" };
    global.fetch = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/email/i)).toHaveValue("a@example.com");
    // Forced open — no Close/Settings header, no way to dismiss without submitting.
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("submitting the email-confirm step PATCHes /auth/email and then reveals the normal sidebar", async () => {
    // @ts-expect-error test override
    window.location = { href: "/?welcome=1", search: "?welcome=1", pathname: "/" };
    global.fetch = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("http://api.test/auth/email", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
    );
    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/no activity yet/i)).toBeInTheDocument());
  });

  it("does not show the email-confirm step on an ordinary sign-in (no ?welcome=1)", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });
});
