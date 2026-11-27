#!/usr/bin/env bash
# Build the homepage television spot: one cut, 20 seconds or less.
#
# What it makes
#   public/media/how-ispry-works.mp4     1920x1080, 30 fps, H.264, AAC, faststart
#   public/media/how-ispry-works.webm    VP9 + Opus
#   public/media/how-ispry-works-poster.webp
#   public/media/how-ispry-works.vtt     spoken captions, not burned into the picture
#   scripts/intro-narration.txt is the spoken script (edited by hand).
#
# The site ships one file, loudness-normalized to about -16 LUFS for the web.
# A -24 LUFS television master is written beside the build for broadcast use
# and is not what the homepage plays.
#
# Picture
#   Playwright drives system Chrome against a local static server of public/.
#   Real pages are captured (fictional Alex Example, a sore throat, no submit,
#   no birthdate). /api/speak and /api/handoff are blocked. Production
#   ispry.ai, Supabase, Akute, and Stripe are not called.
#   Supers are kinetic type in the site fonts and colors. Closed captions
#   stay in the VTT track.
#
# Sound
#   Kokoro af_heart speaks the script at speed 1.0. Do not raise the speed.
#   If the read exceeds 20 seconds, cut words.
#   Music is an original bed synthesized in scripts/intro_tts.py.
#   No third-party recording, sample, or composition. No royalty.
#
# Re-run from the repo root:
#   bash scripts/build-intro-video.sh
# Optional: SKIP_CAPTURE=1 bash scripts/build-intro-video.sh
#
# Needs: ffmpeg, python3, node, Google Chrome, and network on the first run
# (Playwright, kokoro-onnx, the Kokoro model). Later runs reuse
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
# Authored at 1.0. A faster read is not how this spot makes its length.
SPEED="${VOICE_SPEED:-1.0}"

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
  # Pin the release whose create() accepts sentence_pause. Older 0.4.7
  # rejects those kwargs; intro_tts.py also skips any kwarg the install lacks.
  "$VENV/bin/pip" install -q 'kokoro-onnx==0.6.1' soundfile numpy
fi

if [[ ! -f "$MODEL" || ! -f "$VOICES" ]]; then
  echo "Downloading Kokoro model…"
  curl -fsSL -o "$MODEL" -L "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
  curl -fsSL -o "$VOICES" -L "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
fi

if [[ ! -d "$TOOLS/node_modules/playwright" ]]; then
  echo "Installing Playwright…"
  mkdir -p "$TOOLS"
  (cd "$TOOLS" && npm init -y >/dev/null && npm install playwright@1.49.1 --silent)
fi

rm -rf "$WORK/audio" "$WORK/frames" "$WORK/segs"
if [[ "${SKIP_CAPTURE:-}" != "1" ]]; then
  rm -rf "$WORK/plates"
fi
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
