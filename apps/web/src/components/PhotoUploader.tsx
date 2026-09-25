import { useEffect, useState } from "react";

const MIME_ACCEPT = "image/jpeg,image/png,image/webp";

const dropzoneStyle: React.CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  maxWidth: 220,
  aspectRatio: "1 / 1",
  marginTop: 16,
  border: "1px dashed var(--gold-soft)",
  background: "var(--panel-2)",
  overflow: "hidden",
  cursor: "pointer",
};

const hiddenInputStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  opacity: 0,
  cursor: "pointer",
};

const previewImgStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

const previewOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "flex-end",
  padding: 10,
  background: "linear-gradient(to top, rgba(0,0,0,.6), transparent 60%)",
  color: "#f0e7d6",
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  pointerEvents: "none",
};

const placeholderStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--fg-faint)",
  textAlign: "center",
  padding: 16,
};

const submitButtonStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 220,
  marginTop: 14,
  padding: 14,
  background: "var(--gold)",
  color: "var(--btn-fg)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".24em",
  textTransform: "uppercase",
};

const instructionsStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--fg-faint)",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 16,
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const textareaStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: 320,
  marginTop: 8,
  padding: "12px 14px",
  background: "transparent",
  border: "1px solid var(--gold-soft)",
  color: "var(--fg)",
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.5,
  resize: "vertical",
};

function CameraIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.4l.9-1.5A1.5 1.5 0 0 1 10.1 4.7h3.8a1.5 1.5 0 0 1 1.3.75L16.1 7h2.4A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

/**
 * A styled photo picker + uploader: a dashed dropzone (a native `<input
 * type="file">` sits invisibly on top of it, so the click target and
 * keyboard/screen-reader behavior stay native, but nothing renders the
 * browser's own file-picker widget) that previews either the photo already
 * on file (`GET /photos/:userId`) or the newly chosen one, and a submit
 * button that POSTs it to `/auth/photo`. Alongside the photo, an optional
 * freeform "how should your character look" description is saved to
 * `PATCH /auth/character-request` in the same submit.
 *
 * Deliberately self-contained — both the mandatory photo step in the
 * Displace flow (BidFlow.tsx) and the always-available "change your photo"
 * control in the account sidebar (UserBadge.tsx) embed this same component,
 * so the upload UI and behavior never drift apart between the two.
 */
export default function PhotoUploader({
  apiBaseUrl,
  userId,
  hasPhoto,
  onUploaded,
  submitLabel = "Save photo",
  onUnauthorized,
  initialCharacterRequest = "",
}: {
  apiBaseUrl: string;
  userId: string;
  hasPhoto: boolean;
  onUploaded?: (photoPath: string) => void;
  submitLabel?: string;
  onUnauthorized?: () => void;
  initialCharacterRequest?: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [existingPhotoOk, setExistingPhotoOk] = useState(hasPhoto);
  const [cacheBust, setCacheBust] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [characterRequest, setCharacterRequest] = useState(initialCharacterRequest);

  // Revokes the previous selection's object URL when a new file replaces it
  // or the component unmounts — otherwise each selection leaks the blob.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0] ?? null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setFile(chosen);
    setObjectUrl(chosen ? URL.createObjectURL(chosen) : null);
    setError(null);
    setJustSaved(false);
  }

  async function submit() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("photo", file);
      // No content-type header set deliberately — the browser fills in
      // multipart/form-data with the correct boundary itself; setting it by
      // hand would drop that boundary and break the upload.
      const [photoRes, characterRes] = await Promise.all([
        fetch(`${apiBaseUrl}/auth/photo`, { method: "POST", credentials: "include", body: form }),
        fetch(`${apiBaseUrl}/auth/character-request`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ characterRequest }),
        }),
      ]);
      if (photoRes.status === 401 || characterRes.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (!photoRes.ok) {
        const data = await photoRes.json();
        setError(data.error ?? "Couldn't upload that photo — please try again.");
        return;
      }
      if (!characterRes.ok) {
        const data = await characterRes.json();
        setError(data.error ?? "Couldn't save that description — please try again.");
        return;
      }
      const data = await photoRes.json();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setFile(null);
      setObjectUrl(null);
      setExistingPhotoOk(true);
      setCacheBust((n) => n + 1);
      setJustSaved(true);
      onUploaded?.(data.photoPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload that photo — please try again.");
    } finally {
      setUploading(false);
    }
  }

  const previewSrc = objectUrl ?? (existingPhotoOk ? `${apiBaseUrl}/photos/${userId}?v=${cacheBust}` : null);

  return (
    <div>
      <label style={dropzoneStyle}>
        <input
          type="file"
          accept={MIME_ACCEPT}
          aria-label="Photo"
          onChange={handleFileChange}
          style={hiddenInputStyle}
        />
        {previewSrc ? (
          <>
            <img src={previewSrc} alt="" style={previewImgStyle} onError={() => setExistingPhotoOk(false)} />
            <div style={previewOverlayStyle}>{file ? "New photo selected" : "Click to change"}</div>
          </>
        ) : (
          <div style={placeholderStyle}>
            <CameraIcon />
            <div style={{ fontSize: 11, letterSpacing: ".08em" }}>Click to choose a photo</div>
            <div style={{ fontSize: 10, color: "var(--fg-faint)" }}>JPEG, PNG, or WebP — up to 12MB</div>
          </div>
        )}
      </label>

      <div style={instructionsStyle}>
        Front-facing, full face, no glasses or headwear. Solid, dark clothing and a plain background photograph
        best — your character in the scene is rendered from this photo.
      </div>

      <label htmlFor="photo-uploader-character-request" style={fieldLabelStyle}>
        How would you like your character to look? (optional)
      </label>
      <textarea
        id="photo-uploader-character-request"
        rows={3}
        placeholder="Outfit, colors, style — e.g. a black tailored suit with gold cufflinks, calm and composed."
        value={characterRequest}
        onChange={(e) => setCharacterRequest(e.target.value)}
        style={textareaStyle}
      />

      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {justSaved && !file && <div style={{ marginTop: 10, fontSize: 12, color: "var(--gold)" }}>Photo saved.</div>}

      {file && (
        <button onClick={submit} disabled={uploading} style={submitButtonStyle}>
          {uploading ? "Uploading…" : submitLabel}
        </button>
      )}
    </div>
  );
}
