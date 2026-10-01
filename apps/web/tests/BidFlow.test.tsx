import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import BidFlow from "../src/components/BidFlow";

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
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "" };
});

const ROUND = { roundId: "round-1", phase: "bidding" as const, currentLeaderCents: 100_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" };

function mockFetch(handlers: {
  round?: unknown;
  isLeading?: boolean;
  bidOk?: boolean;
  bidError?: string;
  clientSecret?: string;
  photoOk?: boolean;
  photoError?: string;
  socialOk?: boolean;
  socialError?: string;
  nameOk?: boolean;
}) {
  // Mutable, not just the initial `handlers.isLeading` — a successful
  // POST /bids flips this, the same way the real webhook-driven bid
  // eventually does, so PaymentStep's post-payment poll of /rounds/:id/me
  // has something real to observe rather than looping until it gives up.
  let isLeading = !!handlers.isLeading;

  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/auth/me") {
      return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A", photoPath: null, characterRequest: null }) };
    }
    if (path === "/current-round") return { ok: true, status: 200, json: async () => (handlers.round === undefined ? ROUND : handlers.round) };
    if (path.match(/^\/rounds\/.+\/me$/)) return { ok: true, status: 200, json: async () => ({ isLeading }) };
    if (path === "/bids" && init?.method === "POST") {
      if (handlers.bidOk === false) {
        return { ok: false, status: 422, json: async () => ({ error: handlers.bidError ?? "Bid rejected." }) };
      }
      isLeading = true;
      return { ok: true, status: 200, json: async () => ({ clientSecret: handlers.clientSecret ?? "pi_1_secret" }) };
    }
    if (path === "/auth/photo" && init?.method === "POST") {
      return handlers.photoOk === false
        ? { ok: false, status: 400, json: async () => ({ error: handlers.photoError ?? "only images are accepted" }) }
        : { ok: true, status: 200, json: async () => ({ photoPath: "u1.jpg" }) };
    }
    if (path === "/auth/character-request" && init?.method === "PATCH") {
      return { ok: true, status: 200, json: async () => ({ characterRequest: null }) };
    }
    if (path === "/auth/name" && init?.method === "PATCH") {
      return handlers.nameOk === false
        ? { ok: false, status: 400, json: async () => ({ error: "a name between 1 and 80 characters is required" }) }
        : { ok: true, status: 200, json: async () => ({ id: "u1", name: JSON.parse(init.body as string).name }) };
    }
    if (path === "/auth/social" && init?.method === "PATCH") {
      return handlers.socialOk === false
        ? { ok: false, status: 400, json: async () => ({ error: handlers.socialError ?? "a valid URL is required" }) }
        : { ok: true, status: 200, json: async () => ({ socialUrl: "https://instagram.com/someone" }) };
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  });
}

// The amount step's required 18+/Terms/withdrawal-waiver checkbox must be
// ticked before Displace does anything.
function acceptTermsAndDisplace() {
  fireEvent.click(screen.getByLabelText(/I'm 18 or older/i));
  fireEvent.click(screen.getByText("Displace"));
}

describe("BidFlow — loading and empty states", () => {
  it("shows a loading state before the first fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows a no-active-round state, not a stuck loading spinner, when there's genuinely no round", async () => {
    global.fetch = mockFetch({ round: null }) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no active round right now/i)).toBeInTheDocument());
  });
});

describe("BidFlow — already leading", () => {
  it("shows a message and no amount input when this bidder is already the current leader", async () => {
    global.fetch = mockFetch({ isLeading: true }) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/you're already leading/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/your bid/i)).not.toBeInTheDocument();
  });
});

describe("BidFlow — amount step", () => {
  it("prefills the bid one dollar above the current leader", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toHaveValue("1001"));
  });

  it("explains that the card is only authorized, and charged only if the bid wins", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    expect(
      screen.getByText(
        "Your card is only authorized now — you're charged only if you hold the top bid when bidding closes at 4 PM ET. If you're outbid, the hold is released.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/charged in full now/i)).not.toBeInTheDocument();
  });

  it("rejects an amount that doesn't exceed the current price, without calling any write endpoint", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "500" } });
    acceptTermsAndDisplace();

    await waitFor(() => expect(screen.getByText(/must be higher than/i)).toBeInTheDocument());
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/bids"), expect.anything());
  });

  it("submits the bid and mounts the Stripe payment form for the full amount", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/bids", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 150_000, acceptedTerms: true }),
      }),
    );
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
    expect(screen.getByText("$1,500")).toBeInTheDocument();
  });

  it("shows the server's rejection reason instead of mounting a payment form", async () => {
    global.fetch = mockFetch({ bidOk: false, bidError: "You are already the current leader." }) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();

    await waitFor(() => expect(screen.getByText("You are already the current leader.")).toBeInTheDocument());
    expect(screen.queryByTestId("payment-element")).not.toBeInTheDocument();
  });
});

