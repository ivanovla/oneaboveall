/// <reference types="vitest" />
import { getViteConfig } from "astro/config";

// getViteConfig (rather than vitest's plain defineConfig) loads Astro's own
// Vite plugins, so tests can import and render .astro components through the
// Astro container API (see tests/pages.test.ts).
export default getViteConfig({
  // Astro's own build pipeline (via @astrojs/react) transforms .tsx with the
  // automatic JSX runtime, but vitest runs outside that pipeline, so it needs
  // the same setting here or React components fail with "React is not defined".
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
