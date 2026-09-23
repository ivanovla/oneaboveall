import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

// Same requireEnv pattern as routes/authGoogle.ts (see that file for the
// full rationale): fail at module load, with a clear error naming the
// missing var, rather than producing a broken JWT (or a cryptic crypto
// error) on the first real Apple sign-in attempt.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const APPLE_TEAM_ID = requireEnv("APPLE_TEAM_ID");
const APPLE_KEY_ID = requireEnv("APPLE_KEY_ID");
const APPLE_SERVICES_ID = requireEnv("APPLE_SERVICES_ID");
const APPLE_PRIVATE_KEY_PATH = requireEnv("APPLE_PRIVATE_KEY_PATH");

// The private key FILE itself is read lazily, on the first real call to
// generateAppleClientSecret(), and cached after that — deliberately not at
// module top level. Every apps/api test file that doesn't care about Apple
// sign-in (scene.test.ts, leaderboard.test.ts, currentRound.test.ts, etc.)
// still imports server.ts -> routes/authApple.ts -> this module, and this
// repo has no real apple-private-key.p8 on disk yet (no Apple Developer
// Program enrollment). An eager top-level readFileSync would make every one
// of those unrelated test files fail to even import the server. Reading
// lazily means the file is only ever touched by a genuine call to
// generateAppleClientSecret(), which only happens on an actual hit to
// /auth/apple or /auth/apple/callback — and authApple.test.ts mocks this
// whole module away, so even that route's own tests never touch the disk.
let cachedPrivateKeyPem: string | null = null;

function getPrivateKeyPem(): string {
  if (cachedPrivateKeyPem === null) {
    cachedPrivateKeyPem = readFileSync(APPLE_PRIVATE_KEY_PATH, "utf8");
  }
  return cachedPrivateKeyPem;
}

// Apple requires a short-lived JWT (not a static string) as the OAuth
// client_secret: iss=team ID, sub=Services ID, aud=Apple's own issuer,
// signed with the ES256 "Sign in with Apple" private key identified by
// APPLE_KEY_ID. Regenerated on every call rather than cached — a JWT sign
// operation is cheap, and this avoids having to track a stale-secret expiry
// edge case at all.
export async function generateAppleClientSecret(): Promise<string> {
  const key = await importPKCS8(getPrivateKeyPem(), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setSubject(APPLE_SERVICES_ID)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
