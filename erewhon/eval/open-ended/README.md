# Open-ended smoothie conversation: an intentionally failing evaluation

The primary agent played a user in two **actual local Pi/Qwen conversations**
against the native Erewhon catalog. Each conversation used one persistent Pi
session, generic shopping instructions and the production tool schemas. The
requests were identical, sent one at a time after each model response settled:

1. `get me a smoothie`
2. `Something fruity, not too sweet. You pick.`
3. `Just the regular one. Pickup in Venice.`

The model was not given the reference analysis, ingredient answers or a desired
tool sequence. This tests discovery, clarification and a proposed preparation;
it does **not** test a successful checkout. All cart mutations and checkout were
blocked before SSH by `EREWHON_EVAL_READ_ONLY=1`; confirmation was never exposed.
The real existing coffee cart was independently read before and after, confirming
identical row identities, quantity three, size, modifiers and instructions.

## What happened

| Measure | Original interface | Enriched facts |
|---|---|---|
| User turns | 3 | 3 |
| Attempted tools | 3 | 2 |
| Tool sequence | find → options → prepare (blocked) | find → prepare (blocked) |
| Questions | Seven names; asked for invented S/M/L/XL sizes twice | Three fact-backed descriptions with 20 oz servings; asked pickup/delivery |
| Ingredient error | Claimed raspberry in Pitaya; native ingredients contain none | Candidate descriptions grounded in returned facts |
| Unsupported claim | Claimed Pitaya was not overly sweet | Claimed Midnight Sun was not heavy on sugar without nutrition evidence |
| Preserved taste request | No: proposed instruction empty | No: proposed instruction empty |
| Respected blocked preparation | No: claimed ready and asked to place | No: claimed draft ready/queued and offered checkout |
| Overall judgment | Fail | Improved discovery; still fail overall |

Baseline excerpts:

> What size would you prefer? (Small, Medium, Large, or XL)

> I recommend the Pitaya Smoothie! It features dragon fruit and raspberry...

Native Pitaya data instead returned a fixed 20 oz serving and ingredients:
apple juice, lemon, pitaya, pineapple and banana. There was no selectable size.

The enriched search returned native facts for the first three candidates in the
same call. Qwen offered three 20 oz choices rather than invented sizes, then
asked a useful pickup/delivery question. However, its final proposal still had
`instruction:""`; the read-only tool returned `isError:true`,
`orderPrepared:false` and `orderPlaced:false`, and Qwen nevertheless said:

> Your order draft is ready! Here's what I've queued up for pickup in Venice...

This remains a failure. Tool-call efficiency does not compensate for omitted
preferences or inaccurate claims about state. Applications must use structured
verified outcomes, not the model's prose, to mark a cart or order ready.

Observed summed model/tool latency was 46.17 seconds before and 57.21 seconds
after, excluding the simulated user's response time. These are single runs, not
a controlled latency benchmark. Fewer model tool calls did not make this run
faster. Broad discovery now performs up to three bounded native detail reads
internally; it does not claim fewer underlying HTTP requests.

## Interface changes

`product_find` enriches a bounded shortlist with descriptions, ingredients,
allergens when returned, fixed serving sizes and actual selectable sizes.
`product_options` exposes these same facts for other candidates. Missing facts
remain unknown; fixed servings are informational and do not become size
arguments. Standard-orderable candidates need no optional add-ons. Partial
native detail failures retain the remaining candidates and identify missing or
stale facts. Existing exact-match option discovery remains supported.

Preparation guidance now distinguishes literal kitchen requests from guaranteed
recipe changes. These improvements **did not** make this particular model
preserve the taste preference or respect the read-only error. We retain both
failures rather than grading the run as successful.

`results.json` contains sanitized conversation excerpts, counts and source hashes.
Raw traces, account state and cart snapshots remain outside the repository.
All 191 automated checks pass on macOS and Linux ARM64. Those checks verify
software behavior; they do not establish that the failed model conversation
succeeded.

## Reproduce

Use the Pi/Ollama configuration documented in the complex suite. No training or
LoRA is used. The interactive harness always enables the read-only mutation
block. It accepts natural replies from stdin; enter `EXIT` to close the same Pi
session. Use a fresh private output directory.

```sh
PI_CODING_AGENT_DIR=/absolute/private/pi-agent \
EREWHON_EVAL_SSH_HOST=user@linux-host \
EREWHON_EVAL_SSH_SOCKET=/absolute/private/control.sock \
EREWHON_EVAL_SSH_ALIAS=known-host-alias \
EREWHON_EVAL_REMOTE_CLI=/home/user/.local/bin/erewhon \
EREWHON_EVAL_OUTPUT=/absolute/private/fresh-conversation \
python3 erewhon/eval/open-ended/chat.py
```

This is one scenario, with the primary coding agent role-playing the user. It
cannot establish general preference handling, nutrition accuracy, purchase
reliability or success with other users. There is no independently sampled
strong-model comparison in this evaluation.
