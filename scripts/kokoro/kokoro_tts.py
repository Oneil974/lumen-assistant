#!/usr/bin/env python3
"""Inférence Kokoro (TTS ONNX, Apache 2.0) pour Lumen Pi.

Lit le texte sur stdin, synthétise avec `kokoro-onnx` (CPU) et écrit un WAV
PCM 16 bits sur stdout — destiné à être redirigé vers `aplay`. La langue est
déduite du préfixe de la voix Kokoro :
  - ff_/fm_  → fr-fr     (français)
  - b*_      → en-gb     (anglais britannique)
  - sinon    → en-us     (anglais américain)

Dépendances installées par scripts/kokoro/install.sh (venv /opt/kokoro-venv) :
  kokoro-onnx, soundfile  (+ espeak-ng système pour la phonémisation).
"""
import argparse
import io
import sys


def lang_for(voice: str) -> str:
    if voice.startswith(("ff", "fm")):
        return "fr-fr"
    if voice.startswith("b"):
        return "en-gb"
    return "en-us"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--voices", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        return 0

    from kokoro_onnx import Kokoro
    import soundfile as sf

    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(
        text, voice=args.voice, speed=args.speed, lang=lang_for(args.voice)
    )

    # WAV en mémoire (BytesIO seekable) puis vidage sur stdout (non seekable).
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    sys.stdout.buffer.write(buf.getvalue())
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
