# Legal review needed — Terms & Privacy

`apps/web/src/pages/terms.astro` and `apps/web/src/pages/privacy.astro`
(both "Last updated: October 2, 2026") were **drafted by an AI assistant**
from the product description and the launch-readiness spec
(`docs/superpowers/specs/2026-10-02-launch-readiness-design.md`). They are
published without a "draft" label, but **must be reviewed by a qualified
lawyer (Spanish / EU consumer and data-protection law)** before or as soon
as possible after launch.

## Open questions for the reviewer / owner

1. **Seller identification.** Devvally's legal form, registered address,
   tax ID (NIF/CIF) and company registration details were not provided.
   Spanish LSSI-CE (Art. 10) and the EU Consumer Rights Directive require
   them on the site — likely an "Imprint / Aviso legal" block in the Terms.
2. **Withdrawal right.** Is the "request immediate performance + lose the
   right once you win the seat" wording (Art. 16(m) CRD / Art. 103 TRLGDCU)
   valid for this service, and is the separate checkbox at the bid step
   (spec section 8) enough as the "express consent + acknowledgement" with a
   durable-medium confirmation (e.g. in the "You won" email)?
3. **Consumer withdrawal form.** Does a model withdrawal form need to be
   provided even though the right is lost on performance?
4. **Not-gambling characterisation.** Confirm a paid-placement auction with
   no prize is outside Spanish gambling law (Ley 13/2011) and similar rules
   in the main target markets (US, UK).
5. **Liability cap** (amount paid in the last 12 months) and the "as is"
   clause — enforceable against EU consumers as written?
6. **Refund policy.** "No refunds once you win except content removed
   before publication or where required by law" — acceptable for EU
   consumers and for Stripe's requirements? Should a cancelled/aborted
   round or a failed redraw trigger an explicit refund?
7. **Photo licence.** Scope and duration of the licence to use the winner's
   photo/redrawn artwork (archive, promotion) and what happens on erasure
   requests for already published artwork.
8. **How the artwork is produced.** If an AI image service (or a human
   contractor) is used to redraw the scene from the winner's photo, it is a
   processor (possibly with a non-EU transfer) and must be listed in the
   Privacy Policy. Not currently listed.
9. **Biometric data.** Confirm that processing a face photo to redraw a
   likeness is not "biometric data" processing under GDPR Art. 9.
10. **Legitimate interest for attribution.** Storing first-touch
    `ref`/`utm_*` in localStorage and on the user record — is this covered by
    legitimate interest, or does the ePrivacy / LSSI-CE cookie rule (Art. 22.2)
    require consent for the localStorage part? (Session cookie and theme are
    treated as strictly necessary / user-requested.)
11. **Retention periods** (account until deletion, payments ~6 years, logs
    ~30 days) are assumptions — confirm against actual practice and Spanish
    tax/commercial law, and that server logs are actually rotated.
12. **International transfers.** Confirm each processor's mechanism (DPF vs
    SCCs) — Stripe, Google, Apple, Resend — and that DPAs are signed.
13. **Sponsored creators.** Is the "Sponsored creator" label sufficient
    disclosure under EU/UK/US (FTC) advertising rules, and do creators'
    own posts need separate disclosure (outside this site)?
14. **Public display on streams.** Display names appear on the public page,
    leaderboard and the OBS overlay shown on third-party streams — is that
    adequately covered by the contract basis and the Terms wording?
15. **DPO / representative.** Confirm no DPO is required and whether a UK
    representative (UK GDPR Art. 27) is needed when targeting UK users.
16. **Age verification.** 18+ is self-declared (checkbox). Is that enough?
