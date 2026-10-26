# Instagram standalone CLI

A headless Node.js HTTP CLI for search, Explore, inbox summaries, followers, following, and saved-post collections. Login returns an approval link that the user opens on Instagram’s own website in their own browser. The host receives and saves the approved session automatically. No Android, display, browser, developer API key, or cookie transfer is required on the host.

## First login

Requires Node 22.19 or newer; the Linux installer supplies Node 24. On the machine running the CLI:

```sh
instagram login
```

The JSON result includes `approvalUrl`, `code`, `loginId`, and a `localDeadline`. Send `approvalUrl` to the user. They can open it on a separate Mac, iPhone, or other computer, sign in on Instagram, and confirm the code. Click **Continue** until Instagram shows **“Success! You can now enjoy Instagram on your TV.”** If signing in redirects to Home, reopen the same link in that browser. The TV wording comes from Instagram’s first-party approval flow; no TV is required.

On the CLI host, wait for approval:

```sh
instagram auth wait
instagram me
```

For agents that prefer short tool calls, use `instagram auth poll`. Pending results include `retryAfterSeconds`; wait that long before polling again. Approved results return `status: "authenticated"`. Credentials stay in private local state and are excluded from output. Calling `login` again reuses an active link; `login --replace` starts a fresh request. `auth cancel` deletes a pending request while preserving the existing session.

The default local approval deadline is ten minutes, configurable with `login --timeout SECONDS` (30–3600). This is a client deadline, not a promise about Instagram’s code lifetime. `auth wait --timeout SECONDS` limits one wait without cancelling a still-valid request. Help and `tools` never start a login or send network requests. See [the verified pairing protocol](docs/auth-handoff.md).

## Headless Linux

The installer supports Linux x86_64 and ARM64 with glibc 2.28 or newer. It reuses a compatible Node runtime or downloads a checksummed Node 24 archive. Git, curl, tar, xz, and sha256sum are required when downloading Node. It leaves system Node unchanged.

```sh
git clone https://github.com/srikanthsrnvs/rea-apps.git
cd rea-apps
./scripts/setup-linux.sh --instagram-only
export PATH="$HOME/.local/bin:$PATH"
```

After installation, use the same link flow directly on Linux:

```sh
instagram login
# User approves approvalUrl on their own device.
instagram auth wait
instagram me
```

The HTTP runtime and pairing login have no npm dependencies. The Linux installer does not install or launch Chrome. An optional desktop helper (`npm ci`, then `instagram login --browser`) and explicit private session import (`auth import --file PATH`) remain available as alternatives.

## Commands

```sh
instagram me --pretty
instagram search users --query 'coffee' --pretty
instagram search content --query 'coffee' --pretty
instagram search content --query 'coffee' --cursor 'RETURNED_CURSOR' --pretty
instagram explore --pretty
instagram explore --cursor 'RETURNED_CURSOR' --pretty
instagram inbox --pretty
instagram inbox --cursor 'RETURNED_CURSOR' --pretty
instagram followers --count 50 --pretty
instagram followers --cursor 'RETURNED_CURSOR' --pretty
instagram following --username 'ACCOUNT_NAME' --count 50 --pretty
instagram following --cursor 'RETURNED_CURSOR' --pretty
instagram bookmarks --pretty
instagram bookmarks collections --pretty
instagram bookmarks collections --cursor 'RETURNED_CURSOR' --pretty
instagram bookmarks items --collection-id 'COLLECTION_ID' --pretty
instagram bookmarks items --cursor 'RETURNED_CURSOR' --pretty
instagram tools
```

Content search and Explore flatten posts and Reels into `items`, including authors, captions, media types, URLs, and carousel items when returned by Instagram. Each page includes `hasMore` and `nextCursor`. Reuse the cursor to continue scrolling, stopping when `hasMore` is false. Pagination cursors belong to the command, account, and original query. Page size follows the website's defaults; cursors contain continuation metadata, not authentication credentials. Repeated pages can overlap as recommendations change, so consumers can deduplicate by item ID.

