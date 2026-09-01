import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AuctionFlow from "../src/components/AuctionFlow";

describe("AuctionFlow", () => {
  it("shows the current price and Displace button on the closed screen", () => {
    render(<AuctionFlow />);
    expect(screen.getByText("Displace")).toBeInTheDocument();
    expect(screen.getByText("$4,210")).toBeInTheDocument();
  });

  it("opens the auth screen when Displace is clicked", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument();
  });

  it("moves from auth to the bid screen on sign-in", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    expect(screen.getByText("Your bid")).toBeInTheDocument();
  });

  it("computes the deposit as 10% of the entered bid", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    const bidInput = screen.getByLabelText(/your bid/i);
    fireEvent.change(bidInput, { target: { value: "10000" } });
    expect(screen.getByText("$1,000")).toBeInTheDocument();
  });

  it("moves to the lead screen after placing a deposit", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    expect(screen.getByText("You're first in line")).toBeInTheDocument();
  });
});
