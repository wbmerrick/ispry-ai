#!/usr/bin/env python3
"""Synthesize the iSpry intro narration with Kokoro (local, no network at runtime).

Reads scripts/intro-narration.txt. Writes one wav per scene, a full voice track,
a quiet generated music bed, and manifest.json with timings for the edit.

Voice: af_heart (American English). Speed and pauses are chosen so the read
stays calm. "9 1 1" is spelled so it is not spoken as "nine hundred eleven".
"""

from __future__ import annotations

import argparse
import inspect
import json
import re
import wave
from pathlib import Path

import numpy as np
import soundfile as sf

SCENE_RE = re.compile(r"^\[([a-z0-9_-]+)\]\s*$")
META_RE = re.compile(r"^(KICKER|CAPTION):\s*(.*)$")


def parse_narration(path: Path) -> list[dict]:
    scenes: list[dict] = []
    current: dict | None = None
    lines: list[str] = []

    def flush() -> None:
        nonlocal current, lines
        if not current:
            lines = []
            return
        text = " ".join(part.strip() for part in lines if part.strip())
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            raise SystemExit(f"Scene [{current['id']}] has no spoken text")
        current["text"] = text
        scenes.append(current)
        current = None
        lines = []

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = SCENE_RE.match(line)
        if match:
            flush()
            current = {"id": match.group(1), "kicker": "", "caption": ""}
            continue
        if current is None:
            raise SystemExit(f"Text before the first scene: {line}")
        meta = META_RE.match(line)
        if meta:
            current[meta.group(1).lower()] = meta.group(2).strip()
            continue
        lines.append(line)
    flush()
    if not scenes:
        raise SystemExit(f"No scenes in {path}")
    return scenes


def silence(n: int) -> np.ndarray:
    return np.zeros(n, dtype=np.float32)


def music_bed(n: int, sr: int) -> np.ndarray:
    """Quiet royalty-free pad generated here. No sample library."""
    t = np.arange(n, dtype=np.float64) / sr
    # Low A major, slightly detuned so it is not a pure whistle.
    partials = [
        (110.0, 0.55),
        (110.7, 0.35),
        (164.81, 0.28),
        (220.0, 0.16),
        (329.63, 0.06),
    ]
    pad = np.zeros(n, dtype=np.float64)
    for freq, amp in partials:
        pad += amp * np.sin(2 * np.pi * freq * t)
    swell = 0.82 + 0.18 * np.sin(2 * np.pi * 0.045 * t)
    pad *= swell
    # One-pole lowpass, then a little air so the chord is soft.
    out = np.empty(n, dtype=np.float64)
    acc = 0.0
    for i, sample in enumerate(pad):
        acc += 0.035 * (sample - acc)
        out[i] = acc
    fade = int(sr * 1.6)
    if fade * 2 < n:
        ramp = np.linspace(0, 1, fade)
        out[:fade] *= ramp
        out[-fade:] *= ramp[::-1]
    peak = np.max(np.abs(out)) or 1.0
    out = (out / peak * 0.22).astype(np.float32)
    return out


def to_vtt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def vtt_cues(scenes: list[dict]) -> str:
    cues = ["WEBVTT", ""]
    n = 1
    for scene in scenes:
        parts = re.split(r"(?<=[.!?])\s+", scene["text"])
        parts = [p.strip() for p in parts if p.strip()]
        span = max(0.2, scene["speechEnd"] - scene["speechStart"])
        weights = [max(1, len(p)) for p in parts]
        total = sum(weights)
        cursor = scene["speechStart"]
        for part, weight in zip(parts, weights):
            dur = span * weight / total
            end = cursor + dur
            # Keep a hair of gap so cues do not overlap.
            cues.append(str(n))
            cues.append(f"{to_vtt_time(cursor)} --> {to_vtt_time(max(cursor + 0.3, end - 0.05))}")
            cues.append(part)
            cues.append("")
            n += 1
            cursor = end
    return "\n".join(cues).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--narration", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    from kokoro_onnx import Kokoro

    scenes = parse_narration(Path(args.narration))
    kokoro = Kokoro(args.model, args.voices)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sr = 24000
    lead = int(0.35 * sr)
    tail = int(0.24 * sr)
    end_tail = int(0.55 * sr)
    pieces: list[np.ndarray] = []
    manifest_scenes = []
    cursor = 0.0

    # kokoro-onnx 0.4.7's create() has no pause kwargs and raises TypeError.
    # 0.6.1 accepts them. Pass only the ones this install actually takes.
    create_params = inspect.signature(kokoro.create).parameters
    create_kwargs = {"voice": args.voice, "speed": args.speed, "lang": "en-us"}
    if "sentence_pause" in create_params:
        create_kwargs["sentence_pause"] = 0.18
    if "clause_pause" in create_params:
        create_kwargs["clause_pause"] = 0.08

    for index, scene in enumerate(scenes):
        samples, sample_rate = kokoro.create(scene["text"], **create_kwargs)
        if sample_rate != sr:
            raise SystemExit(f"Unexpected sample rate {sample_rate}")
        this_lead = lead if index == 0 else 0
        this_tail = end_tail if index == len(scenes) - 1 else tail
        audio = np.concatenate([silence(this_lead), samples.astype(np.float32), silence(this_tail)])
        # Light peak guard. Loudness is normalized later, on the mix.
        peak = float(np.max(np.abs(audio))) or 1.0
        if peak > 0.98:
            audio *= 0.98 / peak
        sf.write(out / f"{scene['id']}.wav", audio, sr)
        speech_start = cursor + this_lead / sr
        speech_end = speech_start + len(samples) / sr
        duration = len(audio) / sr
        manifest_scenes.append(
            {
                "id": scene["id"],
                "kicker": scene["kicker"],
                "caption": scene["caption"],
                "text": scene["text"],
                "start": round(cursor, 3),
                "speechStart": round(speech_start, 3),
                "speechEnd": round(speech_end, 3),
                "duration": round(duration, 3),
            }
        )
        phonemes = kokoro.tokenizer.phonemize(scene["text"], "en-us")
        print(f"{scene['id']:10} {duration:5.2f}s  {phonemes[:110]}")
        pieces.append(audio)
        cursor += duration

    voice = np.concatenate(pieces)
    sf.write(out / "voice.wav", voice, sr)
    bed = music_bed(len(voice), sr)
    sf.write(out / "music.wav", bed, sr)
    # Also write a 16-bit wav ffmpeg always accepts cleanly.
    with wave.open(str(out / "voice-pcm.wav"), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        pcm = np.clip(voice, -1, 1)
        handle.writeframes((pcm * 32767).astype(np.int16).tobytes())

    manifest = {
        "voice": args.voice,
        "speed": args.speed,
        "sampleRate": sr,
        "total": round(cursor, 3),
        "scenes": manifest_scenes,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out / "captions.vtt").write_text(vtt_cues(manifest_scenes), encoding="utf-8")
    print(f"TOTAL {cursor:.2f}s  voice {args.voice} speed {args.speed}")


if __name__ == "__main__":
    main()
