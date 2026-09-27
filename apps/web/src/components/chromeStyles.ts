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
