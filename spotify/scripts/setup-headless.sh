#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in
  '') build=yes ;;
  --no-build) build=no ;;
  *) fail 'Usage: ./scripts/setup-headless.sh [--no-build]' ;;
esac
[ "$(uname -s)" = Linux ] || fail 'This setup is for Linux. On macOS use bin/spotify connect.'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail 'Supported Linux architectures: x86_64 and ARM64.' ;;
esac
for dependency in docker curl tar xz sha256sum; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Install $dependency first."
done
docker info >/dev/null 2>&1 || fail 'Docker must be running and accessible to this user.'
docker compose version >/dev/null 2>&1 || fail 'Install the Docker Compose v2 plugin first.'
export BUILDKIT_PROGRESS="${BUILDKIT_PROGRESS:-plain}"
export COMPOSE_PROGRESS="${COMPOSE_PROGRESS:-plain}"
mkdir -p "$workspace/.runtime"
temporary=$(mktemp -d "$workspace/.runtime/setup.XXXXXX")
container=
cleanup() {
  if [ -n "$container" ]; then docker rm "$container" >/dev/null 2>&1 || :; fi
  rm -rf "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ "$node_arch" = arm64 ]; then
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || \
    fail 'ARM64 setup requires systemd to restore emulation at boot.'
  as_root() {
    if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
  }
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail 'Install sudo for ARM64 emulator setup.'
    printf '%s\n' 'ARM64: installing the tested amd64 emulator and its boot service (requires sudo).'
    sudo -v
  fi
  # Pinned official ARM64 image containing QEMU 10.2.3. No privileged container.
  emulator_image=tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0
  docker pull --platform linux/arm64 "$emulator_image"
  container=$(docker create --platform linux/arm64 "$emulator_image")
  docker cp "$container:/usr/bin/qemu-x86_64" "$temporary/qemu-x86_64"
  docker rm "$container" >/dev/null
  container=
  as_root install -d /usr/local/libexec/spotify-cli
  as_root install -m 755 "$temporary/qemu-x86_64" /usr/local/libexec/spotify-cli/qemu-x86_64.new
  as_root mv -f /usr/local/libexec/spotify-cli/qemu-x86_64.new /usr/local/libexec/spotify-cli/qemu-x86_64
  as_root install -m 755 "$workspace/docker/register-binfmt.sh" /usr/local/libexec/spotify-cli/register-binfmt
  as_root install -m 644 "$workspace/docker/spotify-cli-binfmt.service" /etc/systemd/system/spotify-cli-binfmt.service
  as_root systemctl daemon-reload
  as_root systemctl enable spotify-cli-binfmt.service
  as_root systemctl restart spotify-cli-binfmt.service
fi

# Use the same native Node release on x64 and ARM64; never change system Node.
node_version=v24.21.0
node_home="$HOME/.local/share/spotify-cli/node-$node_version-linux-$node_arch"
if [ ! -x "$node_home/bin/node" ]; then
  printf '%s\n' "Installing native Node $node_version ($node_arch)…"
  archive="node-$node_version-linux-$node_arch.tar.xz"
  base="https://nodejs.org/dist/$node_version"
  curl -fsSL "$base/$archive" -o "$temporary/$archive"
  curl -fsSL "$base/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
  (cd "$temporary" && awk -v archive="$archive" '$2 == archive { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > checksum && sha256sum -c checksum)
  mkdir -p "$(dirname -- "$node_home")"
  tar -xJf "$temporary/$archive" -C "$(dirname -- "$node_home")"
fi
"$node_home/bin/node" --version >/dev/null 2>&1 || fail 'The native Node runtime cannot run on this host (requires glibc 2.28+).'
ln -sfn "$node_home" "$workspace/.runtime/node"
export PATH="$node_home/bin:$PATH"
export SPOTIFY_NODE="$node_home/bin/node"
cd "$workspace"
npm ci --omit=dev
docker compose --project-name spotify-desktop-cli -f compose.yaml -f compose.host-network.yaml config --quiet
existing_service=$(docker compose --project-name spotify-desktop-cli -f compose.yaml -f compose.host-network.yaml ps -q spotify)
if node --input-type=module -e '
  import { createConnection } from "node:net";
  const socket = createConnection({ host: "127.0.0.1", port: 9222 });
  socket.once("connect", () => { socket.destroy(); process.exit(0); });
  socket.once("error", () => process.exit(1));
  socket.setTimeout(1000, () => { socket.destroy(); process.exit(1); });
'; then
  [ -n "$existing_service" ] || fail 'Port 9222 is already in use by another app. Stop it before setup.'
fi
if [ -n "$existing_service" ]; then
  # Older images baked this ID into their layer. Preserve it before an update;
  # native saved login is tied to the device identity as well as its profile.
  docker exec "$existing_service" /bin/sh -c '
    mkdir -p "$HOME/.local/state/spotify-cli"
    identity="$HOME/.local/state/spotify-cli/machine-id"
    if [ ! -s "$identity" ]; then dbus-uuidgen --get > "$identity"; fi
  '
fi
if [ "$build" = yes ]; then
  docker compose --project-name spotify-desktop-cli -f compose.yaml -f compose.host-network.yaml build spotify
fi
docker compose --project-name spotify-desktop-cli -f compose.yaml -f compose.host-network.yaml up -d --no-build
"$workspace/bin/spotify-headless" service wait
printf '\n%s\n' 'Ready. First login: bin/spotify-headless login' \
  'Approve the returned URL/code on another device, then run bin/spotify-headless login-status.' \
  'Find speakers: bin/spotify-headless devices --pretty' \
  'MCP: bin/spotify-headless mcp'
