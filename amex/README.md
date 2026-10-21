# Amex CLI

Native HTTP tools reconstructed from the installed US Amex Android app 7.34.1.
The runtime is Node only: no browser, Android device, emulator, display, developer
API key or npm dependencies on the Linux host.

**Experimental:** anonymous initialization has succeeded on Linux ARM64. Login,
MFA, card/transaction reads and final payment operations have not yet been
validated against a live account. Synthetic tests establish local behavior and
request construction, not server acceptance. No real payment or cancellation
has been made during development.

## Install

From the repository root on Linux ARM64 or x86_64:

```sh
./scripts/setup-linux.sh --amex-only
export PATH="$HOME/.local/bin:$PATH"
amex tools --pretty
amex connection
```

The installer reuses a compatible Node installation, or downloads and verifies
Node 24.21.0. Use `AMEX_NODE=/absolute/path/to/node` to select an existing runtime.
On macOS, use `node amex/bin/amex COMMAND` with Node 24.21 or newer. Source/evidence
analysis tools are not required at runtime.

## Login

The native app uses an Amex **user ID and password**, then server-offered
verification. An official fresh browser approval-link flow has not been
established. Signing in on the phone does not sign in the CLI.

Use a real interactive terminal for hidden password entry:

```sh
amex login --prompt
```

For an agent, pipe JSON `{ "userId": "…", "password": "…" }` to
`amex login --credentials-stdin`, or use `--credentials-file /private/path.json`.
Files must be owner-only regular files (`chmod 600`); symlinks are rejected.
Alternatively supply `--user-id USER --password-stdin` or `--password-file FILE`.
Only one input mode is allowed. There is no password argument. Do not paste a
password into an agent conversation, command line or shell history.

If Amex offers verification options, use only a returned option:

```sh
amex auth send-code --login-id LOGIN_ID --option-id option-1
amex auth verify --login-id LOGIN_ID --code-file /private/otp.txt
amex auth status
```

`--code-stdin` and `--code CODE` are also supported; a private file or stdin avoids
putting the code in shell history or process arguments. The CLI does not persist
the password or verification code. It stores genuine partial session tokens
privately while verification is pending, and saves a full session only after an
independent account-summary read succeeds. Unsupported checks remain
`action_required`; the CLI does not fabricate device proofs or enroll a trusted
device. `auth validate --login-id ID` retries only that account read.

Pending login expires after five minutes. Failed replacement login preserves the
previous saved session. Interrupted credential/code requests remain uncertain
and are not replayed. `auth cancel --login-id ID` discards pending login;
`logout` removes local session/cache state while retaining financial journals.
The CLI does not silently extend a banking session in the background.

## Account reads

```sh
amex accounts --pretty
amex transactions list --card card-LOCAL_ALIAS --pretty
amex transactions list --cursor amex-transactions:RETURNED_CURSOR
amex transactions list --card card-LOCAL_ALIAS --description coffee \
  --start-date 2026-10-01 --end-date 2026-10-21
amex transactions get --card card-LOCAL_ALIAS --identifier RETURNED_ID --status POSTED
amex statements list --card card-LOCAL_ALIAS
amex payments history --card card-LOCAL_ALIAS
amex payments activity --card card-LOCAL_ALIAS
```

Card aliases come from `accounts`; native account tokens stay private. Card
selection is required when no unambiguous default exists. A transaction cursor
retains its account, card, dates and filters and expires after one hour. Cursors
are local to this installation. Returned transaction identifiers are used for
details; use the transaction's actual `FRAUD`, `PENDING` or `POSTED` status.
Search sorts are `NEWEST`, `OLDEST`, `AMOUNT_ASCENDING`, `AMOUNT_DESCENDING`;
types are `CREDIT`, `DEBIT`, `CREDIT_DEBIT`.

## Payment reviews

The implemented contract covers an offered, active **existing funding method**
and the native non-PCI-DSS `PAYMENT` branch. New bank accounts, card enrollment,
autopay, Pay-and-Plan, rewards conversion, PCI-DSS/3DS and unrecognized step-up
branches require separate implementation. Their absence is reported explicitly.

```sh
amex payment options --card card-LOCAL_ALIAS --pretty
amex payment preview --inquiry-id INQUIRY_ID --method method-1 \
  --amount-option amount-1 --date YYYY-MM-DD --pretty
```

For an editable amount option, add `--amount 25.00`. Amounts are decimal strings;
the CLI checks server-offered limits, currency, dates and eligibility. Display
the complete review to the user, including card, funding method, exact amount,
currency, payment date and terms, before any financial confirmation.

Only after the user approves that exact payment:

```sh
amex payment confirm --review-id REVIEW_ID --amount 25.00 --currency USD \
  --date YYYY-MM-DD --accept-terms RETURNED_TERMS_HASH --confirm
amex payment status --review-id REVIEW_ID
```

Inquiries and unsubmitted reviews expire after five minutes. Requests preserve
the server-issued payment request ID. An intent journal is saved before the
single final request. A timeout is an **unknown** outcome, never permission to
retry. Duplicate guards survive new reviews and local logout. Reconcile uncertain
outcomes with Amex payment activity; do not delete journals to force a retry.
`submitted` means the endpoint accepted its native confirmation response;
`settled:false` means bank settlement has not been established.

Scheduled-payment cancellation likewise requires a source-offered delete action:

```sh
amex payment cancel preview --inquiry-id INQUIRY_ID --payment payment-1 --pretty
# After approval of the exact target and cancellation terms:
amex payment cancel confirm --review-id REVIEW_ID --accept-terms RETURNED_TERMS_HASH --confirm
amex payment cancel status --review-id REVIEW_ID
```

## State and development

State is under `~/.config/amex-cli`, `$XDG_CONFIG_HOME/amex-cli`, or
`$AMEX_STATE_DIR`. Directories use mode 700; records use mode 600. Session tokens,
raw account responses and review bodies are private credentials/account data.
Public JSON output uses aliases and removes session/account tokens. No account
data, passwords, OTPs, APKs or captured traffic belongs in Git.

`amex tools` returns schemas for agent integration. The CLI emits JSON and exits
nonzero on argument/transport exceptions. Inspect `phase` for native failure,
unknown and verification requirements even when the process exits zero.

```sh
npm --prefix amex test
```

See [protocol and verification limits](docs/protocol.md) and the
[account/payment contracts](docs/account-payment-protocol.md).
