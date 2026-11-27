#!/usr/bin/env python3
"""Synthesize the iSpry television spot with Kokoro (local, no network at runtime).

Reads scripts/intro-narration.txt. Writes one wav per scene, a full voice track,
an original music bed, and manifest.json with timings for the edit.

Voice: af_heart, the highest-graded Kokoro American English voice. Speed stays
at 1.0 so the read is not sped up. The spot must finish in 20 seconds or less;
if it does not, cut words. Do not raise speed.

"9 1 1" and "9 8 8" are spelled so they are not spoken as whole numbers.
A SAY: line, when present, is what Kokoro speaks. The paragraph under it
stays the caption and the transcript, so "ispry.ai" can be said
"I Spry dot A. I." without changing the spelling on screen.

Music: original bed synthesized in music_bed(). No third-party recording,
sample library, or composition. Written for this film. No royalty.
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
META_RE = re.compile(r"^(KICKER|CAPTION|SAY):\s*(.*)$")


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
            current = {"id": match.group(1), "kicker": "", "caption": "", "say": ""}
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


def _note(midi_note: float) -> float:
    return 440.0 * 2.0 ** ((midi_note - 69.0) / 12.0)


def music_bed(n: int, sr: int, voice: np.ndarray | None = None) -> np.ndarray:
    """Original stereo bed for this film. No samples and no third-party work.

    A short major-key pattern (electric-piano chords, soft bass, a quiet hat
    and a half-time kick) sits under the voice. The voice envelope ducks it.
    """
    rng = np.random.default_rng(11)
    y = np.zeros(n, dtype=np.float64)
    bpm = 96.0
    beat = 60.0 / bpm
    # Cmaj7, Am7, Fmaj7, Gadd9. Two beats each.
    chords = (
        (60, 64, 67, 71),
        (57, 60, 64, 67),
        (53, 57, 60, 64),
        (55, 59, 62, 69),
    )

    def place(freq: float, start: float, dur: float, amp: float, decay: float, partials: tuple[float, ...]) -> None:
        i0 = int(start * sr)
        length = int(dur * sr)
        i1 = min(n, i0 + length)
        if i1 <= i0:
            return
        tt = np.arange(i1 - i0, dtype=np.float64) / sr
        env = np.exp(-decay * tt)
        wave = np.zeros(i1 - i0, dtype=np.float64)
        for mult, gain in partials:
            wave += gain * np.sin(2 * np.pi * freq * mult * tt) * np.exp(-(mult - 1) * 2.2 * tt)
        y[i0:i1] += amp * wave * env

    chord_len = 2 * beat
    index = 0
    while index * chord_len < (n / sr) + chord_len:
        notes = chords[index % 4]
        start = index * chord_len
        for midi_note in notes:
            place(_note(midi_note), start, 1.7, 0.09, 1.65, ((1, 1.0), (2, 0.28), (3, 0.08)))
        place(_note(notes[0] - 24), start, 1.35, 0.16, 2.2, ((1, 1.0), (2, 0.22)))
        index += 1

    hat_every = beat / 2
    hats = 0
    while hats * hat_every < n / sr:
        i0 = int(hats * hat_every * sr)
        length = int(0.028 * sr)
        i1 = min(n, i0 + length)
        if i1 > i0:
            noise = rng.normal(0, 1, i1 - i0)
            noise = np.diff(noise, prepend=noise[0])
            env = np.exp(-80 * np.arange(i1 - i0) / sr)
            y[i0:i1] += (0.04 if hats % 2 else 0.018) * noise * env
        hats += 1

    kick_every = 2 * beat
    kicks = 0
    while kicks * kick_every < n / sr:
        i0 = int(kicks * kick_every * sr)
        length = int(0.15 * sr)
        i1 = min(n, i0 + length)
        if i1 > i0:
            tt = np.arange(i1 - i0, dtype=np.float64) / sr
            freq = 88 * np.exp(-16 * tt) + 44
            phase = 2 * np.pi * np.cumsum(freq) / sr
            y[i0:i1] += 0.22 * np.sin(phase) * np.exp(-9 * tt)
        kicks += 1

    low = np.empty(n, dtype=np.float64)
    acc = 0.0
    for i, sample in enumerate(y):
        acc += 0.16 * (sample - acc)
        low[i] = acc
    mixed = low + y * 0.14

    fade = min(int(0.28 * sr), n // 4)
    if fade > 1:
        ramp = np.linspace(0, 1, fade)
        mixed[:fade] *= ramp
        mixed[-fade:] *= ramp[::-1]

    delay = int(0.011 * sr)
    right = np.concatenate([np.zeros(delay), mixed[:-delay]]) if 0 < delay < n else mixed
    stereo = np.stack([mixed, right * 0.9], axis=1)

    if voice is not None and len(voice) >= n:
        level = 0.0
        attack = np.exp(-1 / (0.018 * sr))
        release = np.exp(-1 / (0.30 * sr))
        env = np.empty(n, dtype=np.float64)
        for i, sample in enumerate(np.abs(voice[:n])):
            coef = attack if sample > level else release
            level = coef * level + (1 - coef) * float(sample)
            env[i] = level
        presence = np.clip((env - 0.012) / 0.055, 0, 1)
        stereo *= (1 - 0.78 * presence)[:, None]

    peak = float(np.max(np.abs(stereo))) or 1.0
    return (stereo / peak * 0.32).astype(np.float32)


def to_vtt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def vtt_cues(scenes: list[dict]) -> str:
    cues = ["WEBVTT", ""]
    pending: list[tuple[float, float, str]] = []
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
            pending.append((cursor, end, part))
            cursor = end
    for n, (start, end, part) in enumerate(pending, start=1):
        cue_end = end - 0.04
        if n < len(pending):
            cue_end = min(cue_end, pending[n][0] - 0.04)
        if cue_end < start + 0.24:
            cue_end = start + 0.24
        cues.append(str(n))
        cues.append(f"{to_vtt_time(start)} --> {to_vtt_time(cue_end)}")
        cues.append(part)
        cues.append("")
    return "\n".join(cues).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--narration", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--max-seconds", type=float, default=20.0)
    args = parser.parse_args()

    from kokoro_onnx import Kokoro

    scenes = parse_narration(Path(args.narration))
    kokoro = Kokoro(args.model, args.voices)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sr = 24000
    # Breaths between lines. The voice itself is not sped up.
    lead = int(0.10 * sr)
    tail = int(0.06 * sr)
    # The brand respelling is a few syllables longer than "ispry.ai".
    # The final silence is shorter so the spot still ends within 20 seconds.
    # The voice speed is unchanged.
    end_tail = int(0.02 * sr)
    pieces: list[np.ndarray] = []
    manifest_scenes = []
    cursor = 0.0

    # kokoro-onnx 0.4.7's create() has no pause kwargs and raises TypeError.
    # 0.6.1 accepts them. Pass only the ones this install actually takes.
    create_params = inspect.signature(kokoro.create).parameters
    create_kwargs = {"voice": args.voice, "speed": args.speed, "lang": "en-us"}
    if "sentence_pause" in create_params:
        create_kwargs["sentence_pause"] = 0.10
    if "clause_pause" in create_params:
        create_kwargs["clause_pause"] = 0.04

    for index, scene in enumerate(scenes):
        spoken = scene["say"] or scene["text"]
        samples, sample_rate = kokoro.create(spoken, **create_kwargs)
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
                "say": spoken,
                "start": round(cursor, 3),
                "speechStart": round(speech_start, 3),
                "speechEnd": round(speech_end, 3),
                "duration": round(duration, 3),
            }
        )
        phonemes = kokoro.tokenizer.phonemize(spoken, "en-us")
        print(f"{scene['id']:10} {duration:5.2f}s  {phonemes[:110]}")
        pieces.append(audio)
        cursor += duration

    voice = np.concatenate(pieces)
    if args.speed > 1.0 + 1e-6:
        raise SystemExit("Refusing to speed the voice above 1.0. Cut the narration instead.")
    if cursor > args.max_seconds:
        raise SystemExit(
            f"Narration is {cursor:.2f}s, over the {args.max_seconds:.0f}s limit. "
            "Cut words. Do not raise the voice speed."
        )
    sf.write(out / "voice.wav", voice, sr)
    bed = music_bed(len(voice), sr, voice)
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
