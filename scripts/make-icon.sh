#!/usr/bin/env bash
# Rebuilds build/icon.icns from assets/wiley-mark.svg.
#
# Every size is rendered from the vector rather than downsampled from one big
# PNG, so the 16 and 32 point versions keep clean edges instead of the mush
# resampling gives them. sips is the fallback when librsvg is not installed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/assets/wiley-mark.svg"
iconset="$root/build/icon.iconset"
out="$root/build/icon.icns"

rm -rf "$iconset"
mkdir -p "$iconset"

render() { # render <pixels> <file>
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$1" -h "$2" "$src" -o "$3"
  else
    local master="$iconset/.master.png"
    [ -f "$master" ] || sips -s format png "$src" --out "$master" >/dev/null
    sips -z "$2" "$1" "$master" --out "$3" >/dev/null
  fi
}

for size in 16 32 128 256 512; do
  render "$size" "$size" "$iconset/icon_${size}x${size}.png"
  render "$((size * 2))" "$((size * 2))" "$iconset/icon_${size}x${size}@2x.png"
done
rm -f "$iconset/.master.png"

iconutil -c icns "$iconset" -o "$out"
echo "wrote $out ($(du -h "$out" | cut -f1))"
