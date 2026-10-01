import type { CSSProperties } from "react";

// The fixed top-corner chrome chips (theme toggle, Leaderboard, the view
// counter, …) all share this one look — pulled out of AuctionFlow.tsx so
// any component that needs a matching chip doesn't have to duplicate it or
// import AuctionFlow.tsx just for a style object.
export const chromeButtonStyle: CSSProperties = {
  padding: "8px 13px",
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "var(--on-scene-dim)",
  border: "1px solid var(--line)",
  background: "var(--scene-chip)",
  backdropFilter: "blur(8px)",
};

// The small "Sponsored" disclosure next to an operator-flagged creator's
// name (users.sponsored) — homepage leader line, leaderboard, OBS overlay.
// Same look as the scene hover card's "Sponsored creator" tag
// (Scene.astro's .scene__tip-sponsored), so it reads as one label.
export const sponsoredTagStyle: CSSProperties = {
  display: "inline-block",
  marginLeft: 8,
  padding: "1px 6px",
  border: "1px solid var(--gold-soft)",
  fontSize: 8,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--gold)",
  verticalAlign: "middle",
};
