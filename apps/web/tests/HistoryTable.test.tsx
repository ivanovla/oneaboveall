import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import HistoryTable from "../src/components/HistoryTable";

describe("HistoryTable", () => {
  it("shows a loading state", () => {
    render(<HistoryTable status="loading" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state", () => {
    render(<HistoryTable status="error" />);
    expect(screen.getByText(/couldn't load your history/i)).toBeInTheDocument();
  });

  it("shows an empty state with no activity yet", () => {
    render(<HistoryTable status={{ entries: [] }} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it("renders a won bid", () => {
    render(
      <HistoryTable
        status={{
          entries: [
            {
              roundId: "round-1",
              bids: [{ amountCents: 150_000, placedAt: "2026-01-02T11:00:00.000Z", status: "won" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Won")).toBeInTheDocument();
    expect(screen.getByText("$1,500")).toBeInTheDocument();
  });

  it("renders every one of the bidder's own bids in a round, most recent first", () => {
    render(
      <HistoryTable
        status={{
          entries: [
            {
              roundId: "round-1",
              bids: [
                { amountCents: 150_000, placedAt: "2026-01-02T11:00:00.000Z", status: "active" },
                { amountCents: 130_000, placedAt: "2026-01-02T10:00:00.000Z", status: "refunded" },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Leading")).toBeInTheDocument();
    expect(screen.getByText("$1,500")).toBeInTheDocument();
    expect(screen.getByText("Released")).toBeInTheDocument();
    expect(screen.getByText("$1,300")).toBeInTheDocument();
  });
});
