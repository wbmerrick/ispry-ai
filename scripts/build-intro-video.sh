#!/usr/bin/env bash
# Build the homepage intro: a narrated walkthrough of the real iSpry pages.
#
# What it makes
#   public/media/how-ispry-works.mp4     H.264, AAC 96 kbps, faststart, under 8 MB
#   public/media/how-ispry-works.webm    VP9 + Opus
#   public/media/how-ispry-works-poster.png
#   public/media/how-ispry-works.vtt     full spoken captions
#   scripts/intro-narration.txt is the spoken script (edited by hand).
#
# Picture
#   Playwright drives system Chrome against a local static server of public/.
#   1280x720, 30 fps. Slow push-ins and pans. Behind-the-scenes cards use the
#   same ink / cream / lime tokens as the site.
#   The chat is a mocked /api/spry reply about a sore throat. The account form
#   is filled with Alex Example, alex@example.com, age 34, and is never submitted.
#   No birthdate is typed. /api/speak and /api/handoff are blocked.
#   Production ispry.ai, Supabase, Akute, and Stripe are not called.
#   The one "How it works" plate hides .intro-video so the film does not
#   picture itself. Everything else is the real layout.
#
# Sound
#   Kokoro (af_heart) speaks scripts/intro-narration.txt locally.
#   A quiet pad is synthesized in scripts/intro_tts.py (no stock music).
#   The mix is loudness-normalized to -16 LUFS. Key lines are also burned in.
#
# Re-run from the repo root:
#   bash scripts/build-intro-video.sh
# Optional: VOICE_SPEED=1.05 SKIP_ENCODE=1 bash scripts/build-intro-video.sh
#
# Needs: ffmpeg, python3, node 22, Google Chrome, and network on the first run
# (Playwright, kokoro-onnx, the Kokoro model, IBM Plex). Later runs reuse
# /tmp/ispry-intro and /tmp/ispry-tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${ISPRY_INTRO_CACHE:-/tmp/ispry-intro}"
TOOLS="${ISPRY_INTRO_TOOLS:-/tmp/ispry-tools}"
WORK="${ISPRY_INTRO_WORK:-/tmp/ispry-intro-build}"
VENV="$CACHE/venv"
MODEL="$CACHE/models/kokoro-v1.0.onnx"
VOICES="$CACHE/models/voices-v1.0.bin"
FONT_DIR="$CACHE/fonts"
SPEED="${VOICE_SPEED:-1.1}"

mkdir -p "$CACHE/models" "$FONT_DIR" "$WORK"

if ! command -v ffmpeg >/dev/null || ! command -v node >/dev/null || ! command -v python3 >/dev/null; then
  echo "Need ffmpeg, node, and python3." >&2
  exit 1
fi
if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
  echo "Need Google Chrome (Playwright channel: chrome)." >&2
  exit 1
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q kokoro-onnx soundfile numpy
fi

if [[ ! -f "$MODEL" || ! -f "$VOICES" ]]; then
  echo "Downloading Kokoro model…"
  curl -fsSL -o "$MODEL" -L "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
  curl -fsSL -o "$VOICES" -L "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
fi

fetch_font() {
  local name="$1" url="$2"
  [[ -f "$FONT_DIR/$name" ]] || curl -fsSL -o "$FONT_DIR/$name" -L "$url"
}
fetch_font IBMPlexSans-SemiBold.ttf "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.6/latin-600-normal.ttf"
fetch_font IBMPlexMono-Medium.ttf "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.6/latin-500-normal.ttf"

if [[ ! -d "$TOOLS/node_modules/playwright" ]]; then
  echo "Installing Playwright…"
  mkdir -p "$TOOLS"
  (cd "$TOOLS" && npm init -y >/dev/null && npm install playwright@1.49.1 --silent)
fi

rm -rf "$WORK/audio" "$WORK/plates" "$WORK/segs"
mkdir -p "$WORK/audio"

echo "Synthesizing narration (Kokoro ${SPEED})…"
"$VENV/bin/python" "$ROOT/scripts/intro_tts.py" \
  --narration "$ROOT/scripts/intro-narration.txt" \
  --out "$WORK/audio" \
  --model "$MODEL" \
  --voices "$VOICES" \
  --speed "$SPEED"

echo "Capturing pages and encoding…"
ISPRY_TOOLS="$TOOLS" \
ISPRY_INTRO_WORK="$WORK" \
ISPRY_FONT_DIR="$FONT_DIR" \
node "$ROOT/scripts/build-intro-video.mjs"

echo "Done."
ls -lh "$ROOT/public/media"/how-ispry-works*
