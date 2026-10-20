#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$*" >&2; exit 1; }
temporary=
cleanup() {
  [ -z "$temporary" ] || rm -rf "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
[ "$#" = 0 ] || fail 'Usage: ./scripts/setup-linux.sh (optional CHATGPT_NODE=/absolute/path/to/node)'
[ "$(uname -s)" = Linux ] || fail 'This installer is for Linux. On macOS run node chatgpt/src/cli.mjs tools'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail 'Supported Linux architectures: x86_64 and ARM64.' ;;
esac
compatible() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<24||(major===24&&minor<21))process.exit(1);' >/dev/null 2>&1
}
mkdir -p "$workspace/.runtime"
node_version=v24.21.0
spotify_node="$HOME/.local/share/spotify-cli/node-$node_version-linux-$node_arch/bin/node"
if [ -n "${CHATGPT_NODE:-}" ]; then
  [ -x "$CHATGPT_NODE" ] && compatible "$CHATGPT_NODE" || fail 'CHATGPT_NODE must name an executable Node 24.21 or newer.'
  node_binary=$CHATGPT_NODE
elif [ -x "$spotify_node" ] && compatible "$spotify_node"; then
  node_binary=$spotify_node
elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && compatible "$(command -v node)"; then
  node_binary=$(command -v node)
else
  for dependency in curl tar xz sha256sum; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Install $dependency first."
  done
  node_home="$HOME/.local/share/rea-apps/node-$node_version-linux-$node_arch"
  if [ ! -x "$node_home/bin/node" ]; then
    temporary=$(mktemp -d "$workspace/.runtime/setup.XXXXXX")
    archive="node-$node_version-linux-$node_arch.tar.xz"
    base="https://nodejs.org/dist/$node_version"
    curl -fsSL "$base/$archive" -o "$temporary/$archive"
    curl -fsSL "$base/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
    (cd "$temporary" && awk -v archive="$archive" '$2 == archive { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > checksum && sha256sum -c checksum)
    mkdir -p "$(dirname -- "$node_home")"
    tar -xJf "$temporary/$archive" -C "$(dirname -- "$node_home")"
  fi
  node_binary="$node_home/bin/node"
  compatible "$node_binary" || fail 'The downloaded Node cannot run on this host; glibc 2.28 or newer is required.'
fi
node_binary=$("$node_binary" -p 'require("node:fs").realpathSync(process.execPath)')
ln -sfn "$node_binary" "$workspace/.runtime/node"
npm_binary="$(dirname -- "$node_binary")/npm"
if [ ! -x "$npm_binary" ]; then
  npm_binary=$(command -v npm) || fail 'npm is required to install the lightweight WebSocket client; use an official Node distribution or install npm.'
fi
PATH="$(dirname -- "$node_binary"):$PATH" "$npm_binary" ci --prefix "$workspace" --omit=dev --ignore-scripts --no-audit --no-fund
mkdir -p "$HOME/.local/bin"
destination="$HOME/.local/bin/chatgpt"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "An existing file occupies $destination; use $workspace/bin/chatgpt-linux directly."
  case "$(readlink "$destination")" in
    */chatgpt/bin/chatgpt-linux|*/chatgpt-cli/bin/chatgpt-linux) ;;
    *) fail "An unrelated symlink occupies $destination; use $workspace/bin/chatgpt-linux directly." ;;
  esac
fi
ln -sfn "$workspace/bin/chatgpt-linux" "$destination"
"$destination" tools >/dev/null
printf '%s\n' "Installed ChatGPT using $node_binary" 'CLI: ~/.local/bin/chatgpt' 'Commands use Node HTTP/WebSocket. Login returns an official link and device code for the user’s browser. The host needs no browser or Android runtime.'
