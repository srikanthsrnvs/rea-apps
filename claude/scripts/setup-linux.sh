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
[ "$#" = 0 ] || fail 'Usage: ./scripts/setup-linux.sh (optional CLAUDE_CHAT_NODE=/absolute/path/to/node)'
[ "$(uname -s)" = Linux ] || fail 'This installer is for Linux. On macOS run node claude/src/cli.mjs tools'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail 'Supported Linux architectures: x86_64 and ARM64.' ;;
esac
compatible() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))process.exit(1);' >/dev/null 2>&1
}
mkdir -p "$workspace/.runtime"
node_version=v24.21.0
spotify_node="$HOME/.local/share/spotify-cli/node-$node_version-linux-$node_arch/bin/node"
if [ -n "${CLAUDE_CHAT_NODE:-}" ]; then
  [ -x "$CLAUDE_CHAT_NODE" ] && compatible "$CLAUDE_CHAT_NODE" || fail 'CLAUDE_CHAT_NODE must name an executable Node 22.19 or newer.'
  node_binary=$CLAUDE_CHAT_NODE
elif [ -x "$spotify_node" ] && compatible "$spotify_node"; then
  node_binary=$spotify_node
elif command -v node >/dev/null 2>&1 && compatible "$(command -v node)"; then
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
# cloudflared runs only during link login; later API calls use Node alone.
cloudflared_version=2026.10.0
if [ -n "${CLAUDE_CHAT_CLOUDFLARED:-}" ]; then
  [ -x "$CLAUDE_CHAT_CLOUDFLARED" ] || fail 'CLAUDE_CHAT_CLOUDFLARED must name an executable.'
  cloudflared_binary=$CLAUDE_CHAT_CLOUDFLARED
elif [ -x "$workspace/../resy/.runtime/cloudflared" ]; then
  cloudflared_binary="$workspace/../resy/.runtime/cloudflared"
elif command -v cloudflared >/dev/null 2>&1; then
  cloudflared_binary=$(command -v cloudflared)
else
  for dependency in curl sha256sum; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Install $dependency first."
  done
  case "$node_arch" in
    x64) cloudflared_arch=amd64; cloudflared_sha=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db ;;
    arm64) cloudflared_arch=arm64; cloudflared_sha=e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08 ;;
  esac
  cloudflared_home="$HOME/.local/share/rea-apps/claude-chat-cloudflared-$cloudflared_version-linux-$cloudflared_arch"
  cloudflared_binary="$cloudflared_home/cloudflared"
  if [ ! -x "$cloudflared_binary" ]; then
    temporary=$(mktemp -d "$workspace/.runtime/cloudflared.XXXXXX")
    cloudflared_archive="cloudflared-linux-$cloudflared_arch"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$cloudflared_version/$cloudflared_archive" -o "$temporary/cloudflared"
    (cd "$temporary" && printf '%s  cloudflared\n' "$cloudflared_sha" | sha256sum -c -)
    mkdir -p "$cloudflared_home"
    chmod 755 "$temporary/cloudflared"
    mv "$temporary/cloudflared" "$cloudflared_binary"
  fi
fi
"$cloudflared_binary" --version >/dev/null
ln -sfn "$cloudflared_binary" "$workspace/.runtime/cloudflared"
node_binary=$("$node_binary" -p 'require("node:fs").realpathSync(process.execPath)')
ln -sfn "$node_binary" "$workspace/.runtime/node"
mkdir -p "$HOME/.local/bin"
destination="$HOME/.local/bin/claude-chat"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "An existing file occupies $destination; use $workspace/bin/claude-chat-linux directly."
  case "$(readlink "$destination")" in
    */claude/bin/claude-chat-linux|*/claude-chat-cli/bin/claude-chat-linux) ;;
    *) fail "An unrelated symlink occupies $destination; use $workspace/bin/claude-chat-linux directly." ;;
  esac
fi
ln -sfn "$workspace/bin/claude-chat-linux" "$destination"
"$destination" tools >/dev/null
printf '%s\n' "Installed Claude chat using $node_binary" 'CLI: ~/.local/bin/claude-chat' 'Commands use Node HTTP. First login accepts an email code/button URL, then returns official verification for the user’s browser. The host needs no browser, Android or Mac helper.'
