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
    expect(screen.getByText("oneabobeall")).toHaveAttribute("href", "/");
  });

  it("calls fetch with credentials: include for the session check", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/me", { credentials: "include" }));
  });

  it("shows the email-confirm step after a first sign-in (?welcome=1), prefilled with the OAuth email", async () => {
    // @ts-expect-error test override
    window.location = { href: "/account?welcome=1", search: "?welcome=1", pathname: "/account" };
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>account content</div></AccountShell>);

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/email/i)).toHaveValue("a@example.com");
    expect(screen.queryByText("account content")).not.toBeInTheDocument();
  });

  it("submitting the email-confirm step PATCHes /auth/email and then reveals the account content", async () => {
    // @ts-expect-error test override
    window.location = { href: "/account?welcome=1", search: "?welcome=1", pathname: "/account" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ id: "u1", email: "new@example.com", name: "A" }) };
      return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>account content</div></AccountShell>);

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/email", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
    );
    await waitFor(() => expect(screen.getByText("account content")).toBeInTheDocument());
  });

  it("does not show the email-confirm step on an ordinary sign-in (no ?welcome=1)", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>account content</div></AccountShell>);
    await waitFor(() => expect(screen.getByText("account content")).toBeInTheDocument());
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
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
