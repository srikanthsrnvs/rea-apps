# Checkout and cancellation protocol

The pure builders in `src/booking-protocol.mjs` prepare persisted GraphQL requests recovered from Airbnb Android 26.42, build 28026652. They perform no network requests, payment selection, messages, retries, or approval handling. The CLI owns review, approval, durable submission state, and reconciliation.

## Checkout preview

`buildCheckoutPreview({listingId,checkin,checkout,adults,children,infants,pets,currency})` prepares `CheckoutFlowQuery`. Its input contains `staysV1` with dates, guest counts, and `productId = base64("StayListing:" + listingId)`. Prior booking/order IDs are optional in the recovered input schema. This alone does not establish that an anonymous or authenticated server accepts the minimal request.

`buildStaysCheckout` prepares the native alternative `stayCheckout` POST. In the root agent's authenticated verification this operation returned a populated checkout, while `CheckoutFlowQuery` still returned an error even with the returned order/quote/attempt IDs. Preparing checkout creates draft state; draft IDs and a draft confirmation code do not establish a completed reservation.

Required fields in the generated contract differ from local builder validation:

| Operation | Recovered generated contract | Additional local constraints |
| --- | --- | --- |
| `CheckoutFlowQuery` | Required input object. Its fields, including staysV1, are optional Input values; all fields of a stay are optional Input values. | A listing, valid increasing dates, and positive adult count. |
| `stayCheckout` | Required stay input object; its individual fields are optional. | Same stay/date/guest validation. This is a mutation. |
| `CheckoutFulfillmentMutation` | Required input.placeOrder wrapper; individual placeOrder fields are optional Input values. | Reviewed quote/order IDs, paymentQuoteId, explicit selectedPaymentOption and productDetails. |
| `ConfirmCancellationMutation` | Required request, cancellationType, and productId object. Identifier/type and reason/refund fields are optional in the generated nested schema. | Stay confirmation code and an explicit reviewed reason. |

Generated optionality does not establish server-side requirements. The builder never fabricates bookingQuoteId, orderId, bookingAttemptId, attestations, or prior placement state. Non-null china, partnerData, and splitStays are rejected because the recovered native serializer does not support them.

`parseCheckoutPreview` preserves `data.checkoutFlow.sections`, including metadata, quickPayData, sectionConfiguration, and checkoutServiceContext, and adds a `preparation` extraction. `extractCheckoutPreparation` returns that extraction directly. Paths below sections are explicit; absent values stay null:

| Extracted value | Canonical source path |
| --- | --- |
| bookingQuoteId, orderId, confirmationCodes | metadata |
| paymentQuoteId and bill tokens | quickPayData.bootstrapPayments.billData |
| paymentCheckoutId, stepstonesToken | quickPayData.bootstrapPayments.checkoutTokens |
| available, selected, visible payment options | quickPayData.bootstrapPayments.paymentOptions |
| total, priceBreakdown, priceBreakdowns, quote token, pricing status | quickPayData.bootstrapPayments.productPriceBreakdown |
| fee/price items, subtotals, informational items | quickPayData.bootstrapPayments.productPriceBreakdown.priceBreakdown |

`parseStayCheckoutPreview` separately follows `data.startStayCheckoutFlow.stayCheckout.sections` and reads payments from `temporaryQuickPayData.bootstrapPayments`. It rejects non-null metadata.errorData or sectionMetadata.errorData. It exposes stateMutation, initialState, sectionConfiguration, sections, and raw; preparation also includes bookingAttemptId and singular confirmationCode. The parser retains `sectionConfiguration.data` as sectionDataEntries and extracts its sectionData objects as sectionData, at both top level and under preparation. Callers can inspect the exact product-policy, terms, and first-message sections without matching display titles or inventing a message.

The preferred total is `productPriceBreakdown.priceBreakdown.total`; the source also has a top `productPriceBreakdown.total` display item, used only when the first is absent. A display item's nested total contains amountFormatted, amountMicros, and currency, exposed as preparation.totalAmount. The verified legacy checkout used the nested priceBreakdown path and string amountMicros. Money and Long values retain their input representations. There is no floating-point conversion, fee summing, recursive search, or fallback to search/listing prices. Remaining dynamic sections and raw data are retained.

