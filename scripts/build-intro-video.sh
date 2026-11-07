#!/usr/bin/env bash
# Build the patient intro explainer (silent, captioned) for the homepage.
# Uses ffmpeg drawtext — no Chrome — so it runs reliably in CI/agents.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/media"
WORK=/tmp/ispry-intro
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"

FONTB="${FONTB:-/usr/share/fonts/truetype/macos/Inter-Bold.ttf}"
FONTR="${FONTR:-/usr/share/fonts/truetype/macos/Inter-Regular.ttf}"
FONTS="${FONTS:-/usr/share/fonts/truetype/macos/Inter-SemiBold.ttf}"
for f in "$FONTB" "$FONTR" "$FONTS"; do
  [[ -f "$f" ]] || { echo "Missing font: $f" >&2; exit 1; }
done

# Advance width of "iSpry" at 22px Inter SemiBold (measured once; regenerate if font changes)
ISPRY_W=56
AI_X=$((88 + ISPRY_W))

make_slide() {
  local n="$1" kicker="$2" title="$3" body1="$4" body2="$5"
  local pct=$((n * 16))
  local esc_title="${title//:/\\:}"
  local esc_b1="${body1//:/\\:}"
  local esc_b2="${body2//:/\\:}"
  ffmpeg -y -f lavfi -i "color=c=0x07080C:s=1280x720:d=1" -frames:v 1 \
    -vf "\
drawbox=x=0:y=0:w=1280:h=720:color=0x07080C:t=fill,\
drawtext=fontfile=${FONTS}:text='iSpry':fontsize=22:fontcolor=0xF4F2EB:x=88:y=72,\
drawtext=fontfile=${FONTS}:text='.ai':fontsize=22:fontcolor=0xD7FF3F:x=${AI_X}:y=72,\
drawtext=fontfile=${FONTS}:text='${kicker}':fontsize=14:fontcolor=0xD7FF3F:x=88:y=210,\
drawtext=fontfile=${FONTB}:text='${esc_title}':fontsize=58:fontcolor=0xF4F2EB:x=88:y=250,\
drawtext=fontfile=${FONTR}:text='${esc_b1}':fontsize=26:fontcolor=0xC9CEDA:x=88:y=410,\
drawtext=fontfile=${FONTR}:text='${esc_b2}':fontsize=26:fontcolor=0xC9CEDA:x=88:y=450,\
drawbox=x=88:y=660:w=1104:h=4:color=0x1A2030:t=fill,\
drawbox=x=88:y=660:w=$((pct * 11)):h=4:color=0xD7FF3F:t=fill" \
    "$WORK/slide-$n.png" 2>/dev/null
  file "$WORK/slide-$n.png"
}

echo "Rendering slides…"
make_slide 1 "60-SECOND INTRO" "How iSpry works." \
  "Physician-led telehealth for adults in Tennessee —" "no waiting room, no long drive."
make_slide 2 "STEP 01" "Create your account." \
  "Name, email, age, sex, and Tennessee. Free —" "not membership. Required before Spry."
make_slide 3 "STEP 02" "Talk with Spry." \
  "Type or talk. Spry asks a few triage questions." "Leave your name and birthdate out of chat."
make_slide 4 "STEP 03" "Spry writes a synopsis." \
  "Most-likely problem and a short differential —" "prepared for your physician in Akute."
make_slide 5 "STEP 04" "A doctor reviews it." \
  "Same-day review if submitted by 6 pm Central." "Then pharmacy and booking in Akute."
make_slide 6 "READY WHEN YOU ARE" "Then ask below." \
  "Start with Ask Spry. Visit \$49 or membership \$100/mo." "Emergencies\: call 911."

DUR=5.5
FADE=0.55
INPUTS=()
for i in 1 2 3 4 5 6; do
  INPUTS+=(-loop 1 -t "$DUR" -i "$WORK/slide-$i.png")
done

OFF=(4.950 9.900 14.850 19.800 24.750)
FILTER="[0][1]xfade=transition=fade:duration=${FADE}:offset=${OFF[0]}[v01];"
FILTER+="[v01][2]xfade=transition=fade:duration=${FADE}:offset=${OFF[1]}[v12];"
FILTER+="[v12][3]xfade=transition=fade:duration=${FADE}:offset=${OFF[2]}[v23];"
FILTER+="[v23][4]xfade=transition=fade:duration=${FADE}:offset=${OFF[3]}[v34];"
FILTER+="[v34][5]xfade=transition=fade:duration=${FADE}:offset=${OFF[4]}[vout]"

echo "Encoding mp4…"
ffmpeg -y "${INPUTS[@]}" -filter_complex "$FILTER" -map "[vout]" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  "$OUT/how-ispry-works.mp4"

echo "Encoding webm…"
ffmpeg -y -i "$OUT/how-ispry-works.mp4" -c:v libvpx-vp9 -b:v 0 -crf 36 -an -row-mt 1 \
  "$OUT/how-ispry-works.webm"

cp "$WORK/slide-1.png" "$OUT/how-ispry-works-poster.png"
ls -lh "$OUT"/how-ispry-works*
echo "Done."
