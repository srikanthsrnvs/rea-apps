# Troubleshooting and recovery

Start with `claude-chat auth status`. For a turn, keep its `operationId` and use
`claude-chat turn status --operation-id ID`. These commands inspect existing
work; they do not submit another login credential or chat message.

## Login

| State or error | Meaning and next step |
| --- | --- |
| `code_required` | Use the newest email's code or copied official button URL with `auth complete`. A visible code is not guaranteed. |
| `verification_starting` | A relay is being created. Repeating `auth complete --login-id ID` can inspect/resume startup; it does not request another email. |
| `verification_waiting` | Open the current `approvalUrl` in the user's own browser. An invisible verification can finish by changing only the tab title. |
| `validation_pending` | Verification succeeded, but the independent account read has not finished. Repeat `auth complete --login-id ID` without supplying another code. Only the account GET is retried. |
| `LOGIN_VERIFICATION_REJECTED` | Claude returned a known rejection. The old saved session is preserved. Cancel this attempt before deliberately starting a fresh one. |
| `LOGIN_OUTCOME_UNKNOWN` | A credential-changing request may have reached Claude, but its result was lost. It is not replayed. Inspect status; cancel and start a new attempt if recovery cannot establish the result. |
| `VERIFICATION_HOST_UNAVAILABLE`, or verification `unavailable` | The old relay is unreachable. Its stale URL is not reused. Cancel the pending login and start again. |
| `VERIFICATION_EXPIRED`, `LOGIN_EXPIRED`, or expired verification | The proof or local attempt is too old. Cancel and start a fresh login; do not reuse old proof. The local deadline is not a guarantee of the email's server expiry. |
| `VERIFICATION_TUNNEL_UNAVAILABLE` | Rerun the Linux installer or configure an executable absolute `CLAUDE_CHAT_CLOUDFLARED` path. The tunnel is needed only during verification. |
| `additional_verification_required` | Claude requires another authentication step, such as SSO/MFA. Its additional-step adapter is not currently implemented; do not invent a completed login. |

Cancel with `claude-chat auth cancel --login-id ID`. Use
`claude-chat login --replace --email ADDRESS` for an intentional replacement of
saved credentials. `claude-chat auth logout` removes local authentication, not
conversations on Claude's service.

`authenticated: true` reports a saved, previously validated session; it is not a
fresh server check on every status call. During replacement it can remain true
while `pending` describes the new attempt. `claude-chat account` performs a
current account read. If the service revokes or expires the session, sign in
again rather than manufacturing or replaying credentials.

## Chats and turns

| State or error | Meaning and next step |
| --- | --- |
| `ORGANIZATION_REQUIRED` | Several memberships need an explicit selection. Run `account`, then select a returned chat organization. |
| `CHAT_ORGANIZATION_REQUIRED` | The selected membership is API-only. Choose one whose capabilities include `chat`. |
| `TURN_PENDING` | An earlier local turn remains unresolved. Inspect the operation ID returned with the error before sending anything else. |
| `request_pending`, `streaming`, or `outcome_unknown` | A response may still be running or its outcome may be unknown. Use `turn status`; do not resubmit with a new ID to bypass the guard. |
| `stop_requested` | The server acknowledged the stop request. Continue inspecting until terminal response evidence arrives. |
| `STOP_OUTCOME_UNKNOWN` | The stop's response was lost. Inspect the turn; the stop is not automatically repeated. |
| `not_submitted` | A recovered journal proves the completion POST had not started. This operation is closed locally; a deliberate new operation can submit the prompt. |
| `rejected` | A known refusal was returned. Inspect its error and conversation before deliberately starting another operation. |
| `OPERATION_INPUT_CHANGED` | The same UUID was reused with different arguments. Keep identical arguments for recovery; a genuinely different message needs a different operation. |
| `SESSION_CHANGED` | The operation belongs to another saved login generation. It cannot be resumed under the current saved session. |
| `RATE_LIMITED` | Claude returned HTTP 429. Respect the limit; the CLI does not retry or rotate identities. |
| `RESPONSE_TOO_LARGE` | The response exceeded the transport limit. No truncated response is labelled complete. |

An unresolved operation can remain blocked if neither an authoritative response
nor matching stored messages can establish its outcome. There is no CLI
force-forget command. Preserve its journal for investigation instead of deleting
state to manufacture certainty or automatically retrying the message.

## Supported limits

- Chat history: 1–100 rows per request; `--all` stops at 500 pages and reports
  continuation information rather than claiming completion.
- Search: ten native hits; request-side search continuation is not implemented.
- Plain-text prompts: at most 1 MiB. Attachment upload, edits and deletion are
  outside the current command set.
- Normal HTTP responses: at most 32 MiB. SSE content reconstruction: at most
  16 MiB, with separate bounded frame/line limits.
- New-chat and reply requests omit the model unless explicitly provided. The
  host's timezone is used unless an IANA `--timezone` is supplied.
- Linux ARM64 has been tested live. Linux x86-64 is supported by setup, but
  does not have the same live validation record. Live stopping of a long
  production response has not been tested; stop recovery has mocked coverage.

## Local data and diagnostics

Default state is `~/.config/claude-chat-cli` or
`$XDG_CONFIG_HOME/claude-chat-cli`; `CLAUDE_CHAT_STATE_DIR` overrides it. It is
separate from `~/.claude`. Session and journal files use owner-only permissions.
Logout removes the saved session and pending login, while turn journals remain
available for recovery. It does not erase server chats or revoke sessions on
other devices.

Normal success and cancellation clean up temporary verification files after
the owned worker closes. Failed or uncertain worker outcomes may retain private
diagnostic files for inspection. If reporting a problem, include the
command name, error code, phase and HTTP status; omit session files, cookies,
email links, verification URLs and conversation contents.

For development checks, run from the repository root:

```sh
node --test claude/test/*.test.mjs
node claude/scripts/update-command-docs.mjs --check
sh -n claude/scripts/setup-linux.sh scripts/setup-linux.sh
```
