#!/bin/sh
# Compatibility entry point: setup now uses native Node, no desktop container.
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in
  '') [ "$#" = 0 ] || fail 'Usage: setup-headless.sh [--no-build]' ;;
  --no-build) [ "$#" = 1 ] || fail 'Usage: setup-headless.sh [--no-build]' ;;
  *) fail 'Usage: setup-headless.sh [--no-build]' ;;
esac
[ "$(uname -s)" = Linux ] || fail 'On macOS use npm ci and bin/spotify login.'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail 'Supported architectures: Linux ARM64 and x86_64.' ;;
esac
compatible() {
  "$1" -e 'const [m,n]=process.versions.node.split(".").map(Number);if(m<22||(m===22&&n<19)||process.arch!==process.argv[1])process.exit(1)' "$node_arch" >/dev/null 2>&1
}
temporary=
cleanup() { [ -z "$temporary" ] || rm -rf "$temporary"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$workspace/.runtime"
node_version=v24.21.0
node_home="$HOME/.local/share/spotify-cli/node-$node_version-linux-$node_arch"
if [ -n "${SPOTIFY_NODE:-}" ]; then
  [ -x "$SPOTIFY_NODE" ] && compatible "$SPOTIFY_NODE" || fail 'SPOTIFY_NODE must select native Node 22.19 or newer.'
  node_binary=$SPOTIFY_NODE
elif [ -x "$node_home/bin/node" ] && compatible "$node_home/bin/node"; then
  node_binary="$node_home/bin/node"
elif command -v node >/dev/null 2>&1 && compatible "$(command -v node)"; then
  node_binary=$(command -v node)
else
  for dependency in curl tar xz sha256sum; do command -v "$dependency" >/dev/null 2>&1 || fail "Install $dependency first."; done
  temporary=$(mktemp -d "$workspace/.runtime/setup.XXXXXX")
  archive="node-$node_version-linux-$node_arch.tar.xz"
  base="https://nodejs.org/dist/$node_version"
  curl -fsSL "$base/$archive" -o "$temporary/$archive"
  curl -fsSL "$base/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
  (cd "$temporary" && awk -v archive="$archive" '$2==archive{print;found=1} END{if(!found)exit 1}' SHASUMS256.txt > checksum && sha256sum -c checksum)
  mkdir -p "$(dirname -- "$node_home")"
  tar -xJf "$temporary/$archive" -C "$(dirname -- "$node_home")"
  node_binary="$node_home/bin/node"
  compatible "$node_binary" || fail 'Node cannot run on this host; glibc 2.28 or newer is required.'
fi
node_binary=$("$node_binary" -p 'require("node:fs").realpathSync(process.execPath)')
runtime_home=$(dirname -- "$(dirname -- "$node_binary")")
ln -sfn "$runtime_home" "$workspace/.runtime/node"
export PATH="$(dirname -- "$node_binary"):$PATH"
command -v npm >/dev/null 2>&1 || fail 'Install npm for the selected Node runtime.'
(cd "$workspace" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
mkdir -p "$HOME/.local/bin"
destination="$HOME/.local/bin/spotify"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "An existing file occupies $destination. Use $workspace/bin/spotify directly."
  case "$(readlink "$destination")" in
    */spotify/bin/spotify|*/spotify/bin/spotify-headless|*/spotify-desktop-cli/bin/spotify|*/spotify-desktop-cli/bin/spotify-headless) ;;
    *) fail "An unrelated symlink occupies $destination. Use $workspace/bin/spotify directly." ;;
  esac
fi
ln -sfn "$workspace/bin/spotify" "$destination"
printf '%s\n' 'Ready: native Node Spotify CLI. No Docker, browser, display, emulator or desktop app is started.' \
  'First login: spotify login; approve the Spotify URL/code on another device; then spotify login-status.' \
  'Find speakers: spotify devices --pretty' 'MCP with prebuilt player: spotify mcp'
