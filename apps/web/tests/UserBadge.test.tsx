import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
  history?: unknown[];
  logoutOk?: boolean;
  patchEmailOk?: boolean;
  patchNameOk?: boolean;
  photoOk?: boolean;
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
    if (path === "/auth/name" && init?.method === "PATCH") {
      const submittedName = JSON.parse(String(init?.body)).name;
      return handlers.patchNameOk === false
        ? { ok: false, status: 400, json: async () => ({ error: "a name between 1 and 80 characters is required" }) }
        : { ok: true, status: 200, json: async () => ({ id: "u1", name: submittedName }) };
    }
    if (path === "/auth/social" && init?.method === "PATCH") {
      return { ok: true, status: 200, json: async () => ({ socialUrl: "https://instagram.com/someone" }) };
    }
    if (path === "/auth/character-request" && init?.method === "PATCH") {
      return { ok: true, status: 200, json: async () => ({ characterRequest: null }) };
    }
    if (path === "/auth/photo" && init?.method === "POST") {
      return handlers.photoOk === false
        ? { ok: false, status: 400, json: async () => ({ error: "only images are accepted" }) }
        : { ok: true, status: 200, json: async () => ({ photoPath: "u1.jpg" }) };
    }
    if (path === "/auth/me") {
      return handlers.me === undefined
        ? { ok: false, status: 401 }
        : { ok: true, status: 200, json: async () => handlers.me };
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

  it("does not throw when the session check's fetch itself rejects", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { container } = render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an initial-letter badge button when signed in", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument();
  });

  it("checks the session exactly once — no repeated polling", async () => {
    const fetchMock = mockFetch({ me: { id: "u1", email: "a@example.com", name: "Alex" } });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());

    const callsAfterMount = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
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

  it("gates the Photo section behind having placed a bid — no upload control without one", async () => {
    // Default mock history is empty — this bidder has never paid.
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex", photoPath: null } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    expect(screen.getByText("Photo")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/available once you've placed a bid/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/photo/i)).not.toBeInTheDocument();
  });

  it("shows the upload control once the bidder has a paid bid on record, whether or not a photo is already on file", async () => {
    global.fetch = mockFetch({
      me: { id: "u1", email: "alex@example.com", name: "Alex", photoPath: null },
      history: [{ roundId: "r1", bids: [{ amountCents: 11_000, placedAt: new Date().toISOString(), status: "active" }] }],
    }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    await waitFor(() => expect(screen.getByLabelText(/photo/i)).toBeInTheDocument());
    // No native file-input chrome visible — it's an invisible input layered
    // over a styled dropzone.
    expect(screen.getByText(/click to choose a photo/i)).toBeInTheDocument();
  });

  it("uploading a new photo from the sidebar POSTs /auth/photo and confirms it saved", async () => {
    const fetchMock = mockFetch({
      me: { id: "u1", email: "alex@example.com", name: "Alex", photoPath: null },
      history: [{ roundId: "r1", bids: [{ amountCents: 11_000, placedAt: new Date().toISOString(), status: "active" }] }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));
    await waitFor(() => expect(screen.getByLabelText(/photo/i)).toBeInTheDocument());

    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByText("Save photo"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/auth/photo",
        expect.objectContaining({ method: "POST", credentials: "include", body: expect.any(FormData) }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Photo saved.")).toBeInTheDocument());
  });

  it("always shows the Shown name editor, prefilled with the current name", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    expect(screen.getByText("Shown name")).toBeInTheDocument();
    expect(screen.getByLabelText(/shown name/i)).toHaveValue("Alex");
  });

  it("saving the shown name PATCHes /auth/name, confirms it saved, and updates the header", async () => {
    const fetchMock = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" } });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    const nameInput = screen.getByLabelText(/shown name/i);
    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.click(within(nameInput.parentElement!).getByText("Save"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/name", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      }),
    );
    await waitFor(() => expect(within(nameInput.parentElement!).getByText("Saved.")).toBeInTheDocument());
    // The sidebar's own header (the big display name above the fields) picks
    // up the change too, not just the field itself.
    await waitFor(() => expect(screen.getByText("New Name")).toBeInTheDocument());
  });

  it("shows the server's rejection reason for the shown name without touching the header", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex" }, patchNameOk: false }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    const nameInput = screen.getByLabelText(/shown name/i);
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.click(within(nameInput.parentElement!).getByText("Save"));

    await waitFor(() =>
      expect(within(nameInput.parentElement!).getByText("a name between 1 and 80 characters is required")).toBeInTheDocument(),
    );
  });

  it("always shows the Social media link editor, regardless of paid status, prefilled with the current value", async () => {
    global.fetch = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex", socialUrl: "https://x.com/alex" } }) as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    expect(screen.getByText("Social media link")).toBeInTheDocument();
    expect(screen.getByLabelText(/social media link/i)).toHaveValue("https://x.com/alex");
  });

  it("saving the social media link PATCHes /auth/social and confirms it saved", async () => {
    const fetchMock = mockFetch({ me: { id: "u1", email: "alex@example.com", name: "Alex", socialUrl: null } });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<UserBadge apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alex" }));

    const socialInput = screen.getByLabelText(/social media link/i);
    fireEvent.change(socialInput, { target: { value: "https://instagram.com/someone" } });
    // Scoped: NameEditor's own field also has a "Save" button.
    fireEvent.click(within(socialInput.parentElement!).getByText("Save"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/social", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socialUrl: "https://instagram.com/someone" }),
      }),
    );
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
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
    expect(screen.getByLabelText(/shown name/i)).toHaveValue("Alex");
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
    fireEvent.change(screen.getByLabelText(/shown name/i), { target: { value: "New Name" } });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("http://api.test/auth/email", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith("http://api.test/auth/name", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
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
