#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "${1:-}" in
  '') [ "$#" = 0 ] || exit 2; mode=both; spotify_option= ;;
  --no-build) [ "$#" = 1 ] || exit 2; mode=both; spotify_option=--no-build ;;
  --uber-only) [ "$#" = 1 ] || exit 2; mode=uber; spotify_option= ;;
  --instagram-only) [ "$#" = 1 ] || exit 2; mode=instagram; spotify_option= ;;
  --resy-only) [ "$#" = 1 ] || exit 2; mode=resy; spotify_option= ;;
  --opentable-only) [ "$#" = 1 ] || exit 2; mode=opentable; spotify_option= ;;
  --erewhon-only) [ "$#" = 1 ] || exit 2; mode=erewhon; spotify_option= ;;
  --expedia-only) [ "$#" = 1 ] || exit 2; mode=expedia; spotify_option= ;;
  *) printf '%s\n' 'Usage: ./scripts/setup-linux.sh [--no-build|--uber-only|--instagram-only|--resy-only|--opentable-only|--erewhon-only|--expedia-only]' >&2; exit 2 ;;
esac
if [ "$mode" = both ]; then
  if [ -n "$spotify_option" ]; then
    "$workspace/spotify/scripts/setup-headless.sh" "$spotify_option"
  else
    "$workspace/spotify/scripts/setup-headless.sh"
  fi
  mkdir -p "$HOME/.local/bin"
  destination="$HOME/.local/bin/spotify"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -L "$destination" ] || { printf '%s\n' "An existing file occupies $destination." >&2; exit 1; }
    case "$(readlink "$destination")" in
      */spotify-desktop-cli/bin/spotify-headless|*/spotify/bin/spotify-headless|*/spotify/bin/spotify) ;;
      *) printf '%s\n' "An unrelated symlink occupies $destination." >&2; exit 1 ;;
    esac
  fi
  ln -sfn "$workspace/spotify/bin/spotify" "$destination"
  UBER_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/uber/scripts/setup-linux.sh"
  INSTAGRAM_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/instagram/scripts/setup-linux.sh"
  RESY_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/resy/scripts/setup-linux.sh"
  OPENTABLE_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/opentable/scripts/setup-linux.sh"
  EREWHON_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/erewhon/scripts/setup-linux.sh"
  EXPEDIA_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/expedia/scripts/setup-linux.sh"
elif [ "$mode" = uber ]; then
  "$workspace/uber/scripts/setup-linux.sh"
elif [ "$mode" = instagram ]; then
  "$workspace/instagram/scripts/setup-linux.sh"
elif [ "$mode" = resy ]; then
  "$workspace/resy/scripts/setup-linux.sh"
elif [ "$mode" = opentable ]; then
  "$workspace/opentable/scripts/setup-linux.sh"
elif [ "$mode" = erewhon ]; then
  "$workspace/erewhon/scripts/setup-linux.sh"
else
  "$workspace/expedia/scripts/setup-linux.sh"
fi
printf '%s\n' 'Add ~/.local/bin to PATH if needed: export PATH="$HOME/.local/bin:$PATH"'
