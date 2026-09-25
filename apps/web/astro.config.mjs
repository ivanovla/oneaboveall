import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  integrations: [react()],
  // Explicit IPv4 loopback: without this, `astro dev` binds only to the
  // IPv6 loopback ([::1]), which "localhost" resolves to on this stack but
  // "127.0.0.1" does not — and the API's CORS_ORIGIN and cookies are
  // configured for the http://127.0.0.1:4321 origin specifically.
  server: {
    host: "127.0.0.1",
  },
});
