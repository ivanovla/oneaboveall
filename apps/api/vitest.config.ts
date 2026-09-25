import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    fileParallelism: false,
    // Pinned regardless of whatever DATABASE_URL the local .env happens to
    // set for `npm run dev` — several test files unconditionally
    // `DELETE FROM` the tables they touch in afterEach, and this must never
    // be able to point at a real dev/prod database.
    env: {
      DATABASE_URL: "postgres://auction:auction@localhost:5443/auction_engine_test",
    },
  },
});
