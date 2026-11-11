# CLI compatibility and final verification

The smaller agent profiles are views over the full CLI. No original operation
was removed. `erewhon tools --advanced` includes all 30 original tool names,
commands, original argument schemas and optional parameters, plus the new
ordering and cart helpers: 41 tools in total. The recommended profile has 24;
the focused ordering profile has ten.

| Capability | Preserved access |
|---|---|
| SMS login, login completion/status/cancel/validation/logout | `login`, `auth ...` |
| Profile, membership, rewards history | `profile`, `membership`, `rewards` |
| Purchase history, receipts, existing order details | `history`, `receipt`, `order detail` |
| Stores, departments, category browsing | `stores`, `categories` |
| Pagination, search facets and store-specific catalog indexes | `search --page ... --index ...` and department/brand/category filters |
| Full product data, nutrition and substitution choices as returned | `product --id ...` |
| Batched discovery and named customizations | `product find`, `product options` |
| Recipe save, show and interrupted-draft reset | `recipe save`, `recipe show`, `recipe reset` |
| Delivery addresses, serviceability checks and address creation | `addresses`, `address check`, `address add` |
| Pickup/delivery selection | `fulfillment`, `fulfillment select` |
| Low-level native cart addition, quantity changes and exact-row removal | `cart add`, `cart update`, `cart remove` |
| Compact cart view, saved-favorite addition and absolute quantity edits | `cart view`, `cart add-saved`, `cart set-quantity` |
| Current-cart or named-basket checkout review | `order prepare`, `order prepare --recipe ...`, `order prepare --json ...` |
| Available scheduled windows, selected card, tips, reward use and coupons | `checkout` / current-cart `order prepare` with their existing flags |
| Explicit purchase confirmation and uncertain-outcome reconciliation | `order confirm --confirm`, `order status`, `order operation` |

Saved-recipe preparation uses ASAP. The original current-cart checkout path
retains explicit server scheduling/payment/tip/reward/coupon controls. Choosing
a simpler profile does not delete the advanced path or remove existing account,
recipe or order journals. Literal saved names remain valid; spoken names with
an ambiguous “my” prefix stop instead of choosing a different favorite.

## Verification on 2026-10-29

- All **197 automated checks** pass on macOS and Linux ARM64. A frozen contract
  from the pre-change CLI checks all 30 original commands and parameter schemas;
  another check requires the full inventory to include every focused helper.
- All **29 reference basket scenarios** pass with current production code and
  the deterministic no-purchase backend. These cover both fulfillment modes,
  separate customizations, quantities, instructions, required card, budgets,
  unavailable choices, partial/occupied carts and changing product identities.
- All **27 recorded Qwen trajectories** replay with their original arguments
  against current code and retained legacy CLI reads. Replay invokes **no model**
  and does not represent a new Qwen evaluation. The focused model profile stays
  unchanged; compatibility replay can use the original standalone address read.
- The packaged runtime includes the CLI, all imported runtime modules, Linux
  launcher and documentation. It starts independently from the working tree.
- Read-only Linux checks validate the existing login, full inventory and catalog
  discovery. The real coffee cart and saved usual recipe remain unchanged.

Payment, OTP and cart mutations in automated verification use isolated fixtures;
no real purchase, login-code request, address change or cart edit is required.
Private account responses and raw traces remain outside Git. Historical model
reports retain their own source hashes and check counts.

## Known model limitation

[The open-ended smoothie experiment](../eval/open-ended/README.md) still fails:
Qwen dropped a taste preference, made an unsupported sugar claim and implied
readiness after an explicitly blocked preparation. Better discovery and passing
software compatibility checks do not make those model responses correct.
Structured server cart/review/order outcomes remain authoritative; only a
confirmed order ID with `orderPlaced:true` proves placement. Uncertain payment
outcomes remain unknown and must not be submitted again.
