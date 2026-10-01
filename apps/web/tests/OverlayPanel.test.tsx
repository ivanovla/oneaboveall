import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import OverlayPanel, { overlayCountdownLabel } from "../src/components/OverlayPanel";

function mockRound(round: unknown) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => round })) as unknown as typeof fetch;
}

const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60 * 1000 + 30_000).toISOString();

const ROUND = {
  roundId: "r1",
  phase: "bidding",
  currentLeaderCents: 250_000,
  leader: { name: "Alice", sponsored: false },
  champion: { name: "Rita", sponsored: true },
  recentBids: [
    { name: "Alice", amountCents: 250_000, placedAt: "2026-10-02T10:02:00Z" },
    { name: "Bob", amountCents: 200_000, placedAt: "2026-10-02T10:01:00Z" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("overlayCountdownLabel", () => {
  it("counts down, then announces the close", () => {
    expect(overlayCountdownLabel(3_661_000, 0)).toBe("01:01:01");
    expect(overlayCountdownLabel(1000, 1000)).toBe("Bidding closed — new champion at ~7 PM ET");
  });
});

describe("OverlayPanel", () => {
  it("polls /current-round without credentials and shows site, champion, price, leader and countdown", async () => {
    mockRound({ ...ROUND, biddingClosesAt: inTwoHours() });
    render(<OverlayPanel apiBaseUrl="http://api.test" compact={false} />);

    await waitFor(() => expect(screen.getByText("Rita")).toBeInTheDocument());
    // Once as the headline price, once in the feed (Alice's top bid).
    expect(screen.getAllByText("$2,500")).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith("http://api.test/current-round");
    expect(screen.getByText("oneaboveall.org")).toBeInTheDocument();
    expect(screen.getByText("Rita")).toBeInTheDocument();
    expect(screen.getByText("Sponsored")).toBeInTheDocument(); // the champion
    expect(screen.getByText(/^0[12]:(59|00):\d\d$/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Recent bids" })).toHaveTextContent("Bob");
  });

  it("hides the bid feed in compact mode", async () => {
    mockRound({ ...ROUND, biddingClosesAt: inTwoHours() });
    render(<OverlayPanel apiBaseUrl="http://api.test" compact />);
    await waitFor(() => expect(screen.getByText("$2,500")).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "Recent bids" })).not.toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("reads compact mode from ?compact=1", async () => {
    window.history.replaceState(null, "", "/overlay?compact=1");
    mockRound({ ...ROUND, biddingClosesAt: inTwoHours() });
    render(<OverlayPanel apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("$2,500")).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "Recent bids" })).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("shows 'No bids yet' and the closed message after the close", async () => {
    mockRound({ ...ROUND, leader: null, recentBids: [], biddingClosesAt: new Date(Date.now() - 1000).toISOString() });
    render(<OverlayPanel apiBaseUrl="http://api.test" compact={false} />);
    await waitFor(() => expect(screen.getByText("No bids yet")).toBeInTheDocument());
    expect(screen.getByText("Bidding closed — new champion at ~7 PM ET")).toBeInTheDocument();
  });
});
