#!/usr/bin/env python3
"""Démon Kokoro résident pour Lumen Pi.

Charge le modèle Kokoro UNE fois, puis reste en vie et synthétise à la demande :
le modèle ne se recharge plus à chaque énonciation (latence quasi nulle ensuite).

Protocole (lignes de texte sur stdin/stdout) :
  - au démarrage, après chargement du modèle : écrit `READY`.
  - requête  (stdin)  : un objet JSON par ligne
        {"text": "...", "voice": "ff_siwis", "out": "/tmp/x.wav", "speed": 1.0}
    → écrit le WAV dans `out`.
  - réponse (stdout) : `OK`  en cas de succès, sinon `ERR <message>`.

La langue est déduite du préfixe de la voix (ff_/fm_ → fr, b*_ → en-gb, sinon
en-us). Lumen tient le démon en vie via son stdin ; à la fermeture de Lumen, le
pipe se ferme (EOF) et le démon s'arrête proprement.
"""
import argparse
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


def make_kokoro(model: str, voices: str, threads: int) -> Kokoro:
    """Construit Kokoro en limitant les threads d'inférence onnxruntime, pour ne
    pas saturer le CPU (sinon l'app fige sur Raspberry Pi). Repli sur le mode
    par défaut si l'API de session n'est pas disponible dans cette version."""
    if threads and threads > 0:
        # Garde-fou pour les backends OpenMP/BLAS éventuels.
        os.environ.setdefault("OMP_NUM_THREADS", str(threads))
    try:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        if threads and threads > 0:
            opts.intra_op_num_threads = threads
            opts.inter_op_num_threads = 1
        session = ort.InferenceSession(
            model, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        return Kokoro.from_session(session, voices)
    except Exception:
        return Kokoro(model, voices)


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
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    kokoro = make_kokoro(args.model, args.voices, args.threads)  # chargement unique
    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = (req.get("text") or "").strip()
            voice = req.get("voice") or "af_heart"
            out = req["out"]
            if not text:
                print("OK", flush=True)
                continue
            samples, sample_rate = kokoro.create(
                text, voice=voice, speed=float(req.get("speed", 1.0)), lang=lang_for(voice)
            )
            sf.write(out, samples, sample_rate, format="WAV", subtype="PCM_16")
            print("OK", flush=True)
        except Exception as exc:  # on renvoie l'erreur à Lumen sans tuer le démon
            print("ERR " + str(exc).replace("\n", " "), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
