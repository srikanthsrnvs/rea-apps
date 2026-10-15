# LinkedIn CLI

Native-HTTP CLI for people search, profiles, and messaging, reconstructed with REA from LinkedIn Android 4.1.1261. Node 22.19+; Linux x64/ARM64 and macOS. No Android, browser, npm packages, or developer API key is needed by API commands.

**Verified:** Google account session import, people search and pagination, profile lookup by identifier and URN, contact-info reads, inbox pagination, conversation lookup, message reads/pagination, and unread filtering. These worked through HTTP with the Android emulator stopped. A connection invitation with its exact note was also accepted through the CLI on the headless Orin. Standard message sending is implemented and locally tested; no live standard message has been accepted.

**Current limit:** a live standard-message attempt to a second-degree profile was explicitly rejected with `RECIPIENT_NOT_FIRST_DEGREE_CONNECTION` (HTTP 422). The CLI reports this permission restriction without retrying. Exported test sessions have also encountered subsequent authentication failures. No message acceptance was confirmed. Session longevity and successful live sending are not yet verified; a successful import does not establish reliable unattended operation.

## Install

```sh
./linkedin/scripts/setup-linux.sh
linkedin tools
```

On macOS, use `node linkedin/bin/linkedin` or install the package locally with `npm install --global ./linkedin`.

## Authentication

The CLI launches no browser. Google-only accounts currently need a one-time session bootstrap from the **original signed LinkedIn Android app in a test environment that permits reading its private state**. The stock Pixel's app sandbox prevents this export. The verified bootstrap used an isolated Android emulator: sign in with Google inside the original app, then:

```sh
linkedin auth import-android --serial emulator-5580 --adb /path/to/adb
linkedin me
linkedin auth export --output NEW_PRIVATE_SESSION_FILE
```

Transfer that file privately to the headless host, then run `linkedin auth import PRIVATE_SESSION_FILE` and remove the transfer file. Only LinkedIn cookies are imported; Google account credentials are not copied. Subsequent commands use HTTP and require no running Android device/emulator. If the saved session expires or is revoked, repeat the bootstrap. **A fresh Google-only login entirely on a new headless host has not been established.**

A native password exchange is also implemented for accounts that already have a LinkedIn password. Supply the password on stdin from a private file or secret manager, never as an argument:

```sh
linkedin login --username EMAIL < PRIVATE_PASSWORD_FILE
linkedin auth status
linkedin me
```

Verification challenges are reported explicitly. A challenge URL is diagnostic information; it is not a working cross-device approval/polling flow. A successful native response is saved as an authenticated session only after the current-profile API validates it.

`linkedin auth google --input PRIVATE_TOKEN_FILE` additionally accepts a JSON `{ "googleIdToken": "..." }` from the native Google sign-in protocol. A separate helper failed with `UnregisteredOnApiConsole` on the legacy API and `Account reauth failed` on Credential Manager. LinkedIn's exported SSO service checks the caller's signing certificate. The successful route used the original app's Google sign-in and its native session store. No LinkedIn password was added or changed.

`linkedin auth import PRIVATE_SESSION_FILE` validates a separately obtained LinkedIn cookie export or this CLI's own session format. `linkedin auth export --output NEW_PRIVATE_FILE` writes a mode-0600 file for private transfer to another host. Credentials are never printed. See [authentication evidence](docs/authentication.md).

## Read tools

```sh
linkedin search --query 'robotics engineer' --count 10
linkedin profile https://www.linkedin.com/in/PUBLIC_IDENTIFIER/
linkedin profile urn:li:fsd_profile:RETURNED_ID --contact-info
linkedin inbox --count 20
linkedin messages --conversation 'RETURNED_CONVERSATION_URN'
linkedin call inbox.search --json '{"keywords":"interview","read":false}'
```

`linkedin tools` returns JSON tool schemas. `linkedin call TOOL --json JSON` and `linkedin call TOOL --input FILE` dispatch the same operations as shorthand commands. `--input -` reads JSON from stdin. All commands return `{ok,data}` or `{ok:false,error}` and set a nonzero exit status on failure.

People search returns `nextCursor`; supply it with the same keywords and filters. Inbox and message responses preserve server `nextCursor`/`prevCursor`, participants, attributes, and attachment metadata. Reads do not mark conversations read. Separate tools retrieve conversations, locate conversations by recipients, mark read/unread, change categories, and mute notifications. Only the requested search results/conversation entities are expanded.

## Send and reply

Resolve a profile to its returned `fsd_profile` URN first. Prepare a new message or a reply:

```sh
linkedin message prepare --to 'RETURNED_PROFILE_URN' --text 'Exact message text'
linkedin message prepare --conversation 'RETURNED_CONVERSATION_URN' --text 'Exact reply'
linkedin message send --operation RETURNED_UUID --confirm
linkedin message status --operation RETURNED_UUID
```

Preparation saves the exact recipients/text locally and sends nothing. Sending records the attempt before making one API request. An uncertain network result is saved as `unknown` and never retried automatically. Use `message.reconcile` with the original operation ID to check its deduplication token before creating any replacement.

Plain-text sending is implemented. Attachment uploads, rich mentions, recalls, reactions, InMail purchases, and group participant editing are not implemented. No home feed, wall, or posting tools are included.

A connection invitation is a separate action requiring its own authorization; a rejected message never silently becomes an invitation:

```sh
linkedin call connection.prepare --json '{"profile":"PUBLIC_IDENTIFIER","note":"Exact invitation note"}'
linkedin connection send --operation RETURNED_UUID --confirm
linkedin connection status --operation RETURNED_UUID
```

Invitation notes are limited to 200 characters by this CLI. Preparation saves the exact recipient and note. The attempt is journaled before the native HTTP request and is never retried automatically. A returned invitation URN confirms acceptance; it does not mean that the recipient accepted the connection. See [invitation protocol](docs/connections-protocol.md).

Session and operation state lives in `${XDG_CONFIG_HOME:-~/.config}/linkedin-cli`, protected by private directory/file permissions and a process lock. Override with `LINKEDIN_CLI_STATE_DIR`. `logout` removes local session and pending-login credentials; saved message operation records remain available for reconciliation.

## Validation and provenance

```sh
cd linkedin
node --test test/*.test.mjs
```

Tests cover native request shapes, normalized entity joins, pagination, cookie scope/rotation, authentication failure handling, and durable send reconciliation. Fixtures are constructed from shipped model contracts, not represented as live captures. Source evidence and remaining limits are recorded in [people protocol](docs/people-protocol.md), [inbox protocol](docs/inbox-protocol.md), and [authentication](docs/authentication.md). APKs, private account data, and full REA evidence stay outside Git.
