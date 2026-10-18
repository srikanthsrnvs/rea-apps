# Flight checkout protocol

The Android app's flight details action opens an Expedia checkout URL. The CLI follows that returned preparation action using HTTP, then parses the checkout page's serialized Apollo cache as JSON. No browser, Android runtime, or remote JavaScript execution is needed for that step.

## Evidence and validation

The investigated APK is Expedia Android 2026.41.0, SHA-256 `dfd7bbfdf10976740cbf7b4a74e359358871479766d0705d1e9b5ff633a7700f`.

- REA native source evidence `ev_c4d91aacebab69f42b915f920c98d7a78b7f842caf8385b583a29c8c2e51543f` confirms `FlightsCheckoutNavigator.navigateToWebCKO` validates a server-returned URL before navigation.
- A live selected one-way flight produced `/checkout-redirect?action=UnifiedDetailsWidget@statelessBook`, which returned HTTP 302 to `/checkout/session/{id}?productLine=FLIGHT`. That preparation created a checkout session; it did not purchase a ticket.
- Its HTML contained a flight itinerary, current price including taxes/fees, rules, legal text, contact/traveler and billing forms, payment options, session token, and the final booking button. A read-only `GetSessionInfo` with `isValidate:true` returned the current token with no error signals.
- The actual page loaded `ecomm-checkout-ui` first-party bundles. REA JavaScript evidence `ev_92c37442e1739fe57d16d5814e5d66377a812d042ea2bd6097ea8c8788c322cd` references retained analysis `ev_b574d6fcb86bb9ace75b86b9df40f041ef8733097e4be7e6ab7691bcf73eb9c7`. Analysis selected the booking-button bundle; other payment/form contracts below were read from the shipped JavaScript as inert text. It did not execute the bundles.
- There has been no live payment tokenization, card update, issuer authentication, or ticket purchase in this investigation. Synthetic tests verify request construction and failure handling, not those external outcomes.

Public GraphQL documents contain no captured account/session data. Their hashes are in `src/graphql/checkout/provenance.json`.

## Session handling

`parseCheckoutApolloState` extracts the JSON strings passed to `window.__APOLLO_STATE__ = JSON.parse(...)` and, when present, `window.__PLUGIN_STATE__ = JSON.parse(...)`. It never evaluates a script. `checkoutFromApolloState` binds the cache to the exact returned session ID and requires `productLine: FLIGHT`. Experiment metadata also must match the checkout context's device ID.

Persist the checkout context issued in the page together with the cookie jar received during redirects. The initial native anonymous context and checkout context can have different device IDs. Do not combine one checkout's cookies, tokens, form IDs, or price with another checkout.

`checkoutPreview` exposes itinerary, total/currency, rules, form types, and payment option identifiers without session tokens. Its `readyToBook` stays false: parsing a page does not validate traveler data, payment, issuer authentication, or purchase approval.

## Forms

`checkoutInputTemplate` creates an authorable structure:

```json
{
  "sessionId": "the-current-session-id",
  "forms": [
    {
      "type": "CONTACT_INFORMATION",
      "fields": [{"inputId": "server-issued-id", "label": "First name", "required": true}],
      "userFieldInputs": [{"inputId": "server-issued-id", "value": "Example"}]
    }
  ]
}
```

The actual file contains every returned field and its options/defaults. Preserve full opaque input IDs. Multiple travelers can have the same semantic field name with different opaque suffixes. Composite birth dates submit once as `YYYY-MM-DD`; their internal month/day/year controls do not become separate traveler values. Billing field requirements come from the selected country's template, not every country template shipped in the response. Select values use server option values. Changing billing country requires a fresh field template for that country.

`validateCheckoutInput` checks session binding, duplicate/unknown fields, and required values. Server validation remains authoritative. `buildSmartFormMutation` builds the actual web mutation, which differs from the older native operation: its session token is required, and its response can supply a replacement token, validation errors, and signals. `normalizeSmartFormResult` keeps those private results for the executor to apply. Do not submit booking after a failed or uncertain form mutation.

## Card payment

The observed flight checkout uses the legacy CPM wire protocol. Its experiments select the newer OneCPM SDK component, but `PaymentWrapper` explicitly supplies the `modern-checkout` service adapter. That adapter renders `paymentModule`, selects through `SelectPaymentMethodMutation`, updates through `UpdatePaymentMethodMutation`, and tokenizes stored instruments with `CreatePaymentToken`. Its generic submit-payment and post-payment-notify hooks are explicit no-ops. Therefore `paymentComponent: ONE_CPM` does not imply the generic `InitialisePaymentModule`/`UpdateFop`/`SubmitPayment` protocol. The projection distinguishes component and wire protocol.

