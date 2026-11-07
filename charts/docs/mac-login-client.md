# Automatic login from a Mac to a headless host

The provider remains `@mathieuc/tradingview`, with the same native TradingView
session and account features. Free accounts are supported. There is no dependency
on the separate paid official MCP service.

## One-time setup on the Mac

1. Install Node 24.21+ and Apple's command-line developer tools if absent.
2. Make sure `ssh USER@HOST` works noninteractively with an SSH key or an existing
   trusted SSH configuration. The receiver uses BatchMode and never collects or
   stores an SSH password.
3. Install the host CLI with `./scripts/setup-linux.sh --charts-only`.
4. From this repository on the Mac, run:

   ```sh
   CHARTS_NODE=/absolute/path/to/node sh charts/scripts/setup-macos-client.sh \
     --ssh-target USER@HOST \
     --remote-cli /home/USER/.local/bin/charts \
     --profile orin
   ```

The receiver is built locally at `~/Applications/Charts Login.app`. Its packaged
JavaScript is copied from the checkout, so it does not depend on keeping the
worktree. It does depend on the configured Node executable remaining installed.
The Orin needs only its existing Node CLI. It never runs this app or a browser.

The profile is a local name, not a network destination. A login link cannot add an
SSH host, alter the executable or send a callback anywhere else. Changing the
trusted destination while an active login is pending is refused.

For a dedicated key, add `--identity-file /absolute/path/to/key` to the installer.
The client verifies that this is an owner-only regular file and uses SSH with
`IdentitiesOnly=yes`. On the host, `scripts/charts-auth-ssh.mjs` can be installed
as that key's forced command with `restrict` in authorized_keys. It permits only
the exact polling and stdin callback commands; shell access, account operations,
PTYs and forwarding are not needed by the receiver.

## Normal login

The agent runs `charts login --client-profile orin` on the host and sends the
returned `clientUrl`. The user's chat/browser client must permit opening the
`rea-charts://` scheme in the installed Mac app. If it does not, the user can open
that same link using macOS's `open` command. It contains only the profile and
login ID, not an account credential.

The app then:

1. Queries that exact login ID over the configured SSH connection.
2. Checks the profile, deadline and official TradingView approval URL.
3. Arms the native callback receiver and opens the official page in the user's
   own default browser.
4. Receives `tradingview://browser-auth/?token=...` and forwards it to
   `auth complete --callback-stdin` on the host. It does not store the token.
5. Displays success only after the host reports independent account validation.

The host's `charts auth poll --login-id ID` confirms the same login's result.
The app restores an existing TradingView URL handler when one was present and
has not been changed by another app during login. If there was no prior handler,
the installed receiver may remain registered; it refuses callbacks unless a
matching, unexpired login is actively armed.

## Expiry and recovery

- The handoff expires after ten minutes. The Mac app stops waiting and restores
  the previous URL handler at the deadline. The host refuses late callbacks.
- A callback can be submitted once. Duplicate callbacks, mismatched profiles,
  changed configuration and unarmed callbacks are refused before SSH submission.
- After a lost SSH response, run `charts-client status --online` on the Mac or
  `charts auth poll --login-id ID` on the host. A successful committed login is
  recognized without resending the callback.
- If the host reports `validating`, run `charts auth complete --login-id ID`
  without a callback. It revalidates the saved candidate only.
- If it reports `exchange_uncertain`, cancel the host attempt and create a fresh
  login. Do not paste or replay the old callback.
- `charts-client cancel` clears the local armed login, restores the previous
  handler where available and stops the receiver. `charts auth cancel` separately
  cancels the host attempt. Neither removes an already saved account.
- `charts auth status` reports locally saved metadata; `charts auth validate`
  performs an independent online account read. `charts login` also validates a
  saved account before reporting success. Expired/rejected sessions start a new
  grant without first deleting the previous account.

Use `node charts/bin/charts-client ...` if the optional client executable has
not been added to PATH. The receiver's settings use `~/.config/charts-client`
(or `$XDG_CONFIG_HOME/charts-client`), with private directory/file permissions.

## Current verification limits

The Node client handoff, duplicate prevention, bounded stdin, host binding,
expiry, error recovery and existing account behavior are covered by local
tests. The Swift receiver compiles and its URL registration was exercised on
macOS. The new automatic path still needs a real user-approved account test over
SSH; the earlier manual native exchange was verified on the Orin.

TradingView's additional native-app 2FA flow remains unsupported. The current
desktop 3.5.0 source still opens a session-bound verification view after a
`2FA_required` response. Opening that page in a separate ordinary browser does
not transfer the host's challenge session, so the CLI does not pretend it does.
Ordinary verification completed during the initial TradingView browser sign-in
is separate from that extra challenge.

The receiver is currently macOS-only. This is not an iOS, Windows or generic
browser-only solution. No account feature was removed or replaced with the paid
official MCP service.
