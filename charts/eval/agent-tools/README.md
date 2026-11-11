# Local Qwen / Pi tool evaluation

This evaluates Charts' real tool catalog and service with a local Qwen 35B model
in Pi's RPC harness. It is not an OpenAI model evaluation. The OpenAI-compatible
HTTP transport points only to Ollama at `127.0.0.1`.

See [results.md](results.md) for prompts, observed answers, call counts and limits.

## What is tested

- The unchanged user prompts in `scenarios.mjs`, including a two-turn overlay.
- The production schemas, validation, service, normalization and model text.
- A deterministic injected backend with known prices, dates, units, large
  watchlists and a failing Pine endpoint. This is synthetic data, not a market
  forecast. `reference.mjs` executes an authored primary-agent trajectory using
  the same backend; its answers never enter Qwen's prompt.
- Optional live runs use anonymous, read-only provider requests. Login,
  mutations, shell access and account credentials are unavailable in live mode.

Each case starts a fresh Pi process, with only Charts tools: no built-in tools,
skills, repository instructions, cloud model, or hidden task-specific hints.
Follow-up turns stay in the same conversation. The prompt fixes the evaluation
date to November 7, 2026. Change the scenarios and fixture clock together if
building a new dated benchmark.

## Reproduce

Requires the repository's Node version, Python 3, Pi and a running local Ollama.
Run from the repository root. Put all run artifacts outside the checkout: they
can contain account output if you modify the harness.

```sh
export EVAL_DIR="$HOME/.local/share/rea-apps/private/charts/agent-eval-new"
mkdir -p "$EVAL_DIR/pi-agent"
chmod 700 "$EVAL_DIR" "$EVAL_DIR/pi-agent"
cat > "$EVAL_DIR/Modelfile" <<'EOF'
FROM qwen3.6:35b
PARAMETER temperature 0
PARAMETER seed 20261107
PARAMETER num_ctx 32768
EOF
ollama create rea-charts-qwen35b-eval -f "$EVAL_DIR/Modelfile"
cat > "$EVAL_DIR/pi-agent/models.json" <<'EOF'
{"providers":{"local-qwen":{"baseUrl":"http://127.0.0.1:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"rea-charts-qwen35b-eval","name":"Local Qwen 35B","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32768,"maxTokens":3072,"compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":true,"thinkingLevelMap":{"off":"none"}}}]}}}
EOF
printf '%s\n' '{"compaction":{"enabled":false}}' > "$EVAL_DIR/pi-agent/settings.json"
export PI_CODING_AGENT_DIR="$EVAL_DIR/pi-agent"
export CHARTS_EVAL_NODE="$(command -v node)"
export CHARTS_EVAL_PROFILE=optimized
CHARTS_REFERENCE_OUTPUT="$EVAL_DIR/reference" CHARTS_REFERENCE_COMPARE=1 \
  node charts/eval/agent-tools/reference.mjs
CHARTS_EVAL_OUTPUT="$EVAL_DIR/revised" python3 charts/eval/agent-tools/run.py
python3 charts/eval/agent-tools/grade.py "$EVAL_DIR/revised" "$EVAL_DIR/reference/summary.json"
```

For a historical baseline, export the original Charts tree, install its locked
dependencies and export its catalog before running the same harness:

```sh
mkdir -p "$EVAL_DIR/baseline-app"
git archive eb17514b4ee2f0d68e92c3b096afd6ee97d12254 charts | tar -x -C "$EVAL_DIR/baseline-app"
npm --prefix "$EVAL_DIR/baseline-app/charts" ci
node --input-type=module -e 'import(process.argv[1]).then(m=>console.log(JSON.stringify(m.toolDefinitions)))' \
  "$EVAL_DIR/baseline-app/charts/src/tool-definitions.mjs" > "$EVAL_DIR/baseline-tools.json"
CHARTS_EVAL_PROFILE=baseline \
CHARTS_EVAL_APP_ROOT="$EVAL_DIR/baseline-app/charts" \
CHARTS_EVAL_BASELINE_TOOLS="$EVAL_DIR/baseline-tools.json" \
CHARTS_EVAL_OUTPUT="$EVAL_DIR/baseline" python3 charts/eval/agent-tools/run.py
python3 charts/eval/agent-tools/grade.py "$EVAL_DIR/baseline" "$EVAL_DIR/reference/summary.json"
```

Run cases sequentially to avoid competing for the local model. For live public
integration checks, set `CHARTS_EVAL_LIVE=1`, use a new output directory and choose
only public cases, e.g. `run.py quotes ytd`. Do not grade live prices against the
synthetic reference: inspect the returned live values and timestamps instead.

`run.py` records prompts, attempted calls, model responses, elapsed time and
full tool traces in private output. `model-output.jsonl` measures the bytes
actually presented to the model, not the full renderer dataset. Both remain
available; smaller model text does not remove the full plot rows.

The grader checks requested values, dates, batching, complete lists and selected
known errors. It is not a general truthfulness evaluator. Read the full answers
as well: plausible-sounding interpretations can still be unsupported. A single
seeded pass is regression evidence, not proof of reliability across all prompts.

When finished, remove only the temporary alias if desired:
`ollama stop rea-charts-qwen35b-eval` and `ollama rm rea-charts-qwen35b-eval`.
The base model and the user's Ollama server are retained.
