import { generators } from "openid-client";

export const OAUTH_STATE_COOKIE_NAME = "oneabobeall_oauth_state";

export function generateState(): string {
  return generators.state();
}

export function generateCodeVerifier(): string {
  return generators.codeVerifier();
}

export function generateCodeChallenge(verifier: string): string {
  return generators.codeChallenge(verifier);
}