The server's selectedPaymentOption can be a default; extraction does not make it user-approved. Query payment options and commit input objects have different schemas. The module does not automatically convert every payment method, satisfy CVV/payment/identity actions, or generate a complete booking plan for every section configuration.

Anonymous CheckoutFlowQuery verification returned HTTP 200 with an error section and null bookingQuoteId/orderId. Authenticated stayCheckout preparation returned quote/order/payment data, but no order was submitted. An error section or missing quote/order IDs must prevent confirmation.

## Booking submission

`buildPlaceOrder` prepares a POST `CheckoutFulfillmentMutation` using explicit reviewed bookingQuoteId, orderId, paymentQuoteId, selectedPaymentOption, and productDetails. It does not invent tokens, choose a payment method, or add a host message. `buildStaysCheckout` is also a mutation, despite its native use while refreshing checkout state.

`paymentParams.paymentQuoteId` is a native Long and can exceed JavaScript's safe integer range. The builder accepts a positive safe integer or a lossless positive decimal string within signed 64-bit range. It preserves strings; the transport must encode that known Long as an exact JSON integer without passing through Number. Rounded numbers, exponent/decimal strings, and out-of-range values are rejected.

`prepareSavedCardPaymentOption(rawQuickPayOption)` implements the recovered query-to-native-to-input path for one explicit saved CREDIT_CARD. Local acceptance requires isExistingInstrument=true, isValidForCurrency=true, isCvvRequiredForPayment=false, expired=false, an opaque instrument token, and null/absent threeDSecure2Details, paymentOptionInputInfo, errorDetail, and alipayDetails. These restrictions define the supported branch; generated input optionality alone does not prove a card can be charged.

The converter copies non-null token/type, businessEntityGroupId, displayName/localizedSubtitle, isCvvRequiredForPayment/isDefault/isExistingInstrument/isNewlyVaulted/isValidForCurrency, and the source's bin/cardType/countryOfIssuance/expired/lastFour card summary. It emits errorDetail={}, alipayDetails=null, and netBankingDetails=null. It omits query-only typenames, networks, debitCard, provider data, null optional fields, gibraltarInstrumentId, and unrelated payment inputs. The bytecode confirms this branch does not require a synthesized CVV nonce, device fingerprint, or trust payload. Payment actions can still be required by the server; this helper does not satisfy them. CVV/3DS/trust-input branches, other providers, and new instruments fail explicitly.

`buildStayProductDetails(options)` returns `[{stayDetails:{...}}]`; `prepareStayProductDetails(options)` returns the individual wrapper. Source fields inside stayDetails are airbnbOrgParams, businessTravelDetails, cubaAttestation, and messageToHost. Organization fields are airbnbDotOrgPrivacyAttestation, airbnbOrgGuestType, and airbnbOrgResponseId. Business fields are isOpenHomes, isTrackingOnly, isWorkTrip, pending3pbGuestEmail, pending3pbGuestId, and tripNotes. The native caller derives isTrackingOnly from isWorkTrip or isOpenHomes; it stringifies a non-null pending guest ID. Listing/date/guest identifiers belong to the prepared quote and are not repeated in this object. The helper encodes only explicitly supplied fields; it does not infer business/organization/attestation answers or a host message. Empty optional stay details satisfy the generated client contract, while server acceptance remains unverified. If a first-message or other mandatory section needs user data, the review flow must obtain it before submission.

`data.checkoutFulfillment.result` is a union. `parsePlaceOrderResult` requires the exact CheckoutFulfillmentPlaceOrderResult discriminator and returns outcome, confirmed, and terminal. It preserves status, error, checkoutActions, paymentDetails, productTokens, altoIdempotencyKey, result, and raw response:

- FAILURE becomes failed.
- PENDING_PAYMENT or PENDING_IDENTITY_VERIFICATION without an embedded error becomes pending.
- SUCCESS becomes succeeded only with a nonempty orderId and an explicitly null error. Requiring ID/error coverage is a conservative local acceptance rule; incomplete or contradictory SUCCESS payloads stay unknown.
- A source-typed embedded CheckoutFulfillmentPlaceOrderError can establish failure when it does not contradict a success/pending status. Unknown variants, statuses, and conflicting fields stay unknown.

