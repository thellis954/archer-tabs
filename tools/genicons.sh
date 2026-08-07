#!/bin/sh
# Regenerate assets/icon-*.png from the Archer mark.
#
# Rendered with headless Chromium so the shipped PNGs are exactly what Chrome
# paints. Stroke weight and inset are tuned per size — a constant weight goes
# spindly at 16px. See docs/BRAND.md for the geometry.
#
# Usage: sh tools/genicons.sh [path-to-chrome]

set -e

CHROME=${1:-${CHROME:-}}
if [ -z "$CHROME" ]; then
  for c in \
    /opt/pw-browsers/chromium-*/chrome-linux/chrome \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome
  do
    [ -x "$c" ] && CHROME=$c && break
  done
fi
[ -x "$CHROME" ] || { echo "chrome not found; pass a path: sh tools/genicons.sh /path/to/chrome" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/assets
TMP=${TMPDIR:-/tmp}/archer-icons.$$
mkdir -p "$OUT" "$TMP"
trap 'rm -rf "$TMP"' EXIT

# size radius mark stroke
for spec in "128 28 84 2.4" "48 11 32 2.6" "32 7 22 2.9" "16 4 12 3.3"; do
  # shellcheck disable=SC2086
  set -- $spec
  S=$1 R=$2 M=$3 W=$4

  cat > "$TMP/icon-$S.html" <<EOF
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${S}px;height:${S}px;overflow:hidden;background:transparent}
  .t{width:${S}px;height:${S}px;border-radius:${R}px;background:#141416;
     display:flex;align-items:center;justify-content:center}
</style>
<div class="t">
  <svg width="$M" height="$M" viewBox="0 0 32 32" fill="none"
       stroke-width="$W" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 26.5 L16 5.5 L26 26.5" stroke="#FBF7F0"/>
    <path d="M9.8 18.5 Q16 24.5 22.2 18.5" stroke="#F59E0B"/>
  </svg>
</div>
EOF

  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size="$S,$S" --screenshot="$OUT/icon-$S.png" \
    "file://$TMP/icon-$S.html" 2>/dev/null

  echo "assets/icon-$S.png"
done
