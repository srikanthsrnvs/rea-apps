#!/bin/sh
set -eu
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p "$HOME/.local/state/spotify-cli"
dbus-uuidgen --ensure="$HOME/.local/state/spotify-cli/machine-id"
exec dbus-run-session -- xvfb-run -a -s '-screen 0 1280x800x24' \
  /usr/bin/spotify --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --browser-subprocess-path=/usr/share/spotify/spotify \
  --no-zygote --disable-gpu --in-process-gpu --disable-dev-shm-usage
