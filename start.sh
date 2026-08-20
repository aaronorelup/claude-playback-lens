#!/bin/sh
# Claude Playback Lens — start script (SPEC §9 / DESIGN §8).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "This app needs Node.js, which was not found on this computer."
  echo "Install it from https://nodejs.org (the LTS version is fine),"
  echo "then run this script again."
  echo ""
  exit 1
fi

node "./lens.mjs" --serve --open "$@"
status=$?
if [ $status -ne 0 ]; then
  echo "lens exited with status $status"
  # keep the window open when double-clicked from a file manager
  read -r _ 2>/dev/null
fi
exit $status
