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

describe("AuctionFlow — remaining screens", () => {
  it("moves from lead to the pay screen with the remaining balance", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    expect(screen.getByText("Remaining balance due")).toBeInTheDocument();
    expect(screen.getByText("$9,000")).toBeInTheDocument(); // 10,000 - 1,000 deposit
  });

  it("moves from pay to the upload screen, gating submit on consent", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    fireEvent.click(screen.getByText(/^Pay /));
    expect(screen.getByText("Send your face")).toBeInTheDocument();
    const submit = screen.getByText("Submit");
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByText(/I agree to have my photo published/));
    expect(submit).not.toBeDisabled();
  });

  it("moves from upload to the pending screen on submit", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    fireEvent.click(screen.getByText(/^Pay /));
    fireEvent.click(screen.getByText(/I agree to have my photo published/));
    fireEvent.click(screen.getByText("Submit"));
    expect(screen.getByText("The scene is updating")).toBeInTheDocument();
  });

  it("shows the missed-payment screen with forfeiture details", () => {
    render(<AuctionFlow initialScreen="missed" />);
    expect(screen.getByText("The seat moved to the next in line")).toBeInTheDocument();
    expect(screen.getByText(/forfeited/)).toBeInTheDocument();
    expect(screen.getByText(/3-round pause/)).toBeInTheDocument();
  });

  it("opens the leaderboard from the closed screen and lists every mock row", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Leaderboard"));
    expect(screen.getByText("Who held the seat the longest")).toBeInTheDocument();
    for (const row of [
      "Mark Vilensky",
      "Osei Adjei",
      "Daniel Crowe",
      "Felix Lang",
      "Y. Kimura",
      "Arthur Lemeshev",
      "Timur Aslanov",
      "Paul Renier",
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
  });
});
