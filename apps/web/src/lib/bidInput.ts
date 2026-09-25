/**
 * What a bid field is allowed to display as the user types: digits plus at
 * most one decimal point.
 *
 * The decimal point is deliberately NOT stripped here. A controlled input's
 * onChange sees the *previous accepted value* with one character inserted —
 * not the user's full intent. Any rule that drops the "." therefore drops it
 * again on every subsequent keystroke, and the digits after it simply append
 * to the digits before it. Typing "15.50" one character at a time under a
 * strip-the-dot rule goes "1" -> "15" -> "15" -> "155" -> "1550", which is a
 * 100x-inflated bid, reproduced keystroke by keystroke. A single whole-string
 * change event hides this completely, which is why a truncate-at-first-
 * non-digit attempt can look fixed in a paste-style test and not be.
 *
 * So the field simply shows what was typed, and the whole-dollar rounding
 * happens once, at submit time, in `toWholeDollarCents` below.
 */
export function toBidInputValue(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  // Keep the first ".", drop any later ones, so "1.5.5" can't reach parseFloat.
  return `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, "")}`;
}

/**
 * Converts the displayed field value to the whole-dollar amount in cents
 * that actually gets bid.
 *
 * Whole-dollar bidding is this site's convention — cents are never accepted.
 * Flooring "15.50" gives $15, the honest reading of what the user typed and
 * visibly what the field shows, rather than concatenating the digits into a
 * 100x-inflated amount.
 *
 * An empty field, a lone ".", or anything else parseFloat can't read yields
 * 0, so an empty bid still reaches the server and gets its normal
 * below-minimum validation error rather than silently doing nothing.
 */
export function toWholeDollarCents(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) * 100 : 0;
}