describe("BidFlow — terms consent", () => {
  it("keeps Displace disabled until the 18+/Terms box is ticked, and links the Terms", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    const checkbox = screen.getByLabelText(/I'm 18 or older/i);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/lose my right of withdrawal once I win the seat/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");

    const displace = screen.getByText("Displace");
    expect(displace).toBeDisabled();
    fireEvent.click(displace);
    expect(fetchMock).not.toHaveBeenCalledWith("http://api.test/bids", expect.anything());

    fireEvent.click(checkbox);
    expect(displace).not.toBeDisabled();
  });
});

describe("BidFlow — public display name", () => {
  it("tells the bidder which name is shown publicly while they lead", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/shown publicly as/i)).toBeInTheDocument());
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("lets them change it inline via PATCH /auth/name", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("change")).toBeInTheDocument());

    fireEvent.click(screen.getByText("change"));
    fireEvent.change(screen.getByLabelText(/public display name/i), { target: { value: "  Night Owl " } });
    fireEvent.click(screen.getByText("Save name"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/name", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Night Owl" }),
      }),
    );
    await waitFor(() => expect(screen.getByText("Night Owl")).toBeInTheDocument());
    expect(screen.queryByLabelText(/public display name/i)).not.toBeInTheDocument();
  });

  it("rejects an empty name without calling the API", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("change")).toBeInTheDocument());
    fireEvent.click(screen.getByText("change"));
    fireEvent.change(screen.getByLabelText(/public display name/i), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save name"));
    expect(screen.getByText(/Use 1–80 characters/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("http://api.test/auth/name", expect.anything());
  });
});

describe("BidFlow — payment then photo", () => {
  it("confirms payment, waits for the bid to land, and moves to the photo step", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Confirm payment"));

    await waitFor(() => expect(screen.getByText(/send your face/i)).toBeInTheDocument());
  });
});

describe("BidFlow — status check fails after the card is authorized", () => {
  it("says the card was authorized (not charged) and that a bid that didn't land in time has its hold released automatically", async () => {
    const base = mockFetch({});
    // The status endpoint works for the initial load and only fails once
    // the bid has been submitted — i.e. for the post-payment poll.
    let bidSubmitted = false;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/bids") bidSubmitted = true;
      if (bidSubmitted && path.match(/^\/rounds\/.+\/me$/)) throw new Error("network down");
      return base(url, init);
    }) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Confirm payment"));

    await waitFor(() => expect(screen.getByText(/your card was authorized/i)).toBeInTheDocument());
    expect(screen.getByText(/hold is released automatically/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment went through/i)).not.toBeInTheDocument();
  });
});

describe("BidFlow — photo step", () => {
  async function getToPhotoStep(fetchMock: ReturnType<typeof mockFetch>) {
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Confirm payment"));
    await waitFor(() => expect(screen.getByText(/send your face/i)).toBeInTheDocument());
  }

  it("shows no submit button until a file is chosen", async () => {
    await getToPhotoStep(mockFetch({}));
    expect(screen.queryByText("Upload photo")).not.toBeInTheDocument();
  });

  it("uploads the chosen file as multipart form data and moves to the social step", async () => {
    const fetchMock = mockFetch({});
    await getToPhotoStep(fetchMock);

    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Photo"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Upload photo"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/auth/photo",
        expect.objectContaining({ method: "POST", credentials: "include", body: expect.any(FormData) }),
      ),
    );
    // No content-type header set by hand — the browser must supply its own
    // multipart boundary, which a manually-set header would break.
    const call = fetchMock.mock.calls.find(([url]) => url === "http://api.test/auth/photo");
    expect(call?.[1]?.headers).toBeUndefined();

    await waitFor(() => expect(screen.getByText(/attach social media/i)).toBeInTheDocument());
  });

  it("shows the server's rejection reason for a bad file", async () => {
    await getToPhotoStep(mockFetch({ photoOk: false, photoError: "only JPEG, PNG, or WebP images are accepted" }));

    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Photo"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Upload photo"));

    await waitFor(() => expect(screen.getByText("only JPEG, PNG, or WebP images are accepted")).toBeInTheDocument());
  });
});

describe("BidFlow — social step (optional)", () => {
  async function getToSocialStep(fetchMock: ReturnType<typeof mockFetch>, onDone: () => void) {
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={onDone} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    acceptTermsAndDisplace();
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Confirm payment"));
    await waitFor(() => expect(screen.getByLabelText("Photo")).toBeInTheDocument());
    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Photo"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Upload photo"));
    await waitFor(() => expect(screen.getByLabelText(/social media link/i)).toBeInTheDocument());
  }

  it("saves a provided social media link and finishes", async () => {
    const fetchMock = mockFetch({});
    const onDone = vi.fn();
    await getToSocialStep(fetchMock, onDone);

    fireEvent.change(screen.getByLabelText(/social media link/i), { target: { value: "https://instagram.com/someone" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/social", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socialUrl: "https://instagram.com/someone" }),
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("Skip finishes without calling /auth/social at all", async () => {
    const fetchMock = mockFetch({});
    const onDone = vi.fn();
    await getToSocialStep(fetchMock, onDone);

    fireEvent.click(screen.getByText("Skip"));

    expect(onDone).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/auth/social"), expect.anything());
  });
});
