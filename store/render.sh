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
for size in 32 48 128; do
  printf '<body style="margin:0"><img src="%s/icons/icon.svg" width="%s" height="%s" style="display:block">' "$PWD" "$size" "$size" > "$tmp/$size.html"
  shot "file://$tmp/$size.html" "$size" "$size" "icons/icon-$size.png"
done
printf '<body style="margin:0"><img src="%s/icons/icon-16.svg" width="16" height="16" style="display:block">' "$PWD" > "$tmp/16.html"
shot "file://$tmp/16.html" 16 16 icons/icon-16.png
shot "file://$PWD/store/promo/tile.html#small" 440 280 store/promo/small-tile.png
shot "file://$PWD/store/promo/tile.html" 1400 560 store/promo/marquee.png
ls -l icons/*.png store/promo/*.png
