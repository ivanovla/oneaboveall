import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AccountShell from "../src/components/AccountShell";

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "" };
});

describe("AccountShell", () => {
  it("shows a loading state before the session check resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it("redirects to / when the session check returns 401", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("renders the header, nav, and children when signed in", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>account content</div></AccountShell>);
    await waitFor(() => expect(screen.getByText("account content")).toBeInTheDocument());
    expect(screen.getByText("Sign out")).toBeInTheDocument();
    expect(screen.getByText("Auction")).toBeInTheDocument();
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  });

  it("calls fetch with credentials: include for the session check", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/me", { credentials: "include" }));
  });

  it("sign out calls POST /auth/logout with credentials and redirects to /", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ loggedOut: true }) };
      return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(screen.getByText("Sign out")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Sign out"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/logout", { method: "POST", credentials: "include" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });
});
