#!/usr/bin/env bash
# Renders the extension icons and store promo tiles with headless Chrome.
# Usage: store/render.sh [path-to-chrome]. Screenshots are taken by hand (they need a
# signed-in GitHub session); see store/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome=${1:-${CHROME:-google-chrome}}
shot() { # url width height output
  "$chrome" --headless --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --allow-file-access-from-files \
    --window-size="$2,$3" --screenshot="$4" "$1" >/dev/null 2>&1
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Light icon, full-bleed at every size. Each size has its own drawing tuned for its pixel grid;
# only the 128 px one has a border (a light tile vanishes on the white store page without it).
render() { # svg size output
  printf '<body style="margin:0"><img src="%s" width="%s" height="%s" style="display:block">' "$1" "$2" "$2" > "$tmp/$2.html"
  shot "file://$tmp/$2.html" "$2" "$2" "$3"
}
render "$PWD/icons/icon-16.svg" 16 icons/icon-16.png
render "$PWD/icons/icon-32.svg" 32 icons/icon-32.png
render "$PWD/icons/icon-48.svg" 48 icons/icon-48.png
render "$PWD/icons/icon.svg" 128 icons/icon-128.png
shot "file://$PWD/store/promo/tile.html#small" 440 280 store/promo/small-tile.png
shot "file://$PWD/store/promo/tile.html" 1400 560 store/promo/marquee.png
# GitHub repository social preview (Settings > Social preview), 1280x640.
shot "file://$PWD/store/promo/tile.html" 1280 640 store/promo/social-preview.png
ls -l icons/*.png store/promo/*.png