The success property is present only for a known terminal outcome. A successful HTTP response, redirect action, alteration result, or arbitrary object with status SUCCESS does not establish booking success. Actions remain caller-visible and are never executed by the parser.

No live booking has been approved or tested. Payment/identity actions and complete recovery from an interrupted submission remain unresolved. Source fields named bookingAttemptId and altoIdempotencyKey do not establish server replay guarantees. Never automatically repeat a submission after an uncertain response.

### CLI review lifecycle

`booking.mjs` uses the verified `stayCheckout` path. It saves an account-bound ten-minute review with exact string amountMicros/currency, itemized prices, locally named payment options, product policies, terms and the confirmation action. An offered card is not selected automatically. The public review excludes opaque instrument tokens; the owner-only private record retains the original preparation and response.

`booking confirm` requires explicit confirmation, a selected supported card, exact termsHash, currency and decimal maximum total. Decimal ceilings are compared using BigInt micros. FirstMessageSection requires a user-approved message; active insurance, frozen/third-party booking actions and unknown sections stop before fulfillment. The protocol's optional organization/business fields are not filled with invented answers. The final request can still fail or need further server payment/identity actions.

Only source-typed paymentQuoteId and selectedPaymentOption.businessEntityGroupId are encoded as exact JSON Long integers using JSON.rawJSON. Other opaque strings retain their type. The submission is journaled before POST. An account/stay intent guard prevents a fresh review from repeating a successful or uncertain submission. Recorded responses remain available through status after expiry; unrecognized responses never become success. Confirmed cancellation of the same reservation can release its matching booking intent. These are local duplicate-prevention rules, not a server idempotency guarantee.

## Cancellation

`buildCancellationPreview({confirmationCode,selectedReasonId?,selectedSubReasonId?})` prepares the read operation `UnifiedCancellation`. Its productIdentifier uses productType STAY. The response is `data.presentation.cancellation`, with title, callToActionButtons, and dynamic sections containing the server's refund/policy information.

`buildConfirmCancellation` prepares a POST `ConfirmCancellationMutation` using a reviewed reason and optional explicit refund-method choice. The recovered guest caller uses cancellationType CANCEL_BY_CUSTOMER. The builder excludes messaging fields. `parseCancellationResult` follows the recovered data.cancelProduct union:

- CancelProductSuccessResponse requires boolean success. True becomes succeeded; false becomes failed.
- ProductCannotBeCanceledError requires the source-required boolean retryable and becomes failed. errorMessage, redirectUrl, actionText, and retryable are retained. A retryable flag never triggers a retry.
- Missing required fields, string booleans, absent/unknown discriminators, and future variants stay unknown and nonterminal.

No live cancellation has been approved or tested. Review the current server refund information and require explicit confirmation before any submission.

### CLI cancellation review

`cancellation.mjs` follows `sections.mainSectionPlacement[]` and `refundSectionPlacement[]`, each containing sectionData. Current main types are CancellationProductOverviewSection and CancellationReasonsSelectionSection; current refund types are CancellationPriceBreakdownSection and informational CancellationRefundMethodSection. CancellationInterventionSection suppresses normal confirmation. Unknown section types are retained for display but block the supported submission path.

Reasons come only from the current `reasons[{reasonId,reasonText}]`, excluding UNKNOWN/UNKNOWN__. The user chooses an offered wire value. The native caller puts that value in confirm request.reasonId and omits reasonIdValue, selectedRefundMethodType, messaging and subreasons. The current refund-method section describes a destination; it does not establish that CREDIT or DEFAULT is an offered choice.

The native footer recognizes CancellationPrimaryButton and directly invokes confirm; it does not require a guessed action discriminator. The CLI additionally requires one primary button, complete supported sections and a price-breakdown section, and blocks a nonempty navigation URL. Missing or unsupported review data cannot imply eligibility.

Reason selection can return refund placements only. The CLI first loads the current product/reasons, then merges a successful selected-reason refresh from that same account/reservation. Nonempty fresh placements replace their counterparts; missing main placements retain that immediately preceding main review. An empty or failed refresh never enables confirmation. The complete pair is fetched again immediately before the final POST, so old main policy text is not reused from an earlier approval.