Account search returns the website's account suggestions, not a complete paginated directory. Inbox returns conversation titles, participants, latest previews, and available unread/mute/pin flags. It does not open individual threads, fetch message history, mark messages read, or send messages. Posting and the home feed are outside this CLI's scope.

`followers` and `following` default to the signed-in account. Use either `--user-id` or `--username` for another accessible account. Username lookup requires an exact account-search match. The result contains `users`, `userId`, `hasMore`, `nextCursor`, and a server `limited` flag when available. Follow `nextCursor` with the same command; it retains the target, so repeating the username or ID is optional. `--count` accepts 1–100 and is a requested page size. Instagram can return fewer users or restrict a list; pagination does not override account permissions. Consumers can deduplicate IDs across pages as lists change.

`bookmarks` returns a structured tree: a root with `children` collections, each containing projected media `items` and its own `hasMore` and `nextCursor`. A post can appear in several collections, so membership is preserved. This command loads at most 12 collections and one media page per collection; `--count` (1–12) bounds both page sizes. Check `complete`, and each child's `loaded` flag. A child read error is recorded on that child and stops further child requests, preserving the partial tree.

Use the root cursor with `bookmarks` or `bookmarks collections` to continue collections. Use a child's cursor with `bookmarks items` to continue its media. `bookmarks collections` reads metadata and covers only; `bookmarks items` defaults to All posts when neither a collection ID nor cursor is supplied. Collection listing accepts `--count` 1–50, and media listing accepts 1–100. Posts, Reels, and carousel children retain their own structure. The supported hierarchy is collections → media → carousel items; deeper folder nesting has not been observed. Audio-only, shopping, and playlist collections are outside these saved-post tools. See [list and bookmark protocol details](docs/lists-and-bookmarks.md).

Commands output JSON. Errors output JSON to stderr and exit with status 1. `instagram tools` provides command schemas for models. `me --raw` exposes the validated account object; request tokens and cookies are excluded. Other commands always return projected lists. Integer IDs retain their original precision.

## Session lifetime

Response cookies are retained as Instagram updates them. There is no OAuth refresh-token grant. An expired, revoked, or challenged session may require another browser approval. `auth status` inspects local timestamps; `me` validates with the server. Rate limits and errors are reported without automatic retries.

State is under `~/.config/instagram-cli` (or `$XDG_CONFIG_HOME/instagram-cli`); `INSTAGRAM_CLI_STATE_DIR` overrides that path. Directories use mode 0700 and credential files use mode 0600. Process locks serialize credential access. A pending or failed approval preserves the existing session. Acquired credentials are saved before account validation so validation can be retried without another exchange. A lost exchange response requires a fresh approval; the CLI does not replay a possibly consumed nonce automatically. `auth logout` removes local credentials and the helper profile; it does not revoke other account sessions remotely.

The web operations are private, versioned Instagram protocols and can change. Errors remain errors; the CLI does not fall back to an Android device or browser at runtime. See [protocol and verification details](docs/web-protocol.md) and the [Android investigation](docs/protocol.md).

## Verification

```sh
npm test
```

The 37 automated tests cover pairing, RSA nonce decryption, polling, recovery, credential scope, cookie rotation, safe errors, large IDs, pagination binding, inbox projection, CLI schemas, and logout, plus relationship targets, collection membership, carousel structure, partial trees, and saved-media transport. They pass on macOS and Linux ARM64. On 2026-10-12 a fresh request generated on the headless Orin was approved in a separate user browser, exchanged on Linux, and validated against account access, search, Explore continuation, and inbox. Packaged CLI checks also cover new code generation, polling and cancellation. See [login verification](docs/auth-handoff.md) and [list verification](docs/lists-and-bookmarks.md).

APKs, decompiled code, response captures, private account data, and credentials are kept outside this public checkout and package.
