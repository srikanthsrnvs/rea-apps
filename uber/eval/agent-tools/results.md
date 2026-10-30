# Local Qwen / Pi results — 2026-10-29

**The initial toolset was not good enough for a small model. The revised tools substantially improve explicit cart requests, but the open-ended live test still fails. This is not a claim that the toolset is optimal or foolproof.**

Measured on a MacBook Pro M3 Max with 48 GiB memory, using the existing local `qwen3.6:35b` model (35.5B total parameters, Q4_K_M), Ollama 0.30.7 and Pi 0.99.2. Temperature 0, seed 20261029, 32,768-token context, 4,096 output-token limit, Pi thinking level low. The model received only the Eats tools. There was no cloud inference, browser, Android, file-writing tool or training.

## What changed

- Original cart edits required a JSON filename. A tool-only agent could not create that file. Recommended cart arguments are now flat objects with `items`, an address and named `choices`. The CLI compiles exact names against fresh native item data and validates the resulting nested selections before writing. Both file input and native customization trees remain available.
- Native defaults are offered as a copyable `standardItem` only when they pass validation. Required choices, unavailable options, duplicate names and inactive nested branches are checked rather than guessed. Explicit paths distinguish otherwise ambiguous groups, including repeated group IDs in separate branches.
- Changing two drinks to **three total** takes one quantity-only update, preserving the existing recipe and other lines.
- An eighth tool exposes operation inspection after an uncertain write. The seven original advanced definitions are preserved byte for byte and covered by a digest test.
- Search defaults to five feed entries in the agent view, with server pagination and every returned item retained. Full CLI output and complete native responses remain accessible. On the same captured search, compact output was **34,051 bytes versus 49,111 bytes**. A later live five-entry page was **9,629 bytes**, with four restaurants and `nextOffset: 5`; this later result is not a controlled same-catalog comparison.

## Explicit synthetic requests

These scenarios use the production CLI/service and native-contract DTOs with an isolated in-memory backend. They are not real orders or live checkout validation. Counts include follow-up turns; time includes local model inference and tool execution.

| Request | Qwen calls by turn | Authored reference | Qwen time | Actual-state result |
| --- | --- | --- | --- | --- |
| Two large oat lattes, nested no-foam choice, two extra shots **per drink**; then three total | 4 + 1 | 4 + 1 | 65.71 + 23.55 s | Pass: exact nested recipe, 2 → 3 total, one update |
| Burger with no onions and sauce on the side; two no-salt fries; delivery, $2.50 tip; then remove burger | 6 + 2 | 6 + 1 | 84.22 + 34.89 s | Pass: instructions retained, $24.50 review, only fries remain |
| Oat milk required but sold out; no substitutions | 3 | 3 | 25.42 s | Pass: unavailable option inspected, zero writes |
| Lost response after an accepted cart creation; user explicitly requests operation inspection and stopping | 5 | 5 | 43.01 s | Pass: exact operation inspected, one accepted write, no retry |
| Same lost response, ordinary smoothie request with **no recovery instructions** | 6 | 5 | 32.98 s | Pass: operation inspected, then cart read confirmed the item; one write |

Across the first four cases, Qwen used **21 calls versus 20** for the authored reference. Its extra call refreshed checkout after removing the burger, giving a new $13.50 total instead of leaving the previous price review stale. In the ordinary unknown-outcome case, its extra cart read verified the current state before reporting the smoothie present. These are useful calls, not duplicate mutations.

The reference is an explicitly authored trajectory executed through the same production tools, not an independently sampled larger model or a proof of minimum calls. Menu requests without a section ID can trigger an additional native menu lookup inside one tool call, so equal tool counts do not imply equal HTTP traffic.

Machine-readable checks are in [measured.json](measured.json); the synthetic prompts, actual tool arguments and final answers are in [trajectories.json](trajectories.json). Real account transcripts are excluded.

## Failures retained in the assessment

The original latte toolset looped on JSON-as-a-filename and missing-file errors. It was stopped after **12 attempted/completed calls, eight errors and zero writes**; the quantity follow-up was not run. An intermediate structured-request design still caused JSON-string and malformed nested-ID arguments. An initial named-choice design also rejected an ancestor-only path; the final compiler accepts exact ancestor paths or full paths, while rejecting wrong paths. These interrupted development runs are not counted as passes.

The guarded live conversation used the same two user prompts before and after:

1. “Get me a smoothie.”
2. “Something fruity, not too sweet. You pick. One regular smoothie delivered to that home address, no extras. Don't order.”

| Profile | Calls by turn | Time | Result |
| --- | --- | --- | --- |
| Original | 3 + 1 | 97.99 + 69.84 s | Fail: JSON in filename field, skipped item inspection, false cart-success claims after blocked writes |
| Intermediate compact/object version | 2 + 1 | 50.28 + 63.33 s | Fail: better initial question, still skipped inspection and claimed cart success after rejection |
| Final flat/named version | 2 + 1 | 35.46 + 42.40 s | Fail: useful three-item shortlist, but still skipped item detail, invented sweetness/ingredient claims and reported a cart that was never created |

Lower call counts are **not** a success when required work is skipped. The live mutation guard returned the same explicit error envelope in these comparisons, including `cartChanged: false` and `orderPlaced: false`. We did not weaken the guard or alter the system prompt to manufacture a pass. Restaurant availability changed between live runs, so latency/catalog comparisons are observational.

A production agent must treat tool results as the source of state and never present a rejected mutation as completed. The CLI can validate selections, preserve carts, require a reviewed purchase plan and prevent a blind duplicate write; it cannot guarantee that an arbitrary model describes errors truthfully. The open-ended failure remains a limitation of this evaluation and should block claims of universal small-model reliability.

## Validation and scope

- Full Uber test suite: **377 passed, zero failed, one skipped** (the existing Linux-only `flock` test is skipped on macOS).
- Isolated tests cover named/default/nested options, ambiguous paths, sold-out options, preserved quantity edits, decimal tips, operation inspection, inline JSON validation, pagination, complete native access, and the live no-write guard.
- All live purchases, checkout writes, cart edits and cancellations were blocked before dispatch. The three existing real carts retained the same identities, stores, items, quantities, choices, addresses and fulfillment modes. Some payment/tip/edit metadata differed between reads; we do not claim the entire remote account state was unchanged.
- No real food was purchased for this audit. New code was exercised on macOS; the Orin was unreachable and this version was not newly deployed or live-tested on Linux.
- One sample per final scenario is not a statistical reliability estimate. Broader cuisines, promotions, unusual customization trees, changing inventory, payment challenges and production account conditions need additional coverage.
