# Complex basket comparison: primary agent and local Qwen

This suite tests the **production tools and ordering code**, with a deterministic
backend implementing a richer menu, pickup stores, a saved delivery address,
server quotes and injected failures. It cannot purchase: `order_confirm` is
absent from the model tools, and the backend refuses `/v1/place_order`.

The primary coding agent authored and executed reference tool trajectories.
They are recorded separately and are **not shown to Qwen**. Qwen receives only
the same user request, production tool descriptions/schemas and generic shopping
assistant instructions through Pi. It has no shell, filesystem, browser, Android,
network or account-credential tool. The reference is not an independently sampled
second-model benchmark.

The fixed scenarios cover multiple customizations of the same drink, mixed food
and drinks, per-drink modifier counts, quantities, literal kitchen instructions,
brand ambiguity, unavailable products/options, a missing option on the last
basket line, delivery fees, a second pickup store, a spending limit, a required
card, changed native/catalog IDs, repeated preparation and an interrupted
multi-item addition. Another twelve basket requests are generated with a fixed
seed, varying products, quantities, sizes, milk, sweetness, extra shots and store.
They are held out from interface-design runs.

Grades compare the authoritative cart with the requested **full** specification,
not just the model's prose: quantities, sizes, selected modifiers and counts,
instructions, intact pre-existing/partial carts, no extra additions on replay,
actual prepared total and zero payment calls. An unavailable product may be
correctly rejected at discovery without making a doomed preparation call.
Final prose and trajectory comparisons still require inspection: regex checks
cannot establish that every statement is true or that every agent will succeed.

## Batch discovery in v0.3.1

`product_find` accepts all basket queries together and can include saved delivery
addresses. Address-only reads use an empty query list plus `includeAddresses:true`.
The six-tool ordering profile retains the standalone address capability through
combined discovery; the original `addresses` CLI/advanced tool is unchanged.
Fresh preparations can therefore use discovery → prepare; saved preparations
still take one call. Known exact labels can go straight to preparation.

An eight-case frozen Pi/Qwen comparison kept all cart/outcome assertions passing
while reducing total attempted calls from 23 to 20 against the latest prior
runs of those same cases. Rejected argument calls count toward this total.
Clarifying the base-product query and fallback-only options descriptions then
passed five targeted checks: mixed baskets and delivery each took two calls,
an unavailable-choice request stopped after discovery, and known labels used
one successful preparation plus one rejected argument attempt. These phases
are recorded separately in `results.json`, with source hashes.

All 173 automated checks pass on macOS and Linux ARM64. Read-only live Linux
checks returned two actual products with options and saved addresses in one CLI
call, and verified address-only lookup. No cart item or order was created.
Partial errors preserve completed lookups; retry only failed queries. Duplicate
queries are coalesced and cart context initializes once per batch. Fresh cart,
identity, modifier and checkout validation during preparation is unchanged.

## Observed results (October 29, 2026)

- The frozen 27-case comparison passed all cart/outcome assertions, including
  twelve generated held-out requests. The primary agent used 65 calls; Qwen
  attempted 71 (69 executed, two schema-validation errors). Nineteen executed
  tool sequences matched exactly. Median extra calls: zero.
- Live testing then found two additional failures: a packaged product represented
  no size with `null`, and Qwen mistook the syrup limit of three for the requested
  count. The validator now normalizes absent/null sizes; ordinary modifiers
  default to one, while explicit counts still work. Option results distinguish
  `defaultCount` from `maxAllowedCount`.
- Eight targeted model reruns after those changes passed, including the new
  capacity/default regression, mixed baskets, explicit multiple shots, delivery,
  separate customizations and interrupted drafts. They had zero schema errors.
  Recorded calls from all 27 earlier cases were also replayed successfully on
  the final implementation; this replay involved **no new model inference**.
- The two final real-API comparisons matched the primary agent's exact baskets
  and reviews: $35.96 for separate customized coffees (two calls each), and
  $28.51 for four bottled teas plus two customized coffees (three reference calls,
  four Qwen calls). No real purchase was submitted; test carts were restored empty.
- Three additional saved-recipe tests used a different name and generic tool
  descriptions, with no fixture-name examples; each completed in one call.
- All 164 automated checks passed on macOS and Linux ARM64.

[results.json](results.json) records per-case calls, assertions, source hashes and
sampling settings. Earlier exploratory runs with reasoning disabled or default
sampling failed several tasks; those results are not hidden or pooled with the
scored comparison. Failure types and the resulting changes are documented above.

Some final wording still needs care: Qwen occasionally called a prepared cart
“reserved,” although no inventory reservation was verified. The tool's verified
state remained prepared/not placed. These tools validate the submitted request;
they cannot prove that a model interpreted every user's words correctly. The
exact server-backed review remains necessary before purchase approval.

## Reproduce

Use Pi 0.99.2, Ollama and the existing `qwen3.6:35b` weights. No fine-tuning is
involved. For repeatable sampling create a model alias with the same weights:

```text
FROM qwen3.6:35b
PARAMETER temperature 0
PARAMETER seed 20261029
```

Save that as a Modelfile and use `ollama create rea-erewhon-qwen35b-eval -f FILE`.
The model is a Q4_K_M MoE with 35.5B total parameters with 256 experts and 8 selected per routing step according to its local
model metadata. This is not a dense 35B model. Use an isolated Pi model configuration
as shown in the parent README, changing its model ID to the alias above.

```sh
# Execute the coding-agent-authored reference against the same scenarios.
EREWHON_EVAL_OUTPUT=/absolute/private/reference \
node erewhon/eval/complex/reference.mjs

# Independent Qwen runs. The extension never reads the reference trajectories.
PI_CODING_AGENT_DIR=/absolute/private/pi-agent \
EREWHON_EVAL_MODEL=rea-erewhon-qwen35b-eval \
EREWHON_EVAL_THINKING=low \
EREWHON_EVAL_OUTPUT=/absolute/private/qwen \
node erewhon/eval/complex/run.mjs
```

Pass scenario names as arguments to select a subset. Each case has an isolated
fake account/cart and a 240-second timeout. Output contains private owner-only
traces, transcripts, grading and hashes of the production source used by the
run. Keep these out of Git. `EREWHON_EVAL_THINKING=off` allows an additional
stress test; do not pool reasoning-on/off or different tool versions into a
single success rate. Source and schemas must stay unchanged during a scored run.

The separate `../pi-live-extension.mjs` adapter exercises the real headless Linux
CLI over SSH with only lookup, preparation and status tools. Cart changes are
real, but no confirmation tool is exposed. Start with an empty cart, preserve
any pre-existing items, remove only identified test rows afterward, and verify
the final cart. Real quotes, account data and transcripts stay private.
