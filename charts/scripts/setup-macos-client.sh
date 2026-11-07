#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'The login receiver runs on your Mac, not on the Linux host.'
[ "$#" -ge 4 ] || fail 'Usage: CHARTS_NODE=/absolute/path/node sh charts/scripts/setup-macos-client.sh --ssh-target HOST --remote-cli /absolute/path/charts [--profile orin]'
node_binary=${CHARTS_NODE:-$(command -v node || true)}
[ -n "$node_binary" ] && [ -x "$node_binary" ] || fail 'Set CHARTS_NODE to a Node 24.21+ executable.'
"$node_binary" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<21))process.exit(1)' || fail 'Node 24.21+ is required on the Mac.'
node_binary=$("$node_binary" -p 'require("node:fs").realpathSync(process.execPath)')
command -v swiftc >/dev/null 2>&1 || fail 'Install the Apple command-line developer tools to build the small local receiver.'
"$node_binary" "$workspace/bin/charts-client" configure "$@"
app="$HOME/Applications/Charts Login.app"
mkdir -p "$HOME/Applications"
if [ -e "$app" ]; then
  [ ! -L "$app" ] && [ -f "$app/Contents/Resources/.rea-charts-client" ] || fail 'An unrelated app occupies Charts Login.app; it was not replaced.'
fi
staging=$(mktemp -d "$HOME/Applications/.charts-login.XXXXXX")
trap 'rm -rf "$staging"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$staging/Charts Login.app/Contents/MacOS" "$staging/Charts Login.app/Contents/Resources"
cp -R "$workspace/src" "$staging/Charts Login.app/Contents/Resources/"
touch "$staging/Charts Login.app/Contents/Resources/.rea-charts-client"
"$node_binary" --input-type=module - "$staging/Charts Login.app/Contents/Info.plist" "$node_binary" <<'JS'
import fs from 'node:fs';
const [filename,node] = process.argv.slice(2);
const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
fs.writeFileSync(filename, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.rea.charts.login</string>
<key>CFBundleName</key><string>Charts Login</string>
<key>CFBundleExecutable</key><string>ChartsLogin</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>REAChartsNode</key><string>${xml(node)}</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Charts authorization</string><key>CFBundleURLSchemes</key><array><string>rea-charts</string></array></dict></array>
</dict></plist>`);
JS
swiftc -O "$workspace/macos/ChartsLogin.swift" -o "$staging/Charts Login.app/Contents/MacOS/ChartsLogin"
codesign --force --sign - "$staging/Charts Login.app" >/dev/null 2>&1
backup="$staging/previous.app"
if [ -e "$app" ]; then mv "$app" "$backup"; fi
mv "$staging/Charts Login.app" "$app"
"$app/Contents/MacOS/ChartsLogin" --register
printf '%s\n' 'Installed Charts Login. Open clientUrl from charts login to sign in on TradingView and return the session over SSH.'
