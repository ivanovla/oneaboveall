import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import HistoryTable from "../src/components/HistoryTable";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HistoryTable", () => {
  it("shows a loading state before the fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<HistoryTable apiBaseUrl="http://api.test" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an empty state with no activity yet", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ history: [] }) })) as unknown as typeof fetch;
    render(<HistoryTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/no activity yet/i)).toBeInTheDocument());
  });

  it("shows an error state when the request fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    render(<HistoryTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/couldn't load your history/i)).toBeInTheDocument());
  });

  it("shows an error state on a network failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    render(<HistoryTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/couldn't load your history/i)).toBeInTheDocument());
  });

  it("renders each round's deposit, status, and bid summary", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        history: [
          {
            roundId: "round-1",
            depositCents: 10_000,
            depositStatus: "applied",
            joinedAt: "2026-01-02T10:00:00.000Z",
            bids: [
              { amountCents: 150_000, placedAt: "2026-01-02T11:00:00.000Z" },
              { amountCents: 130_000, placedAt: "2026-01-02T10:30:00.000Z" },
            ],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    render(<HistoryTable apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(screen.getByText(/won — deposit applied/i)).toBeInTheDocument());
    expect(screen.getByText("$100 deposit")).toBeInTheDocument();
    expect(screen.getByText(/2 bids, highest \$1,500/)).toBeInTheDocument();
  });

  it("picks the highest bid amount, not just the most recent one", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        history: [
          {
            roundId: "round-1",
            depositCents: 10_000,
            depositStatus: "held",
            joinedAt: "2026-01-02T10:00:00.000Z",
            // Deliberately out of amount order — the most recent bid
            // (last in the array) is NOT the highest, so a naive
            // "first/last item" read would report the wrong figure.
            bids: [
              { amountCents: 130_000, placedAt: "2026-01-02T11:00:00.000Z" },
              { amountCents: 150_000, placedAt: "2026-01-02T10:30:00.000Z" },
            ],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    render(<HistoryTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/highest \$1,500/)).toBeInTheDocument());
  });

  it("omits the bid summary line for a round joined but never bid on", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        history: [{ roundId: "round-1", depositCents: 10_000, depositStatus: "held", joinedAt: "2026-01-02T10:00:00.000Z", bids: [] }],
      }),
    })) as unknown as typeof fetch;

    render(<HistoryTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("$100 deposit")).toBeInTheDocument());
    expect(screen.queryByText(/bids, highest/)).not.toBeInTheDocument();
  });
});
