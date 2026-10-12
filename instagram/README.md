# Instagram standalone CLI

A headless Node.js HTTP CLI for account search, content search, the Explore grid, and inbox summaries. Android supplied protocol evidence during development; the runtime needs neither Android nor a browser. First login uses a normal Chrome approval on another computer, followed by a private session transfer to Linux.

## First login on a computer

Requires Node 22.19 or newer and Chrome. From `rea-apps/instagram`:

```sh
npm ci
npm install --global .
instagram login --browser
```

Finish Instagram login and any security checks in the dedicated Chrome window. The helper validates the account, saves its session privately, and closes the window. `instagram login` prints instructions. Initial login is not entirely terminal-only; there is no pairing code or developer API key.

An agent on a separate headless host cannot authenticate itself merely by sending
you the normal Instagram login URL. Signing in there saves the session in your
browser, so the current helper and private session transfer are still required.
An automatic link-to-session handoff has not been verified; see the
[pairing investigation and current limits](docs/auth-handoff.md).

## Headless Linux

The installer supports Linux x86_64 and ARM64 with glibc 2.28 or newer. It reuses a compatible Node runtime or downloads a checksummed Node 24 archive. Git, curl, tar, xz, and sha256sum are required when downloading Node. It leaves system Node unchanged.

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh --instagram-only
export PATH="$HOME/.local/bin:$PATH"
```

After approval on your computer, transfer `~/.config/instagram-cli/session.json` over SSH to a private file on Linux. Treat this file as an account credential. Validate and import it, then delete the transferred copy:

```sh
instagram auth import --file /private/path/session.json
rm /private/path/session.json
instagram me
```

The HTTP runtime has no npm dependencies. `playwright-core` is optional and used only by the initial desktop approval helper. The Linux installer does not install or launch Chrome.

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
instagram tools
```

Content search and Explore flatten posts and Reels into `items`, including authors, captions, media types, URLs, and carousel items when returned by Instagram. Each page includes `hasMore` and `nextCursor`. Reuse the cursor to continue scrolling, stopping when `hasMore` is false. Pagination cursors belong to the command, account, and original query. Page size follows the website's defaults; cursors contain continuation metadata, not authentication credentials. Repeated pages can overlap as recommendations change, so consumers can deduplicate by item ID.

Account search returns the website's account suggestions, not a complete paginated directory. Inbox returns conversation titles, participants, latest previews, and available unread/mute/pin flags. It does not open individual threads, fetch message history, mark messages read, or send messages. Posting and the home feed are outside this CLI's scope.

Commands output JSON. Errors output JSON to stderr and exit with status 1. `instagram tools` provides command schemas for models. `me --raw` exposes the validated account object; request tokens and cookies are excluded. Other commands always return projected lists. Integer IDs retain their original precision.

## Session lifetime

Response cookies are retained as Instagram updates them. There is no OAuth refresh-token grant. An expired, revoked, or challenged session may require another browser approval. `auth status` inspects local timestamps; `me` validates with the server. Rate limits and errors are reported without automatic retries.

State is under `~/.config/instagram-cli` (or `$XDG_CONFIG_HOME/instagram-cli`); `INSTAGRAM_CLI_STATE_DIR` overrides that path. Directories use mode 0700 and session files use mode 0600. Process locks serialize credential access. `auth logout` removes local credentials and the helper profile; it does not revoke other account sessions remotely.

The web operations are private, versioned Instagram protocols and can change. Errors remain errors; the CLI does not fall back to an Android device or browser at runtime. See [protocol and verification details](docs/web-protocol.md) and the [Android investigation](docs/protocol.md).

## Verification

```sh
npm test
```

The 18 automated tests cover credential scope and expiry, import validation, cookie rotation, safe errors and redirects, account validation, large IDs, mixed-grid flattening, pagination binding, inbox projection, read-only GraphQL operations, CLI schemas, and local logout. Live checks on macOS and the headless Linux ARM64 host on 2026-10-12 confirmed first and continuation pages for Explore, content search, and inbox, plus account search, using ordinary Node HTTP requests with Chrome closed.

APKs, decompiled code, response captures, private account data, and credentials are kept outside this public checkout and package.
