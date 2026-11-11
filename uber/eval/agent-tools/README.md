# Uber Eats agent usability evaluation

Run the actual local Qwen model in the **Pi agent harness**. The OpenAI-compatible API is only the wire format to local Ollama; no cloud model is used. No training, LoRA, browser or Android is involved.

The evaluation separates two things:

- **Guarded live reads:** authenticated account locations, restaurant search and item options use the real CLI. Every real cart edit, checkout, purchase and cancellation is blocked before dispatch. A blocked write is an error, never evidence of a prepared cart.
- **Isolated native-contract scenarios:** the production CLI, selection validation, cart service, checkout and operation journal run against an in-memory native DTO backend. Draft edits and checkout reviews are allowed here. Purchase/cancellation endpoints throw, and unmatched endpoints fail; this backend has no network transport.

The generic system prompt is identical across profiles: “You are a shopping assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately.” The model gets only the Eats tools: no shell, file writer, browser, skills, repository instructions or hidden case-specific system prompt. Follow-up turns share one Pi conversation. New cases get new sessions. `legacy` selects the seven original tool definitions and full outputs; the default profile selects the simplified tools and compact views.

The grader checks the actual native cart, per-item modifier quantities, nested choices, literal kitchen instructions, fulfillment, checkout tip/total, preserved lines, operation state and write count. It also counts attempted tool calls from assistant messages, including calls rejected by schema validation. Model completion claims are reviewed separately. `reference.mjs` executes an authored reference through the same production tools and backend; it is not a second sampled model or a mathematical lower bound on calls.

## Reproduce

Requires an existing local `qwen3.6:35b` model, Ollama, Pi, Node >=22.19 and Python 3. Model weights and sessions are not bundled. Start Ollama if needed, then create the reproducible evaluation alias and private Pi config:

```sh
umask 077
ollama create rea-uber-eats-qwen35b-eval -f uber/eval/agent-tools/Modelfile
mkdir -p /tmp/eats-pi-agent
cp uber/eval/agent-tools/models.example.json /tmp/eats-pi-agent/models.json
cp uber/eval/agent-tools/settings.example.json /tmp/eats-pi-agent/settings.json
export PI_CODING_AGENT_DIR=/tmp/eats-pi-agent
export EATS_EVAL_OUTPUT=/tmp/eats-eval-new-run
python3 uber/eval/agent-tools/run-cases.py latte mixed unavailable unknown
node uber/eval/agent-tools/grade.mjs "$EATS_EVAL_OUTPUT"
node uber/eval/agent-tools/reference.mjs
```

The output directory must be new. Set `EATS_EVAL_PROFILE=legacy` to compare the original schemas. The harness aborts at 12 tool executions per user turn and marks the turn aborted; a 15-minute session watchdog also applies. Aborted runs are not passes.

For an interactive guarded live conversation, use an authenticated local Uber CLI session and a new **private** output directory:

```sh
export EATS_EVAL_OUTPUT=/tmp/eats-live-new-run
export EATS_EVAL_EXTENSION="$PWD/uber/eval/agent-tools/pi-live-extension.mjs"
python3 uber/eval/agent-tools/chat.py
# Enter one prompt per line. EXIT closes the session.
```

Live traces can contain account addresses and cart contents. Keep all transcripts, state, credentials and native responses outside Git. The public result file contains only aggregate measurements and synthetic-case outcomes.

See [results](results.md) for the measured run, failures and scope limits.
