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
    if (path === "/auth/social" && init?.method === "PATCH") {
      return handlers.socialOk === false
        ? { ok: false, status: 400, json: async () => ({ error: handlers.socialError ?? "a valid URL is required" }) }
        : { ok: true, status: 200, json: async () => ({ socialUrl: "https://instagram.com/someone" }) };
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  });
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

  it("rejects an amount that doesn't exceed the current price, without calling any write endpoint", async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "500" } });
    fireEvent.click(screen.getByText("Displace"));

    await waitFor(() => expect(screen.getByText(/must be higher than/i)).toBeInTheDocument());
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/bids"), expect.anything());
  });

  it("submits the bid and mounts the Stripe payment form for the full amount", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByText("Displace"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/bids", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 150_000 }),
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
    fireEvent.click(screen.getByText("Displace"));

    await waitFor(() => expect(screen.getByText("You are already the current leader.")).toBeInTheDocument());
    expect(screen.queryByTestId("payment-element")).not.toBeInTheDocument();
  });
});

describe("BidFlow — payment then photo", () => {
  it("confirms payment, waits for the bid to land, and moves to the photo step", async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByText("Displace"));
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Confirm payment"));

    await waitFor(() => expect(screen.getByText(/send your face/i)).toBeInTheDocument());
  });
});

describe("BidFlow — photo step", () => {
  async function getToPhotoStep(fetchMock: ReturnType<typeof mockFetch>) {
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BidFlow apiBaseUrl="http://api.test" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByText("Displace"));
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
    fireEvent.click(screen.getByText("Displace"));
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
