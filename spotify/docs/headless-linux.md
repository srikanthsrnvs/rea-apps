# Headless Linux

The default Spotify CLI is a native Node controller. It does not run Spotify desktop, Chromium, a browser, Xvfb, Docker or QEMU. It talks directly to Spotify’s native Connect and catalog services. Audio is played by an available Spotify Connect receiver, such as the LSX speaker, rather than on the Linux host.

## Install

On Linux ARM64 or x86-64:

```sh
cd /path/to/rea-apps/spotify
./scripts/setup-headless.sh
export PATH="$HOME/.local/bin:$PATH"
spotify login
# Open its returned Spotify URL on another device and approve the code.
spotify login-status
spotify devices --pretty
spotify transfer "EXACT DEVICE NAME"
spotify play --query "SONG NAME"
```

Setup reuses compatible native Node or installs a checksummed official release, then installs the MCP dependencies. It requires no sudo, desktop session, browser, emulator, API key or Spotify developer account. Node must be 22.19 or newer; downloaded Node needs glibc 2.28 or newer. The existing setup filename and `--no-build` flag remain compatible.

Pairing requires one human approval in their own browser. Tokens remain owner-only under `~/.config/spotify-cli`, or `SPOTIFY_STATE_DIR`. Spotify’s refresh token renews access; no resident application is needed. `spotify logout` removes local authorization.

## Existing desktop deployments

The native session is separate from the old desktop profile. Complete native pairing first. After verifying native commands, stop the old container to reclaim its RAM. The old `bin/spotify-headless service stop` manages only that legacy service. New setup does not create or restart a desktop container. Preserve the old profile volume if you want a recoverable historical installation.

The Orin migration completed native pairing/renewal and verified normal status, devices, search and liked reads with the desktop container stopped. Peak measured command RSS was about 97–99 MiB, versus the prior container’s 1.218 GiB sample. No claim is made about every possible workload or the memory of unrelated applications.

Run `spotify mcp` for a persistent MCP server with the prebuilt player component. The host/client renders that component; no browser runs on the Linux machine. The server and command-line route through the same native protocol implementation. See the [main guide](../README.md), [player contract](player-component.md) and [protocol evidence](native-protocol.md).
