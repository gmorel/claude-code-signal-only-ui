#!/bin/bash
# shoot-cmux.sh <out.png> — real screenshot of the cmux pane (workspace already selected).
# Brings cmux to the front for ~1.5 s, captures the screen, crops the terminal pane, gives focus back to Claude.
set -e
OUT="$1"; TMP="${OUT%.png}.full.png"
if ioreg -n Root -d1 2>/dev/null | grep -q '"CGSSessionScreenIsLocked"=Yes'; then echo "screen is locked: unlock it, then retry" >&2; exit 2; fi
WID=$(cmux list-windows 2>&1 | grep -oE '[0-9A-F]{8}-[0-9A-F-]{27}' | head -1)
FRONT=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || echo Claude)
[ "$FRONT" = "cmux" ] && FRONT=Claude
cmux focus-window --window "$WID" >/dev/null 2>&1
node -e "setTimeout(()=>{}, 1500)"
for try in 1 2 3; do screencapture -x -t png "$TMP" 2>/dev/null && [ -s "$TMP" ] && break; node -e "setTimeout(()=>{}, 1200)"; done
[ -s "$TMP" ] || { echo "screencapture failed three times" >&2; exit 1; }
osascript -e "tell application \"$FRONT\" to activate" >/dev/null 2>&1 || true
# pane region on the 1600x1000 screen: sidebar ends at x=390, tab bar ends at y=118
SHOOT_H=${SHOOT_H:-875}
SHOOT_W=${SHOOT_W:-1020}
SHOOT_Y=${SHOOT_Y:-118}
SHOOT_X=${SHOOT_X:-392}
sips -c "$SHOOT_H" "$SHOOT_W" --cropOffset "$SHOOT_Y" "$SHOOT_X" "$TMP" --out "$OUT" >/dev/null
rm -f "$TMP"
sips -g pixelWidth -g pixelHeight "$OUT" | tail -2 | tr '\n' ' '; echo " -> $OUT"
