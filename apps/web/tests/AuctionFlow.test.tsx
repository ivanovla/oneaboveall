import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AuctionFlow from "../src/components/AuctionFlow";

describe("AuctionFlow", () => {
  it("shows the current price and Displace button on the closed screen", () => {
    render(<AuctionFlow />);
    expect(screen.getByText("Displace")).toBeInTheDocument();
    expect(screen.getByText("$4,210")).toBeInTheDocument();
  });

  it("renders the champion price it is given, not the mock constant", () => {
    // index.astro passes the resolved scene's champion price here, so the
    // headline figure can't drift from the price the Scene tooltip shows for
    // the champion rendered directly above it.
    render(<AuctionFlow currentPriceCents={987_600} />);
    expect(screen.getByText("$9,876")).toBeInTheDocument();
    expect(screen.queryByText("$4,210")).not.toBeInTheDocument();

    // ...and every figure derived from the price follows it: the minimum, the
    // prefilled bid, and the deposit computed from that bid.
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    expect(screen.getByText("$9,877")).toBeInTheDocument(); // "Minimum" box
    expect(screen.getByLabelText(/your bid/i)).toHaveValue("9877");
    expect(screen.getByText("$988")).toBeInTheDocument(); // 10% deposit, rounded
  });

  it("renders a deterministic first countdown frame that ignores the wall clock", () => {
    // The island is server-rendered at build time (client:idle), so the first
    // render must not read Date.now() — otherwise the built HTML disagrees
    // with what the browser computes on hydration. Both countdowns are
    // measured from the mock snapshot instead, giving the prototype's demo
    // figures regardless of what today's date happens to be.
    // Pinning the clock to the epoch would show a ~500,000-hour countdown if
    // the render read it; the assertion below only holds if it doesn't.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      render(<AuctionFlow />);
      expect(screen.getByText("06:41:12")).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shows the payment window countdown from the fixed mock timestamp", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    expect(screen.getByText("03:12:00")).toBeInTheDocument();
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

describe("AuctionFlow — bid input sanitisation", () => {
  function openBidScreen() {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    return screen.getByLabelText(/your bid/i);
  }

  it("prefills the bid with one increment above the current price", () => {
    const bidInput = openBidScreen();
    // $4,210 current price + the $1 minimum increment.
    expect(bidInput).toHaveValue("4211");
    expect(screen.getByText("$4,211")).toBeInTheDocument(); // "Minimum" box
    expect(screen.getByText("$421")).toBeInTheDocument(); // 10% deposit
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("ignores separators, so a comma-typed bid matches the same bare digits", () => {
    const bidInput = openBidScreen();
    fireEvent.change(bidInput, { target: { value: "5,000" } });
    // The field itself echoes exactly what was typed...
    expect(bidInput).toHaveValue("5,000");
    // ...while every derived figure is computed from the cleaned digits.
    expect(screen.getByText("$500")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();

    fireEvent.change(bidInput, { target: { value: "5000" } });
    expect(screen.getByText("$500")).toBeInTheDocument();
  });

  it("never renders NaN for unparseable input", () => {
    const bidInput = openBidScreen();
    for (const junk of ["", "abc", "$", "1 2,3.4"]) {
      fireEvent.change(bidInput, { target: { value: junk } });
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    }
  });

  it("floors a below-minimum bid at the minimum on every downstream screen", () => {
    const bidInput = openBidScreen();
    fireEvent.change(bidInput, { target: { value: "100" } });
    expect(screen.getByText("$421")).toBeInTheDocument(); // deposit, not $10

    fireEvent.click(screen.getByText("Place deposit"));
    expect(screen.getByText("Bid $4,211 accepted")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/continue/i));
    expect(screen.getByText("$3,790")).toBeInTheDocument(); // 4,211 - 421
  });

  it("carries a comma-typed bid through to the pay screen unchanged", () => {
    const bidInput = openBidScreen();
    fireEvent.change(bidInput, { target: { value: "10,000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    expect(screen.getByText("Bid $10,000 accepted")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/continue/i));
    expect(screen.getByText("$9,000")).toBeInTheDocument(); // same as bare "10000"
  });
});

describe("AuctionFlow — theme toggle", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it("flips data-theme on <html> and relabels itself", () => {
    render(<AuctionFlow />);
    const toggle = screen.getByRole("button", { name: /switch to light theme/i });
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("oneabobeall:theme")).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("oneabobeall:theme")).toBe("dark");
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
