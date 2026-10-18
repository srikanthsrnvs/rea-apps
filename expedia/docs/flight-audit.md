# Browser-free flight audit

Audited on October 17, 2026 Pacific time (live evidence timestamp
`2026-10-18T03:06:05.758Z`). This audit covers flight search, selection and
checkout preparation. Login is a separate investigation. No payment details
were submitted and no ticket was purchased.

## Fresh runtime observations

A Node 24.19.0 process on macOS ARM64 created a new anonymous Expedia context
and made HTTPS requests directly. It read no saved account/session files and
used no browser, Android runtime or physical device.

| Step | Observed result |
| --- | --- |
| LAX–SFO, November 8, 2026 | 62 standard offers; a returned selection action produced flight details. |
| LAX–SFO, November 9, 2026 | 82 standard offers. |
| Select a returned November 9 offer | One selected journey and a populated price summary. |
| Follow that offer's checkout action | An Expedia flight checkout with total USD 98.40, including taxes and fees. This preparation creates a checkout session. |
| Parse returned checkout HTML as JSON | Contact/traveler form: 17 fields, 7 required. Billing form: 6 fields, 5 required. One payment option. |
| Validate the checkout with `GetSessionInfo` | Session token returned, no GraphQL errors, zero signals and zero server signals. |
| Checkout trust experiment | This checkout explicitly enabled the empty-trust-payload branch, bound to its returned device identity. |

These are current observations for these requests, not a guarantee of future
availability or a successful paid booking. Search returned no pagination
configuration for either test. No raw continuation tokens, checkout IDs,
cookies or session tokens are included here.

After the reliability changes were deployed, the normal ARM64 Orin CLI repeated
search, selection and checkout preparation using its refreshed saved account:
82 offers and a USD 87.11 checkout with two form groups. No browser or Android
runtime ran, and no payment or booking was submitted. This is a separate
observation from the anonymous macOS tests above.

The exact shipped GraphQL document hashes used in the second request chain:

| Operation | SHA-256 |
| --- | --- |
| `androidFlightsResultsFlightsSearch` | `bcc38aa12dc7969fdbd4e853b21c6a8ae999bb63d30919ec59b691373c8665fa` |
| `androidFlightsRateDetailFlightsDetailLoaded` | `a1e08922f93d404874c5fc419767ca26d26e707f1e086e37a7982c2331978c09` |
| `FlightsDetailPriceSummary` | `5e2bce66d572f1c18c612dd3825dd5166dca24a2cec7d2b9cf6c42d3fc32ee3c` |
| `GetSessionInfo` | `a3f7622095b924ac568895751ee7ce6836184847d21973b47fbeb33952d8d78b` |

## Source provenance

The Android target was Expedia `com.expedia.bookings` 2026.41.0, APK SHA-256
`dfd7bbfdf10976740cbf7b4a74e359358871479766d0705d1e9b5ff633a7700f`.
The documents and their APK/asset provenance are retained under
`src/graphql/{flights,checkout}`.

REA evidence `ev_c4d91aacebab69f42b915f920c98d7a78b7f842caf8385b583a29c8c2e51543f`
shows Android's `FlightsCheckoutNavigator.navigateToWebCKO` validating and
navigating to the server-returned checkout URL. The Android app uses a WebView
for this stage. That does not imply that an HTTP CLI must execute a WebView:
the current runtime observation confirms that checkout data can be obtained
and validated by parsing its serialized Apollo JSON without running page scripts.

REA checkout JavaScript evidence
`ev_92c37442e1739fe57d16d5814e5d66377a812d042ea2bd6097ea8c8788c322cd`
and retained analysis
`ev_b574d6fcb86bb9ace75b86b9df40f041ef8733097e4be7e6ab7691bcf73eb9c7`
ground the final booking button investigation. Detailed source bounds and
the actual legacy payment adapter are documented in `checkout-protocol.md`.
Static inspection establishes request construction, not successful payment.

## Gaps before claiming reliable booking

1. **Payment is source-grounded but not live-validated.** New-card tokenization,
   payment selection/update, final booking and order reconciliation have only
   synthetic execution tests. Stored-card/CVV completion is not exposed. A
   genuine issuer challenge currently stops with `requires_action`; browser
   metadata, challenge completion or trust payloads must not be invented.
2. **Addressed: submitted traveler/contact approval values.** The purchase
   review now projects labeled fields from the server's contact form and
   current submitted values. Select codes display their returned labels;
   private input-ID suffixes and session tokens are omitted. Synthetic tests
   confirm updated values replace stale prefills in the approval review.
3. **Addressed: account/session ownership.** Offers, details, checkout records,
   purchase plans and operation journals carry an identity fingerprint, checked
   under the existing command lock before reads or network calls. A changed
   account or native device identity requires fresh selections. Historical
   unbound records fail closed. Checkout owner identity is retained separately
   because the checkout page may issue a different device ID.
4. **Addressed: post-submission edits.** Form and payment mutations both reject
   submitted, submission-pending and unknown-outcome checkout records. The
   checkout is frozen before its journal and intent records are published and
   before any purchase request. Concurrent confirmations and a second checkout
   for the same unresolved intent reuse the operation rather than submit again.
5. **Addressed: preparation/form action signals.** Preparation rejects partial
   GraphQL errors and session action signals. Form updates with signals return
   `action_required`; updates without session-token confirmation stay
   unvalidated. Neither can mark a traveler form ready for booking.
6. **Continuation support is incomplete at the CLI layer.** Pure search
   builders support pagination and returned filter values; the CLI exposes no
   next-page/filter command. `hasMore` is currently only the truthiness of a
   pagination-config object. Establish the real terminal-page contract before
   exposing an infinite or paginated listing API. Loading-result continuation
   is likewise not orchestrated.
7. **Reconciliation is narrower than purchase recovery.** Pending results with
   both order IDs can be checked through `RedirectOrderStatusQuery`. A lost
   submission response without those IDs remains unknown. The durable intent
   guard prevents resubmission, but there is no independent account-order
   lookup or ticket-issuance verification. Preserve the no-retry behavior until
   a real recovery contract is established.

## Verification

The initial audit's 48 focused tests passed. After the reliability fixes, all
75 JavaScript tests passed, including account-switch, stale approval,
submitted-value review, frozen-form/payment, concurrent-confirmation,
blocking session/form signals and a guarded HTTP-only CLI import graph:

```sh
node --test test/*.test.mjs
```

They cover exact query hashes, opaque selection/fare continuations, round-trip
selection construction, inert checkout parsing, session binding, scoped payment
contracts, changed-fare review, explicit confirmation, mutation non-retry and
durable uncertain-purchase deduplication. They do not establish live card
acceptance, issuer verification, booking acceptance or ticket issuance.
