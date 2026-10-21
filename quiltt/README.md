# Quiltt Sandbox CLI

Bank linking and read-only account data through Quiltt's official Connector and
API. Runs on Linux ARM64/x86_64 or macOS using Node HTTP. No browser, Android,
emulator, extension or npm dependencies run on the Orin. The user signs in and
connects a test institution on Quiltt's own website in their own browser.

**Sandbox only.** Connector configuration is verified from its official
`https://CONNECTOR_ID.quiltt.app` page. Production and Test environments are
rejected. An optional API secret must also belong to that same Sandbox.

## Install and configure

From the repository root on Linux:

```sh
./scripts/setup-linux.sh --quiltt-only
export PATH="$HOME/.local/bin:$PATH"
quiltt configure --connector-id YOUR_SANDBOX_CONNECTOR_ID
quiltt login
```

Use `QUILTT_NODE=/absolute/path/to/node` to reuse Node 24.21 or newer. The
installer otherwise downloads and verifies Node for the host architecture.
On macOS, use `node quiltt/bin/quiltt COMMAND` with a compatible runtime.

The Sandbox Connector should have Authenticate (email or phone OTP), Enroll and
Connect with Account Balances and Transactions enabled. Use a mock/test bank to
exercise the flow without a real account.

## Sign-in handoff

`quiltt login` returns:

- `approvalUrl`: a short-lived private link to send to the user.
- `connectorSetup.redirectUrl`: the callback URL for the Connector's **Exit Redirect**.
- `sendToken: true` and `sendMetadata: true`: settings to enable in the Dashboard.

Set the Exit Redirect URL and enable Send Token/Send Metadata in the Quiltt
Connector, then save. Open `approvalUrl` in the user's browser. The small
bootstrap page binds the browser to the private link and immediately redirects
to the official Quiltt Connector. It contains no login form, custom branding or
remote screen. Quiltt handles OTP and institution consent. After completion,
Quiltt sends its genuine session to the configured callback. The Orin validates
that session with Quiltt's introspection endpoint and independently queries the
same Profile before saving it.

```sh
quiltt auth poll
quiltt auth wait --timeout-seconds 60
quiltt auth status
```

The final browser page is deliberately blank; its title is “Connection complete.”
Use the CLI result to confirm authentication. Initial account/transaction sync
may continue afterward; `connections` shows its status.

For a temporary Sandbox test, the CLI starts a cloudflared Quick Tunnel only
during login. **Its hostname changes on each new tunnel**, requiring an updated
Exit Redirect setting. For a repeatable deployment, use a stable HTTPS reverse
proxy to the Orin's loopback listener:

```sh
quiltt login --public-url https://YOUR_STABLE_HOST --port 61800
```

Configure that stable `/callback` URL once. Browser and CLI access must use the
same hostname. A public URL requires a fixed local port. TLS must terminate at
the reverse proxy; the Node listener binds only to `127.0.0.1`.

`quiltt connect` starts another bank-linking flow for the saved Profile. It
refuses a callback for a different Profile. `login --replace` explicitly permits
switching Profile after a fresh validated handoff. Failed or cancelled flows
preserve the previous saved session. `auth cancel` stops a pending flow, and
`logout` removes local Profile credentials without deleting bank Connections.

## Read data

```sh
quiltt connections --pretty
quiltt accounts --pretty
quiltt balances --pretty
quiltt transactions --limit 50 --pretty
quiltt transactions --cursor RETURNED_CURSOR
quiltt transactions --start-date 2026-10-01 --end-date 2026-10-21 --status POSTED
quiltt transactions --entry-type DEBIT
```

Transaction pages contain at most 100 records and expose an opaque local cursor.
The cursor retains its Profile, environment, filters and page size. Cursors
expire after one hour. Partial GraphQL errors and malformed/nonadvancing pages
are errors, not an empty or complete list. Each transaction includes its account
ID/name so an agent can group transactions across institutions.

Balances include the account currency code and upstream `at` timestamp. Null remains unavailable rather
than becoming zero. Quiltt uses signed balances: liabilities such as credit-card
debt are negative. Transaction amounts use positive for inflows and negative for
outflows. Data reflects the institution/provider's last available sync; these
commands do not trigger paid/on-demand refreshes or move money.

## Persistent access

The browser session is normally valid for 24 hours. A Sandbox test can run
without supplying any API secret, then repeat sign-in when its session expires.
For persistent server access to the same validated Profile, configure the
environment's API secret privately on your trusted personal Orin:

```sh
quiltt configure --connector-id YOUR_SANDBOX_CONNECTOR_ID --prompt
```

The terminal hides the key. `--api-key-file FILE` (owner-only regular file,
`chmod 600`) and `--api-key-stdin` are also supported. There is no literal-key
argument. Never paste the API secret into chat, put it in shell history, or commit
it to Git. The CLI introspects the secret and rejects another environment or
production credentials. It then uses documented Profile-scoped server Basic
authentication for reads; it does not issue a new browser session on each command.

The environment API secret is administrative. For a product with separate users'
devices, keep it on a trusted backend and give each device only its user's
credentials; this personal Sandbox setup is not a multi-tenant key distribution
design.

State is stored under `~/.config/quiltt-cli`, `$XDG_CONFIG_HOME/quiltt-cli` or
`$QUILTT_STATE_DIR`, with directory mode 700 and record mode 600. Sessions, API
secrets and private connection-link capabilities stay outside Git. The CLI does
not store passwords, OTPs, transaction pages or bank credentials.

## Development and verification

```sh
npm --prefix quiltt test
quiltt tools
```

The implementation uses API version `2026-04-01`. Offline tests exercise Sandbox
checks, session/Profile/environment validation, private link/cookie binding,
cursor continuity and strict read errors. On 2026-10-21 the installed CLI on
Linux ARM64 completed official email authentication, received and independently
validated the browser callback, and retrieved two Mock Sandbox Bank accounts,
their balances, connection status, and two distinct pages from 168 transactions.
These are synthetic bank records from a real Quiltt Sandbox integration; no
production institution or money movement was tested. Persistent API-key access
has offline validation tests but was not exercised with a live private API key.
See [API sources and handoff](docs/protocol.md).
