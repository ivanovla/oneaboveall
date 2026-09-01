import { defineConfig } from "vitest/config";

export default defineConfig({
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
