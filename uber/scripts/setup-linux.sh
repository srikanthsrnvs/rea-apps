#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$#" = 0 ] || fail 'Usage: ./scripts/setup-linux.sh (optional UBER_NODE=/absolute/path/to/node)'
[ "$(uname -s)" = Linux ] || fail 'This installer is for Linux. On macOS use npm install --global .'
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
if [ -n "${UBER_NODE:-}" ]; then
  [ -x "$UBER_NODE" ] && compatible "$UBER_NODE" || fail 'UBER_NODE must name an executable Node 22.19 or newer.'
  node_binary=$UBER_NODE
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
    trap 'rm -rf "$temporary"' EXIT
    trap 'exit 1' HUP INT TERM
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
mkdir -p "$HOME/.local/bin"
destination="$HOME/.local/bin/uber"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "An existing file occupies $destination; use $workspace/bin/uber-linux directly."
  case "$(readlink "$destination")" in
    */uber/bin/uber-linux|*/uber-cli/bin/uber-linux) ;;
    *) fail "An unrelated symlink occupies $destination; use $workspace/bin/uber-linux directly." ;;
  esac
fi
ln -sfn "$workspace/bin/uber-linux" "$destination"
"$destination" tools >/dev/null
printf '%s\n' "Installed Uber using $node_binary" 'CLI: ~/.local/bin/uber' 'First login: uber login, then uber auth complete'
