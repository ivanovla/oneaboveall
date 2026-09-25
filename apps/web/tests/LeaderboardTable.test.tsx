import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import LeaderboardTable from "../src/components/LeaderboardTable";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LeaderboardTable", () => {
  it("shows a loading state before the fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<LeaderboardTable apiBaseUrl="http://api.test" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the fetched rows, adapted the same way the homepage overlay does", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { occupantId: "mark-vilensky", occupantName: "Mark Vilensky", rounds: 4, totalSpentCents: 250_000, totalDurationMs: 6 * 24 * 60 * 60 * 1000 },
        { occupantId: "osei-adjei", occupantName: "Osei Adjei", rounds: 2, totalSpentCents: 90_000, totalDurationMs: 3 * 24 * 60 * 60 * 1000 },
      ],
    })) as unknown as typeof fetch;

    render(<LeaderboardTable apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(screen.getByText("Mark Vilensky")).toBeInTheDocument());
    expect(screen.getByText("Osei Adjei")).toBeInTheDocument();
    expect(screen.getByText("$2,500")).toBeInTheDocument();
    expect(screen.getByText("4 rounds")).toBeInTheDocument();
    expect(screen.getByText("2 rounds")).toBeInTheDocument();
  });

  it("falls back to the raw occupantId when occupantName is missing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{ occupantId: "raw-id-123", rounds: 1, totalSpentCents: 10_000, totalDurationMs: 24 * 60 * 60 * 1000 }],
    })) as unknown as typeof fetch;

    render(<LeaderboardTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("raw-id-123")).toBeInTheDocument());
    expect(screen.getByText("1 round")).toBeInTheDocument();
  });

  it("shows an empty state with no completed reigns", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    render(<LeaderboardTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/no completed reigns/i)).toBeInTheDocument());
  });

  it("shows an error state when the request fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    render(<LeaderboardTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/couldn't load the leaderboard/i)).toBeInTheDocument());
  });

  it("shows an error state on a network failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    render(<LeaderboardTable apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/couldn't load the leaderboard/i)).toBeInTheDocument());
  });
});
