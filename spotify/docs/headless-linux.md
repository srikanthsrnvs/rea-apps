# Headless Linux deployment

The Linux host needs no screen, graphical desktop, interactive browser, or remote desktop. The official amd64 Spotify desktop client runs under Xvfb and a private D-Bus session. The CLI uses native Node on the host to control the app through its loopback debugger. Spotify Connect speakers provide audio; local audio hardware is not configured by this project.

## Requirements

- Linux with glibc 2.28 or newer: x86_64, or ARM64 with systemd and root/sudo access for emulator installation. Musl-only hosts such as Alpine are not supported by the native Node installer.
- Docker Engine running locally, accessible to your user, and the Compose v2 plugin. Use a regular rootful Docker daemon; rootless host networking is not supported by this setup. [Docker installation instructions](https://docs.docker.com/engine/install/) cover supported distributions. Configure Docker to start at boot if you want Spotify to start at boot.
- Git, curl, tar, xz, sha256sum; on Debian/Ubuntu: `sudo apt-get install git curl xz-utils ca-certificates`.
- Internet access to GitHub, Docker Hub, nodejs.org and Spotify; TCP port 9222 free on the host.
- Access to another device for first-login approval. This flow does not accept passwords in the terminal.

Docker isolates Spotify's newer library requirements from the host. The image uses Debian 13; the tested Spotify 1.2.95 package needs glibc 2.39 or newer. The setup downloads Node 24.21.0 with its official SHA256 checksum and keeps it under `~/.local/share/spotify-cli/`. System Node is unchanged. Dependencies use `npm ci --omit=dev`.

## Install and use

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps/spotify
./scripts/setup-headless.sh
bin/spotify-headless login
# Open verificationUri on another device; approve userCode.
bin/spotify-headless login-status
bin/spotify-headless devices --pretty
bin/spotify-headless transfer DEVICE_ID
bin/spotify-headless play --query "Veridis Quo"
```

Setup uses the fixed Compose project name `spotify-desktop-cli` and includes `compose.host-network.yaml` for LAN multicast discovery. Run one instance per host. Keep the checkout in place: the wrapper and runtime links use it. The `.runtime/` directory is ignored by Git and contains only local setup files.

The device hostname defaults to `spotify-headless`. To choose one, set `SPOTIFY_DEVICE_NAME=your-device-name` in the checkout's ignored `.env` file before setup. When migrating an existing profile, keep its previous container hostname; the tested Jetson profile did not start successfully with a changed hostname. On ARM, run setup in a terminal for the sudo prompt (use `ssh -t` when invoking it remotely).

To expose the CLI as `spotify`, create a symlink after checking that this name is free:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/spotify-headless" "$HOME/.local/bin/spotify"
export PATH="$HOME/.local/bin:$PATH"
```

Login returns a pending pairing code. No notification is sent automatically. Authentication is confirmed only when `login-status` reports `loggedIn:true`. Repeated `login` calls reuse a pending code. If the phase is `expired` or `error`, run `login` again. A restart during pairing requires a new code.

## Service and saved session

```sh
bin/spotify-headless service stop
bin/spotify-headless service start
bin/spotify-headless service restart
bin/spotify-headless service logs
bin/spotify-headless service wait
```

Start/restart waits up to three minutes for the native login service and, when already signed in, an operational status read. A logged-out app is also ready for pairing. The restart policy is `unless-stopped`: a manually stopped service stays stopped until you start it again. On ARM, emulated Spotify can take a minute or more to load; commands on a warm session use native Node and avoid that emulation overhead.

Spotify stores its own login in `spotify-desktop-cli_spotify-home`, mounted at `/home/spotifycli`. The D-Bus machine ID also lives in this volume so rebuilding an image preserves the device identity needed to restore login. Setup migrates that ID from an older running container before building. Start an older stopped container before updating it for the first time. Container recreation and normal updates keep this volume. Treat it as private account data. Do not use `docker compose down -v` unless you want to delete the session. The CLI does not export access tokens or copy another machine's credentials.

To update, pull changes and rerun setup; the saved session is retained:

```sh
git pull --ff-only
./scripts/setup-headless.sh
```

`--no-build` starts an already built or transferred `spotify-desktop-cli:headless` image. The normal setup builds from source. Docker builds install the current official Spotify package; private runtime compatibility can change after a Spotify update.

## ARM64 emulation

Spotify's tested official Linux package is amd64. Setup copies QEMU 10.2.3 from the digest-pinned ARM64 [tonistiigi/binfmt release](https://github.com/tonistiigi/binfmt/releases/tag/deploy%2Fv10.2.3-68) into `/usr/local/libexec/spotify-cli/qemu-x86_64`. It installs `spotify-cli-binfmt.service`, which registers a dedicated `spotify-cli-amd64` kernel handler with `P` and `F` flags after other binfmt services and before Docker starts. This registration also handles other amd64 ELF programs on the host; existing handlers are not removed. The extraction container does not run and is removed after copying its binary.

The container entrypoint supplies an explicit CEF subprocess path and disables zygote and GPU processes. Ubuntu 22.04's QEMU 6.2 crashed during our Jetson test. Setting `platform: linux/amd64` alone does not provide a suitable emulator. Setup fails on unsupported architectures or on ARM without systemd, rather than claiming a working deployment.

```sh
systemctl status spotify-cli-binfmt.service
cat /proc/sys/fs/binfmt_misc/spotify-cli-amd64
```

The registration must show `enabled` and `flags: PF`. If an unrelated emulator installer later overrides amd64 handling, use `sudo systemctl restart spotify-cli-binfmt.service`. To uninstall this emulator, stop Spotify, disable/remove this service, unregister only `/proc/sys/fs/binfmt_misc/spotify-cli-amd64`, and remove `/usr/local/libexec/spotify-cli/`. Keep the native profile volume if you want to retain login.

## MCP

Point any stdio MCP client at the absolute wrapper path:

```json
{
  "mcpServers": {
    "spotify-desktop": {
      "command": "/absolute/path/to/rea-apps/spotify/bin/spotify-headless",
      "args": ["mcp"]
    }
  }
}
```

The server lists 48 tools, including pairing, login state, search, playback and devices. It does not automatically launch a stopped container; start the service first. CLI and MCP use the same native host runtime and app connection.

## Troubleshooting and scope

`service logs` shows app startup failures. `service wait` retries harmless session/status reads; it never starts pairing or changes playback. `NOT_CONNECTED`, `NOT_READY` or `TIMEOUT` immediately after restart can mean the emulated app is still loading. If a mutation times out, read state before retrying it.

`devices` includes `available`; devices with `available:false` are not ready for playback. Host networking permits multicast discovery but does not override Wi-Fi client isolation, VLAN boundaries or speaker power state. The debugger is bound to `127.0.0.1:9222`; it is not exposed to the LAN.

Live Jetson Orin checks on Ubuntu 22.04 covered pairing, search, library reads, discovery, session restoration after container recreation, and MCP listing all 48 tools and reading login/devices. Native CLI reads on a warm session took about 0.2 seconds. Linux playback transfers and local hardware audio have not been exercised. This is a desktop client inside a headless container, so ARM emulation is heavier than a native Connect implementation. Other Linux distributions and host reboot behavior still need their own validation.

For an existing native amd64 Spotify installation, `bin/spotify connect` can launch it under Xvfb when `DISPLAY` is absent. Install Node >=22.19, Spotify, Xvfb, xauth and dbus-run-session, then run `npm ci`. `SPOTIFY_BINARY` selects a nonstandard executable. Stop an existing Spotify service before enabling debugging. The container setup is the maintained deployment path.
