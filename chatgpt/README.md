# ChatGPT and Codex CLI

Lightweight tools for a ChatGPT account and its Codex cloud tasks. The host runs Node HTTP and WebSocket requests. It does not run Android, Chromium, a remote desktop, or a browser automation helper.

## Validation status

The installed Android app `com.openai.chatgpt` version `1.2026.286` is the protocol reference. **Device login, account validation, conversation listing/search, reading the latest chat, and a new ChatGPT message/reply were verified on headless Linux ARM64 on October 19, 2026.** The sent message was independently read back from the account. These are observations for the tested account and service version, not a guarantee of future private API compatibility.

Login uses OpenAI's official Codex device-code flow. The Android browser login was rejected by its device-integrity check and is not the normal CLI login. The device-granted session was separately verified to authorize the tested ChatGPT operations. Codex cloud task listing, paginated task reads, models, and environments were also verified. Cloud task creation, replies, and interruption have protocol tests but were not exercised on live tasks.

ChatGPT may require additional verification for other requests or accounts. The implementation does not fabricate integrity tokens. A passing local test is not evidence that a server accepted a login or a message.

## Install

```sh
./scripts/setup-linux.sh --chatgpt-only
chatgpt tools
```

Or from this directory, run `./scripts/setup-linux.sh`. The installer reuses a compatible Node runtime or downloads Node 24.21 with checksum verification. It supports Linux ARM64 and x86-64, and installs the locked lightweight WebSocket dependency without package scripts.

For development on macOS:

```sh
npm --prefix chatgpt ci --ignore-scripts
node chatgpt/bin/chatgpt tools
node --test chatgpt/test/*.test.mjs
```

## Login

```sh
chatgpt login --email you@example.com
chatgpt auth poll --login-id LOGIN_ID
chatgpt auth status
```

Open the returned `approvalUrl` in your own browser and sign in to ChatGPT. Enter the returned `userCode` without a dash, then call `auth poll` with the same `loginId`. Follow `retryAfterMs` if approval is still pending. If the page asks, first enable **device code sign-in** in ChatGPT's **Settings → Security**. No callback URL needs to be copied. The CLI checks PKCE, the identity token signature, the requested account, and an independent account read before saving the session.

Codes expire after fifteen minutes. `auth cancel --login-id ID` removes a pending attempt; `logout` removes local credentials. A network failure during a one-time code exchange is reported without silently replaying it. The old `auth complete` callback command is retained for protocol recovery only; it is not part of device login. See the [device login protocol](docs/device-auth.md).

Credentials are stored with owner-only permissions under `~/.config/chatgpt-cli`, or `$CHATGPT_STATE_DIR`. Rotating refreshes are serialized and uncertain exchanges are not silently replayed.

## ChatGPT

```sh
chatgpt account
chatgpt models
chatgpt chats list --all
chatgpt chats search --query "travel plans"
chatgpt chat get --chat-id CHAT_ID
chatgpt chat messages --chat-id CHAT_ID --before MESSAGE_ID
chatgpt chat new --operation-id UUID --prompt "Hello"
chatgpt chat reply --operation-id UUID --chat-id CHAT_ID --prompt "Continue"
chatgpt turn status --operation-id UUID
chatgpt turn stop --operation-id UUID
```

Read commands preserve rich messages and conversation branches. List pages use offsets; search uses the server's opaque cursor. `chat get` returns the server's requested window of turns, with an explicit indication if the selected branch is incomplete. Use `chat messages` to fetch older turns.

Message commands choose the account's returned default model, or accept `--model MODEL`. They require an operation UUID created before submission. Keep it for status checks. A lost network response must not be retried as a new operation: the original may already have been accepted. Successful completion is confirmed by reading the saved message from the server, not by a closed stream.

## Codex cloud

```sh
chatgpt codex environments
chatgpt codex models
chatgpt codex list --all
chatgpt codex search --query "parser"
chatgpt codex get --thread-id THREAD_ID
chatgpt codex get --thread-id THREAD_ID --cursor CURSOR --limit 3
chatgpt codex new --operation-id UUID --environment-id CONFIG_ID --prompt "Inspect the failing parser test"
chatgpt codex reply --operation-id UUID --thread-id THREAD_ID --prompt "Explain the proposed fix"
chatgpt codex stop --operation-id UUID --thread-id THREAD_ID --turn-id TURN_ID
chatgpt codex operation --operation-id UUID
```

Codex uses the native cloud app-server connection and does not require a separate Mac to control. Task reads return a bounded page of turns with a cursor; use `--all` deliberately for large histories. A new task requires a selected published environment configuration. The transport surfaces requests for user input or approval and never approves them itself. Full interactive approval handling remains under integration.

All commands return JSON. `chatgpt tools` returns their input schemas; add `--pretty` for readable output. Prompt files are supported with `--prompt-file` instead of `--prompt`.

See [agent workflows](docs/agent-guide.md), [authentication evidence](docs/auth-protocol.md), [chat reads](docs/chat-protocol.md), [chat writes](docs/chat-write-protocol.md), and [Codex protocol](docs/codex-protocol.md).
