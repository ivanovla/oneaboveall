import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ViewCounter from "../src/components/ViewCounter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ViewCounter", () => {
  it("shows the floor of 211 before the fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<ViewCounter apiBaseUrl="http://api.test" />);
    expect(screen.getByRole("status", { name: /page views/i })).toHaveTextContent("211 views");
  });

  it("shows the real count once it's above the floor", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ count: 5_432 }) })) as unknown as typeof fetch;
    render(<ViewCounter apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("status", { name: /page views/i })).toHaveTextContent("5,432 views"));
  });

  it("never displays below 211, even when the real count is lower", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ count: 7 }) })) as unknown as typeof fetch;
    render(<ViewCounter apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.getByRole("status", { name: /page views/i })).toHaveTextContent("211 views");
  });

  it("posts to /page-views exactly once on mount", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ count: 300 }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ViewCounter apiBaseUrl="http://api.test" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/page-views", { method: "POST" });
  });

  it("falls back to the floor, without throwing, when the fetch fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    render(<ViewCounter apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByRole("status", { name: /page views/i })).toHaveTextContent("211 views"));
  });
});
