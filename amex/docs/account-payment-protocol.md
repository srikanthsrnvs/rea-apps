# Native account and payment contracts

Derived from Amex US Android 7.34.1 (162662), APK SHA256
`4c5d7e757e9588e538abdf040ce8c3705c46d143863c7a7a704199b7c8a73765`.
These modules are pure protocol handling. Static evidence establishes the shipped
contracts; it does not establish successful live login or payment acceptance.

| Operation | Native request |
| --- | --- |
| Card/account summary | POST `services/accountservicing/v1/summary` |
| Transaction search setup | GET `services/transactions/v1/search/init`, account-token header |
| Transaction search | GET `services/transactions/v1/search`, accountToken, description, offset and filters |
| Statement periods | GET `services/transactions/v1/statementperiods/{accountToken}` |
| Transaction detail | GET `services/transactions/v1/transactionDetails`, source identifier/status/account |
| Payment inquiry and saved methods | GET `services/payment/v3/inquiry`, account-token header |
| Payment activity | GET `services/payment/v1/activity`, account-token header |
| Payment history | POST `services/payment/v1/history`, source sortedIndex |
| Existing-method bill payment | PUT `services/payment/v3/submit`, reviewed PAYMENT body |
| Cancel a scheduled payment | DELETE `services/payment/v1/payments/{paymentID}`, account-token header |

Every parser checks `status.success` and stops for secondary authentication or
server errors. An unrecognized response remains unknown. Account bindings,
account tokens and full source objects belong in private state; default output
uses a local card alias and masked ending. Search pagination preserves the server
`nextOffset`; it does not guess a page size or treat a partial page as complete.

## Existing-method bill payment

The shipped non-PCI-DSS caller constructs this request:

```json
{
  "type": "PAYMENT",
  "accountToken": "<selected card source token>",
  "date": "<offered date>",
  "idempotencyKey": "<inquiry.paymentRequestId>",
  "methodId": "<offered active method.paymentMethodId>",
  "optionIdentifier": { "type": "OPTION_ID", "value": "<offered identifier>" },
  "value": { "amount": "25.00", "currency": "USD" }
}
```

When no identifier is offered, the native variant is `OPTION_TYPE` with the
source amount option's `type`. The server supplies the idempotency key. It must
remain identical through the review and sole final request. The CLI never creates
a replacement UUID to retry an uncertain financial request.

`preparePayment` accepts only MAKE_PAYMENT with an AVAILABLE, ACTIVE existing
method and enabled DEFAULT amount option. It enforces exact decimal strings,
currency, editable amount permissions, offered amount/date bounds, and enabled
date choices. It preserves source warnings, scheduled payments and exact terms.
The lifecycle must display that review and require explicit approval, exact terms
hash, account binding and exact amount/currency/date before `buildPaymentSubmit` is used.
Both terms and the frozen request are integrity checked.

A successful native PAYMENT response reaches the app's payment confirmation
screen. The CLI calls this **submitted**, with `settled:false`; it cannot infer
bank settlement from presentation data. Partial, unknown and step-up responses
never become payment success. Transport errors after submission are uncertain
outcomes and must not trigger automatic retry.

The PCI-DSS payment intent/confirmation and 3DS branches require separate genuine
verification handling. New funding-source enrollment, reward conversion,
Pay-and-Plan, autopay enrollment and unknown branches are not synthesized. A
real account inquiry is required to determine which existing-method branch is
available; an active method is not automatically proof that every account's
bank-payment path is supported.

## Scheduled cancellation

The source scheduled payment must offer a delete action. A dismiss/CANCEL button
alone is insufficient. The review freezes the exact account and payment ID,
source payment details, cancellation prompt and terms. Only a specifically
confirmed review can create the DELETE request.

`Delete_PostResponse.data` is a shared snackbar union. Accepted cancellation
requires `status.success:true`, no outstanding secondary authentication/error,
`data.type:SUCCESS`, and the native string `body`. NEUTRAL, WARNING and unknown
variants remain unresolved. No claim about fees is inferred from an absent field.

## Evidence and verification boundary

REA method/class records establish the repository calls and generated DTO
serializers. For abstract Retrofit interfaces, whose method-source tool omits
annotations, supplementary offline dexlib2/Baksmali disassembly recovers exact
HTTP annotations, parameters and union registration. The native Retrofit parser
proves GET/POST/PUT/DELETE mappings. Original private evidence has the artifact,
engine and output hashes, and is excluded from Git.

Synthetic tests cover request shapes, secret-free display summaries, pagination,
strict status gates, source-selected methods/options, exact money, amount/date
limits, server idempotency lineage, explicit review confirmation and request
integrity, unknown outcomes and cancellation eligibility. These tests perform no
network requests or financial actions. Live account validation and final payment
validation are separate integration milestones and must be documented honestly.


## Review lifecycle and duplicate protection

`paymentOptions` stores the untouched inquiry in private state for five minutes.
Only local aliases such as `method-1`, `amount-1` and `payment-1` appear in default
output. Each alias is tied to that inquiry, account and card. A review freezes the
native method, amount option, exact amount/date, account binding, server-issued
idempotency key and terms. Its expiry is capped by the original inquiry's expiry.

`confirmPayment` requires the reviewed amount, currency, date, exact terms hash
and explicit confirmation. `confirmCancellation` requires the cancellation terms
hash and explicit confirmation. Both resolve the card before taking the global
state lock, then compare the current validated owner and private card binding
again under the lock.

Before the sole financial request, one durable intent record stores the exact
request and an unknown outcome. That record is authoritative if a later review
write fails or the process exits. Payment duplicate protection binds the owner,
card, native funding method, mathematically exact decimal amount, currency and
date. A fresh inquiry or differently formatted equivalent decimal cannot bypass
it. Scheduled cancellation protection binds the account, card and source payment
ID. Guards remain after unknown, failed and step-up outcomes; the CLI never treats
a new review as permission to retry a financial action that may already have run.

The complete HTTP result is saved before interpreting the native response union.
Timeouts, interrupted responses, unsupported response variants, server errors and
secondary authentication remain explicit recorded outcomes. Repeating the same
confirmation reads its journal and sends no second request. A different review
for an equivalent sent action is rejected and identifies the original review.

`paymentStatus` and `cancellationStatus` report the **local journal**. They do not
poll a bank or claim that funds settled. A stored native response can recover its
recorded result after a process interruption without resending the mutation.

Offline lifecycle tests cover concurrent confirmation, cross-review duplicate
protection, server idempotency preservation, exact review confirmation,
expiry/owner/card binding, timeout uncertainty, partial/step-up responses, durable
write failure, response recovery, source alias selection and frozen-request
integrity. No real payment or cancellation is needed to run these tests.
