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
  --claude-only) [ "$#" = 1 ] || exit 2; mode=claude; spotify_option= ;;
  --chatgpt-only) [ "$#" = 1 ] || exit 2; mode=chatgpt; spotify_option= ;;
  --amazon-only) [ "$#" = 1 ] || exit 2; mode=amazon; spotify_option= ;;
  --airbnb-only) [ "$#" = 1 ] || exit 2; mode=airbnb; spotify_option= ;;
  *) printf '%s\n' 'Usage: ./scripts/setup-linux.sh [--no-build|--uber-only|--instagram-only|--resy-only|--opentable-only|--erewhon-only|--expedia-only|--amazon-only|--claude-only|--chatgpt-only|--airbnb-only]' >&2; exit 2 ;;
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
  CLAUDE_CHAT_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/claude/scripts/setup-linux.sh"
  CHATGPT_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/chatgpt/scripts/setup-linux.sh"
  AMAZON_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/amazon/scripts/setup-linux.sh"
  AIRBNB_NODE="$workspace/spotify/.runtime/node/bin/node" "$workspace/airbnb/scripts/setup-linux.sh"
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
elif [ "$mode" = expedia ]; then
  "$workspace/expedia/scripts/setup-linux.sh"
elif [ "$mode" = claude ]; then
  "$workspace/claude/scripts/setup-linux.sh"
elif [ "$mode" = chatgpt ]; then
  "$workspace/chatgpt/scripts/setup-linux.sh"
elif [ "$mode" = airbnb ]; then
  "$workspace/airbnb/scripts/setup-linux.sh"
else
  "$workspace/amazon/scripts/setup-linux.sh"
fi
printf '%s\n' 'Add ~/.local/bin to PATH if needed: export PATH="$HOME/.local/bin:$PATH"'