The product overview preserves cancellationPolicySummary. Refund display groups contain lineItems and overviewLineItem; both expose localizedTitle, localizedSubtitle, amountFormatted, metadata, explanation and sublineItems. Flat priceItems retain localized text, supplementaryLabel, nestedPriceItems, type and total.amountFormatted. This APQ contains no authoritative numeric amount/currency pair for cancellation. The CLI therefore hashes and presents the complete server display terms and destination; it does not parse or sum fees/refunds. Only loggingData is excluded from the stable terms hash.

Reviews expire locally after five minutes. Final cancellation requires explicit approval and the exact termsHash. Changed terms/eligibility require another review. Account/product intent and per-review journals reserve the sole mutation before transmission. A timeout remains unknown even if another review is prepared; status never silently retries it. A new review cannot retry a rejected mutation unless the known response explicitly says retryable=true. No server quote version, stale-review lock or automatic interrupted-write reconciliation has been established.

REA evidence: placements `ev_81dd2e2bc101e0bb3cd73e3162f938d6120650fa55f5b0381864954e53bbee32`; state merge `ev_291612d12c8896c9c86339b19f35459211acf0ba83882985d9106cbf252546fe`; footer/click `ev_e5e515096682849603b0dcc4e1aaf5880a2d120683a960fedecc0beb08566919`, `ev_5363198fa2c2c2aea4098d9270381722d5a8807af5e2f922dddd170c755c5a34`; native reason mapping `ev_60a1d404f3e983189d5c33f48ca814649b5337b79d926d1c09d011fb0b18a8de`; display-only total `ev_51c0ff8e05114d76975fdb7622a987bdb92bc2b39a8c97cde98bdd79e9f0d954`; row parser `ev_fcfb030d4e106d3db35660ec38e9db664bc56694ac64a38d4e633317518f3c0d`. The full source-only findings remain in the private cancellation-review report.

## Read lookups and reconciliation limits

| Builder / parser | Exact operation and result |
| --- | --- |
| buildBillPolling / parseBillPolling | billPayinInfoForQuickPayPolling, with billToken and numeric userId. data.payments.billPayinInfoForQuickPayPolling contains isBookingPayinSucceeded, shouldTriggerFovFlow, freezeReason, transactionErrorMessage, and afterBookingRedirectUrl. |
| buildCheckoutConfirmation / parseCheckoutConfirmation | CheckoutConfirmationQuery by confirmationCode. data.presentation.checkoutConfirmation contains sectionConfiguration and presentationData. |
| buildCancelledReservations / parseCancelledReservationsPage | CancelledReservationsQuery by the account's existing GlobalID, optional first/after/order, and explicit type CANCELED. data.node must be User; tripItems contains pageInfo and edges. Unknown node variants stay distinct from an empty page. |

The bill payin flag remains boolean or null. False does not establish terminal booking failure; true is a payment signal, not an identity-bound reservation-status record. CheckoutConfirmation contains presentation data rather than a generic success flag. Canceled trip records remain raw: a universal mapping from every edge to the exact stay confirmation code was not completed. Absence on one page cannot resolve a cancellation timeout.

Server idempotency guarantees and recovery without a returned order ID, bill token, or confirmation code remain unestablished. No read response is used here to infer that an unknown write did not happen.

## Evidence and verification

APK SHA-256: `cc74899171c8e84a2c4b6d5e0f307ccbbfbb5d61911fb3113250ca17217d07ad`.

Exact operation names, hashes, input schemas, source findings, and limitations are retained privately in private/airbnb/evidence/account-booking-catalog.json and account-findings.md; the additional analysis is in account2-*.json. Wire operation names can differ from generated DTO names: stayCheckout, stayCheckoutPrefetch, and UnifiedCancellation preserve their recovered spellings.

The focused payment conversion trace is in account3-*.json. REA's kc22.m32655 body had a JADX failure and skipped instruction dump. With parent authorization, the existing JADX fat JAR's Baksmali API disassembled that exact method offline; no APK code was executed and no engine was installed. The supplemental source, helper, APK/JAR/source hashes, and REA link are retained in account3-bytecode-manifest.json and account3-kc22-payment-method.smali. This supplemental bytecode has no fabricated REA Evidence ID.

