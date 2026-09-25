import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PhotoUploader from "../src/components/PhotoUploader";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(handlers: { ok?: boolean; error?: string; photoPath?: string; status?: number }) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    handlers.ok === false
      ? { ok: false, status: handlers.status ?? 400, json: async () => ({ error: handlers.error ?? "upload failed" }) }
      : { ok: true, status: 200, json: async () => ({ photoPath: handlers.photoPath ?? "u1.jpg" }) },
  );
}

describe("PhotoUploader", () => {
  it("shows a placeholder dropzone and no submit button when there's no photo yet", () => {
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} />);
    expect(screen.getByText(/click to choose a photo/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("previews the existing photo instead of the placeholder when hasPhoto is true", () => {
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={true} />);
    expect(screen.queryByText(/click to choose a photo/i)).not.toBeInTheDocument();
    // The preview <img> has no accessible role (empty alt) — read it directly.
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe("http://api.test/photos/u1?v=0");
  });

  it("choosing a file shows a preview and reveals the submit button", () => {
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} />);
    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });

    expect(screen.getByText(/new photo selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save photo" })).toBeInTheDocument();
  });

  it("uploads the chosen file as multipart form data, with no manually-set content-type header", async () => {
    const fetchMock = mockFetch({ photoPath: "u1.jpg" });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} />);

    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/auth/photo",
        expect.objectContaining({ method: "POST", credentials: "include", body: expect.any(FormData) }),
      ),
    );
    const call = fetchMock.mock.calls[0];
    expect(call[1]?.headers).toBeUndefined();
  });

  it("calls onUploaded with the new photoPath and clears the pending selection on success", async () => {
    global.fetch = mockFetch({ photoPath: "u1.png" }) as unknown as typeof fetch;
    const onUploaded = vi.fn();
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} onUploaded={onUploaded} />);

    const file = new File(["fake-bytes"], "selfie.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("u1.png"));
    // The submit button disappears again — nothing pending to (re-)submit.
    expect(screen.queryByRole("button", { name: "Save photo" })).not.toBeInTheDocument();
  });

  it("shows the server's rejection reason and keeps the selection so the user can retry", async () => {
    global.fetch = mockFetch({ ok: false, error: "only JPEG, PNG, or WebP images are accepted" }) as unknown as typeof fetch;
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} />);

    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() => expect(screen.getByText("only JPEG, PNG, or WebP images are accepted")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save photo" })).toBeInTheDocument();
  });

  it("calls onUnauthorized instead of showing an error on a 401", async () => {
    global.fetch = mockFetch({ ok: false, status: 401 }) as unknown as typeof fetch;
    const onUnauthorized = vi.fn();
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} onUnauthorized={onUnauthorized} />);

    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it("uses a custom submit label when given one", () => {
    render(<PhotoUploader apiBaseUrl="http://api.test" userId="u1" hasPhoto={false} submitLabel="Upload photo" />);
    const file = new File(["fake-bytes"], "selfie.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: [file] } });
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeInTheDocument();
  });
});
