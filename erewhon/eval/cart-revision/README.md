# Live multi-turn cart revision through Pi

The requests are sent sequentially to **one persistent Pi/Qwen session**:

1. “Add my usual coffee to the cart.”
2. “Make it 3 actually.”

The follow-up receives the first turn's full history. No reference trajectory,
recipe contents, item reference or tool choice is supplied in either prompt.
The model sees the production tool schemas and generic shopping instructions.
It has no shell, filesystem, browser or Android access. `order_confirm` is absent.

Before changing the interface, Qwen tried `order_prepare_saved` with
`my usual coffee`, then `my-usual-coffee`. Both failed; it asked the user to repeat
the recipe, and the actual cart remained empty after both turns. The old simple
profile also lacked a quantity-edit tool. This was an interface failure, not a
successful test.

The corrected interface separates cart work from checkout. It accepts spoken
saved labels and returns exact customized `itemRef` handles. Quantity edits are
absolute, preserve the saved favorite and other cart rows, and verify the native
server result. The live native cart omitted its size catalog; its unambiguous
selected size label is now included in the compact view, with a regression test.

On the corrected production code, both the primary agent's authored/executed
reference and Qwen used `cart_add_saved` → `cart_set_quantity`: **one call per
turn**, quantity one then three, no argument errors or additional discovery.
The independently read native cart confirmed the same product, size, modifiers,
modifier counts and instructions; the saved recipe remained unchanged. Neither
trajectory called checkout or payment. The reference's exact test-owned row was
removed before Qwen's run so both started with an empty cart. Qwen's final cart
was left at the user's requested quantity three.

This is one observed live conversation, not a general reliability score or an
independently sampled stronger-model benchmark. The reference was authored and
executed by the primary coding agent. Sampling used the same installed 35.5B
Q4_K_M Qwen MoE, Ollama temperature zero/seed 20261029 and Pi 0.99.2 as the complex
suite. The local model's OpenAI-compatible HTTP transport is a wire format;
**Pi**, not an OpenAI agent harness, runs the session.

`results.json` contains sanitized measurements and production source hashes.
Private transcripts, server carts, account data and live references stay outside
the repository. All 185 automated checks pass on macOS and Linux ARM64, including
preserving separately customized rows, repeated edits, stale references, uncertain
updates, pending-payment guards, and rejecting approval of an older checkout
review after a cart edit.

## Reproduce

This is a **real cart test**, not a fixture. It requires an authenticated remote
CLI, an existing saved recipe matching the first prompt, and an empty cart. It
stops if the initial cart is occupied and leaves the final requested cart intact.
Use the local Pi/Ollama model configuration in the complex suite's README.

```sh
PI_CODING_AGENT_DIR=/absolute/private/pi-agent \
EREWHON_EVAL_SSH_HOST=user@linux-host \
EREWHON_EVAL_SSH_SOCKET=/absolute/private/ssh-control.sock \
EREWHON_EVAL_SSH_ALIAS=known-host-alias \
EREWHON_EVAL_REMOTE_CLI=/home/user/.local/bin/erewhon \
EREWHON_EVAL_OUTPUT=/absolute/private/fresh-run \
node erewhon/eval/cart-revision/run.mjs
```

Set `EREWHON_EVAL_PROMPTS` to a JSON array to use different requests. Do not expose
payment confirmation to this harness. Attempted tool calls, including rejected
arguments, are counted from Pi's message events; a successful CLI result alone
is insufficient. Cart snapshots are read independently after each settled turn.