| Additional finding | REA Evidence ID |
| --- | --- |
| Canonical payment/bootstrap fields | ev_8f1f36cd68d221b5414269fa1bba76880f4276557ba64268a6e2f4a5de86fe4e, ev_721d1a2cdea83e2e21a9f7c0e2bbb87e43dc3e10ac0c81535a6684d606b77b25, ev_e45a879cfcf49866fc2f102cb5ad07d8fa9176ad778ad07db95964f6a1fcf1f4 |
| Display total and currency micros | ev_e924d558f4ed7c93d540161fa01daff2d8db562493f26ce19110b5434e6ddef0, ev_9191327724d9438e57e46533ff442c63a0696c17cd8917e9d280b935c847d7f7 |
| Place-order discriminator and fields | ev_97baf11ae681b03d397fe8f748caf78ae34fc7f540fd76cda502263022fac50e, ev_88c292544ca50de99c8a7a2b0880a37e1abd3abfeead5fea786304f23b1052ce |
| Cancellation union and required fields | ev_4abe29301738b8dd2d9369d79522f69a2af461b37bf0768468b6773f719c0b24, ev_6909aa89c424f086cbe5fe8fdbd269f42936ffb6dd7fc0b68255ff45bb530f0d, ev_03d22b719bade88beda293228dd5005ab60bf79cd94cc080e5224642b2eef73e |
| Payin lookup fields | ev_5b0f1c8ce14acf01eb7999c6d038e0580f74e63876466ceff80921f3e61c46d7, ev_41ad47c0218df1f58e285207bdf31c4015eaa9348241e58074a5e124740c1cc7 |
| Canceled trip lookup/hash/filter | ev_07b766d8a9f65cabb5ce33af6e5c1fb8ec93db06d2a531f58f74241b41e4b079, ev_f61179487c7e9da5d17513a96014362690644c4ed07dd83168d7b53a74820624, ev_2ddd5c710c2ab4d20040edc591d6d9216f250f415e99987cc3c2c0a015a41bf0 |
| Query payment option to native model | ev_2374c86fb9b1e9c05d80059d306a028ca8941a77b85e4e8097105f6208b39933 |
| Skipped payment converter and recovered input constructor/marshaller | ev_f5a880150a3b52fa561be63512cb3562ceec425439f4acfe1f931c55a819b70c, ev_9f0b216871cfebea947526ff92fa4ecc278c38843b2b47645c5c9ec3f178757d, ev_6675f139b5a0c0b4bb284d41f2ef376600b64d03ea1b4cf6c1613e2ffc850b3f |
| Null optional inputs are omitted; explicit null alternative | ev_c61616a1c886ecbe900daefd6d95754b88e91d3c1a0fd84be9335da39987eb96, ev_8315f16d9f5056c5b788c27ce131ebc138de98a3f1eec90a7fdc951c4aa33255 |
| Stay product caller, wrapper union, and nested keys | ev_99ae1bae1c7b1f2833c6ddcff26026a80467fc5eeda1e978cc6708f9197a0539, ev_cb30f5f480a8a8891c6cf9ea12cc9b52cfdc2c3bc269ddd80a2e696175599208, ev_4afd0768e069ba4caf1972adf7f31a73a5251abc16183822b9a5e1a65a4a35b1, ev_0acd26c6abd9b592abc6748fe30dc55c14249909fe218778b6fa4de520fd17f9 |
| Legacy response path and temporaryQuickPayData | ev_0addac6d6a08afbf135d0b61e58cfae0ed2360367ae76e1a8a193ed93c5cdd9b, ev_796d000dffca9323ab98a3e8e71348be2bbb9be993c8713753d52c51ce83548d, ev_9686ce7eb6d734b5d4586273473624577f597fb786d931de6039ebfb03c21a98, ev_f64194a0782310b6abc6b1377d75bf72ee75ed9c5ec22dcf0e38c00b6434623b |

Synthetic tests cover ID/date/Long validation, exact saved-card input mapping and unsupported-action rejection, product wrappers, legacy sections and nested money extraction, explicit POSTs, discriminated terminal/pending/unknown results, partial/conflicting payloads, GraphQL error rejection, and pagination preservation. They establish parser behavior, not live booking or cancellation support.