1. `checkoutPaymentOptions` lists only server-returned options. `buildPaymentSelectionMutation` binds the chosen and previous option to their returned FOP IDs and the current checkout identifier.
2. The checkout's `PaymentCardDetailsTokenizationField` supplies a scoped access token and `https://api.expedia.com/v2/edge-tokens/instruments`. The official collector SDK versions 114/115 build a POST with `Authorization: Bearer …`, JSON headers, and payment details. The SDK's RSA encryption protects local iframe messaging; it decrypts those values before the HTTPS tokenization request.
3. `buildNewCardTokenizationRequest` reproduces that HTTP contract for the selected new-card option. The request contains raw card data transiently: never print it, persist it in a journal, or include it in diagnostic errors. Tokenization returns JSON `id`, normalized as the edge token. It does not purchase the flight.
4. `buildCardPaymentUpdateMutation` applies the edge token as `etzToken` to the returned FOP, with checkout session ID/token. Payment operations use the adapter's `MCKO` client ID. Apply the response's new `checkoutIdentifier` before the next action and refresh totals if card fees change.
5. `normalizeCardPaymentUpdate` identifies blocking server errors and required authentication. An `authenticationSpec` with `pasSessionId` and `encodedInitConfig` requires the official 3DS flow; an allocated card token is not proof of authentication.

Stored cards have a separate `CreatePaymentToken` contract with a returned stored-payment instrument ID and server-issued payment session ID. The subsequent collector tokenization can include the stored token and CVV. The token builder alone does not implement the entire stored-card/CVV lifecycle.

The actual checkout supplied the official 3DS connector at `https://static.pay.expedia.com/3ds/2.0.13/pay-3ds-js-libs-connector.min.js`, with `threeDsIframe.html` and a SHA-384-verified core bundle. It gathers browser metadata and invokes Cardinal with the server-issued configuration. A CLI must report `requires_action` when that is needed; it must not fabricate a browser fingerprint, issuer success, or challenge result. The current pure protocol does not implement the issuer interaction.

## Booking and reconciliation

`buildFlightBookingMutation` constructs the actual page's `BookMutation`, including checkout ID/token, context, optional session mode/client ID, and optional server-issued domain information. The native `CheckoutBook` operation is not used as a substitute. The web operation returns booking signals, order/itinerary numbers, a replacement token, and optional asynchronous resolution settings.

The shipped booking button allows an empty `domainInfoList` only in `HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD` bucket 1 when no genuine trust payload is available. The captured checkout explicitly had bucket 1; the parser records this as `trustRequirement.allowsEmpty`, scoped to that checkout device. An absent, mismatched, or different experiment requires a genuine `trustServicePayload`; the builder raises `CHECKOUT_TRUST_ACTION_REQUIRED` instead of inventing one. Booking and payment client IDs can differ: the captured booking-button flags chose `LEGACY_CPM`, while the payment adapter used `MCKO`.

The executor must validate all forms and payment, refresh the current fare/terms, enforce the user's approved amount, and write a private operation journal before sending the paid mutation once. It must not journal raw card/CVV data. The shipped web UI retries some failures; the CLI must reconcile an uncertain purchase instead of copying that retry behavior.

`normalizeFlightBookingResult` distinguishes `booked` from `pending`, allocated `order_created`, and `requires_reconciliation`. It requires native success signals to call an order booked. It deliberately leaves airline ticket issuance `unverified`.

For pending results, the shipped `app-shared` bundle polls this exact read-only operation:

```graphql
query RedirectOrderStatusQuery(
  $context: ContextInput!
  $confirmationSummaryParams: ConfirmationSummaryParamsInput
  $orderId: String!
) {
  confirmationSummary(context: $context, confirmationSummaryParams: $confirmationSummaryParams, orderId: $orderId) {
    __typename
    orderStatus
    redirectionUrl
  }
}
```

`buildFlightBookingStatusQuery` uses both returned order identifiers, `orderStatus: PENDING`, session ID, and checkout domain. The response's order status is `PENDING`, `SUCCESS`, or `FAILED`; it is not an airline ticket-issuance receipt. Respect the server's asynchronous interval/backoff/timeout and never poll by repeating `BookMutation`.

`AbandonBookingMutation` abandons an unfinished checkout. It must never be used to cancel purchased tickets. Flight cancellation needs its own quote, conditions, and confirmed servicing action.
