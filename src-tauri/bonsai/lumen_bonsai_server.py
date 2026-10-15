"""Serveur Bonsai Image de Lumen.

Point d'entrée lancé par ``src-tauri/src/bonsai.rs`` depuis le runtime Python
autonome embarqué (``resources/bonsai/<cible>/python``). Il enveloppe le
backend officiel de PrismML (``prism-image-studio`` sur MLX, ou son pendant
``backend_gpu`` sur CUDA) sans le modifier, et sert le contrat que Lumen
attend :

    GET  /health     → {"ok": true, "kind": "mlx", "variant": "ternary", …}
    GET  /backends   → {"kind", "supported_families", "default_family", "healthy"}
    POST /generate   → image/png  (route officielle, inchangée)

Tout est piloté par l'environnement posé par Lumen :

    LUMEN_BONSAI_KIND        mlx | gemlite
    LUMEN_BONSAI_VARIANT     ternary | binary   (variante chargée au démarrage)
    LUMEN_BONSAI_MODELS_DIR  dossier des modèles (bonsai-image-4B-<variante>-<noyau>/)
    LUMEN_BONSAI_LEGACY_MODELS_DIR  ancien dossier (clone de démo), optionnel
    LUMEN_BONSAI_FAMILIES    familles présentes, ex. "bonsai-ternary,bonsai-binary"
    LUMEN_BONSAI_CACHE_DIR   caches Triton/gemlite (CUDA uniquement)

Les variables ``MFLUX_STUDIO_*`` lues par le backend officiel sont dérivées
d'ici, exactement comme le fait ``scripts/serve.sh`` du dépôt de démo.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

KIND = os.environ.get("LUMEN_BONSAI_KIND") or ("mlx" if sys.platform == "darwin" else "gemlite")

VARIANT = os.environ.get("LUMEN_BONSAI_VARIANT", "ternary")
if VARIANT not in ("ternary", "binary"):
    VARIANT = "ternary"


def _model_dir(variant: str) -> Path:
    """Dossier d'un modèle : le dossier courant, sinon l'emplacement hérité."""
    name = f"bonsai-image-4B-{variant}-{KIND}"
    roots = [os.environ.get("LUMEN_BONSAI_MODELS_DIR"), os.environ.get("LUMEN_BONSAI_LEGACY_MODELS_DIR")]
    candidates = [Path(r) / name for r in roots if r]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0] if candidates else Path(name).resolve()


def _families() -> list[str]:
    raw = os.environ.get("LUMEN_BONSAI_FAMILIES", "")
    allowed = {"bonsai-ternary", "bonsai-binary"}
    fams = [f.strip() for f in raw.split(",") if f.strip() in allowed]
    if not fams:
        fams = [f"bonsai-{VARIANT}"]
    return fams


TERNARY_DIR = _model_dir("ternary")
BINARY_DIR = _model_dir("binary")
FAMILIES = _families()
DEFAULT_BACKEND = f"bonsai-{VARIANT}-{KIND}"


def _configure_mlx() -> None:
    env = os.environ
    env.setdefault("MFLUX_STUDIO_DEFAULT_BACKEND", DEFAULT_BACKEND)
    # Les deux chemins sont posés inconditionnellement : image-studio ne les
    # valide qu'à l'usage, et une bascule ternary↔binary à chaud les lit tous
    # les deux (cf. serve.sh du dépôt de démo).
    env.setdefault("MFLUX_STUDIO_BAKED_MODEL_PATH", str(TERNARY_DIR))
    env.setdefault("MFLUX_STUDIO_BAKED_BINARY_MODEL_PATH", str(BINARY_DIR))
    env.setdefault("MFLUX_STUDIO_TE_4BIT", "true")
    env.setdefault("MFLUX_STUDIO_FORCE_DISABLE_GPU", "true")


def _first_dir(root: Path, prefix: str, fallback: str) -> Path:
    if root.is_dir():
        for child in sorted(root.iterdir()):
            if child.is_dir() and child.name.startswith(prefix):
                return child
    return root / fallback


def _configure_gemlite() -> None:
    env = os.environ
    cache = Path(env.get("LUMEN_BONSAI_CACHE_DIR") or (Path.home() / ".cache" / "lumen-bonsai"))
    (cache / "triton").mkdir(parents=True, exist_ok=True)
    (cache / "gemlite").mkdir(parents=True, exist_ok=True)
    # Triton lit TRITON_CACHE_DIR une seule fois, à l'import : avant torch.
    env.setdefault("TRITON_CACHE_DIR", str(cache / "triton"))
    env.setdefault("GEMLITE_PERSIST_PATH", str(cache / "gemlite" / "autotune.json"))
    env.setdefault("MFLUX_STUDIO_GPU_TOKEN", "lumen-local-unused")
    env.setdefault("MFLUX_STUDIO_GPU_DEFAULT_BACKEND", DEFAULT_BACKEND)
    active = TERNARY_DIR if VARIANT == "ternary" else BINARY_DIR
    env.setdefault(
        "MFLUX_STUDIO_GPU_TERNARY_TRANSFORMER_PATH",
        str(_first_dir(TERNARY_DIR, "transformer-gemlite-", "transformer-gemlite-int2")),
    )
    env.setdefault(
        "MFLUX_STUDIO_GPU_BINARY_TRANSFORMER_PATH",
        str(_first_dir(BINARY_DIR, "transformer-gemlite-", "transformer-gemlite-int1")),
    )
    env.setdefault("MFLUX_STUDIO_GPU_TEXT_ENCODER_PATH", str(active / "text_encoder-hqq-4bit"))
    env.setdefault("MFLUX_STUDIO_GPU_VAE_PATH", str(active / "vae"))
    env.setdefault("MFLUX_STUDIO_GPU_TOKENIZER_PATH", str(active / "text_encoder-hqq-4bit" / "tokenizer"))


def _patch_triton_autotune_generators() -> None:
    """Rend `triton.autotune` tolérant aux générateurs de configurations.

    gemlite 0.5.1 décore ses noyaux avec `@triton.autotune(configs=
    get_autotune_config(), …)` où `get_autotune_config` est un GÉNÉRATEUR.
    Triton ≤ 3.7 l'itérait ; Triton 3.8 (triton-windows 3.8.0.postN) appelle
    `len(configs)` et la première génération meurt en « object of type
    'generator' has no len() ». On matérialise la liste avant de déléguer. À
    poser AVANT tout import de gemlite, puisque la décoration a lieu à l'import.
    """
    try:
        import triton
    except Exception:
        return
    if getattr(triton, "_lumen_autotune_list", False):
        return
    from types import GeneratorType

    original = triton.autotune

    def autotune(*args, **kwargs):
        if args and isinstance(args[0], GeneratorType):
            args = (list(args[0]),) + args[1:]
        if isinstance(kwargs.get("configs"), GeneratorType):
            kwargs["configs"] = list(kwargs["configs"])
        return original(*args, **kwargs)

    triton.autotune = autotune
    triton._lumen_autotune_list = True


def _patch_gemlite_param_assign() -> None:
    """Réconcilie backend_gpu (image-studio) avec les gemlite récents.

    `pipeline_gpu._load_gemlite_layers_from_state` déplace les poids sur le GPU
    par affectation directe : `gl.W_q = gl.W_q.to(device)`. Or le
    `load_state_dict` de gemlite enregistre désormais W_q/scales/zeros comme
    `nn.Parameter`, et `nn.Module.__setattr__` refuse d'écraser un Parameter
    par un simple Tensor : « cannot assign 'torch.cuda.ByteTensor' as
    parameter 'W_q' » — le moteur meurt au préchauffage (exit 3) sur toute
    machine CUDA. Plutôt que de recopier le chargeur, on rend l'affectation
    tolérante sur la classe gemlite : un Tensor affecté à un Parameter existant
    le remplace par un Parameter (figé) sur le nouveau périphérique.
    """
    try:
        import torch
        import torch.nn as nn
        from gemlite.core import GemLiteLinearTriton
    except Exception as exc:  # gemlite absent : le vrai message viendra de l'import du backend
        print(f"[lumen-bonsai] gemlite non patché : {exc}", file=sys.stderr)
        return
    if getattr(GemLiteLinearTriton, "_lumen_param_assign", False):
        return
    original = GemLiteLinearTriton.__setattr__

    def __setattr__(self, name, value):  # noqa: N807
        params = self.__dict__.get("_parameters")
        if (
            params is not None
            and name in params
            and isinstance(value, torch.Tensor)
            and not isinstance(value, nn.Parameter)
        ):
            params[name] = nn.Parameter(value, requires_grad=False)
            return
        original(self, name, value)

    GemLiteLinearTriton.__setattr__ = __setattr__
    GemLiteLinearTriton._lumen_param_assign = True


def _patch_gemlite_lean_loader() -> None:
    """Charge le transformer gemlite sans faire déborder la RAM.

    Le chargeur officiel (`pipeline_gpu._load_gemlite_transformer`) fait trois
    choses coûteuses en mémoire CPU, invisibles sur un serveur à 256 Go mais
    fatales sur un poste à 24 Go (swap, puis 500 à la génération) :
      1. `Flux2Transformer2DModel.from_config(cfg)` initialise les 4 milliards
         de poids au hasard en bf16 : ~8 Go de RAM jetés dès la ligne suivante ;
      2. `torch.load(state_dict.pt)` lit l'archive entière en RAM (2 à 4 Go)
         au lieu de la projeter en mémoire ;
      3. `.to(float16)` recopie encore une fois le tout avant l'envoi au GPU.
    Ici : squelette sur le périphérique « meta » (aucune allocation), archive
    projetée (`mmap=True`), poids rattachés par `assign=True`, puis état libéré
    avant la montée sur le GPU. Même contrat de sortie que l'original ; en cas
    d'échec on retombe sur le chargeur officiel.
    """
    try:
        from backend_gpu import pipeline_gpu
    except Exception as exc:  # backend absent : le vrai message viendra plus loin
        print(f"[lumen-bonsai] chargeur gemlite non patché : {exc}", file=sys.stderr)
        return
    if getattr(pipeline_gpu, "_lumen_lean_loader", False):
        return
    original = pipeline_gpu._load_gemlite_transformer

    def lean(path, *, device=pipeline_gpu.DEFAULT_DEVICE):
        import gc
        import json
        import logging

        log = logging.getLogger("lumen-bonsai")
        try:
            import torch
            from accelerate import init_empty_weights
            from diffusers import Flux2Transformer2DModel
            from gemlite.core import DType, GemLiteLinearTriton, set_packing_bitwidth
        except Exception as exc:
            log.warning("chargeur économe indisponible (%s) : chargeur officiel", exc)
            return original(path, device=device)

        path = Path(path)
        try:
            cfg = json.loads((path / "config.json").read_text())
            qcfg = json.loads((path / "quantization_config.json").read_text())
            bits = int(qcfg.get("bits", 1))
            group_size = int(qcfg.get("group_size", 128))
            set_packing_bitwidth(int(qcfg.get("packing_bitwidth", 8)))
            GemLiteLinearTriton.load_config(str(path / "gemlite_autotune.json"))

            # Paramètres sur « meta » (rien d'alloué), tampons réels mais petits.
            with init_empty_weights(include_buffers=False):
                model = Flux2Transformer2DModel.from_config(cfg)
            state_path = str(path / "state_dict.pt")
            try:
                state = torch.load(state_path, map_location="cpu", mmap=True)
            except (TypeError, ValueError, RuntimeError) as exc:
                log.info("state_dict non projetable en mémoire (%s) : lecture classique", exc)
                state = torch.load(state_path, map_location="cpu")
            _, remainder = pipeline_gpu._load_gemlite_layers_from_state(
                model, state, bits=bits, group_size=group_size, device=device,
                DType=DType, GemLiteLinearTriton=GemLiteLinearTriton,
            )
            # assign=True rattache les tenseurs de l'archive aux paramètres
            # « meta » au lieu de les copier dans des poids déjà alloués.
            missing, unexpected = model.load_state_dict(remainder, strict=False, assign=True)
            if unexpected:
                raise RuntimeError(f"unexpected non-gemlite state_dict keys: {unexpected[:8]}")
            if missing:
                raise RuntimeError(f"missing non-gemlite state_dict keys: {missing[:8]}")
            left = [n for n, t in list(model.named_parameters()) + list(model.named_buffers()) if t.is_meta]
            if left:
                raise RuntimeError(f"tenseurs restés sur meta : {left[:8]}")
            del state, remainder
            gc.collect()
            model = model.to(torch.float16)
            pipeline_gpu._null_gemlite_weights(model, GemLiteLinearTriton)
            model = model.to(device).eval()
            model._inference_dtype = torch.float16
            gc.collect()
            return model
        except Exception as exc:
            log.warning("chargeur économe en échec (%s) : chargeur officiel", exc)
            gc.collect()
            return original(path, device=device)

    pipeline_gpu._load_gemlite_transformer = lean
    pipeline_gpu._lumen_lean_loader = True


def _install_error_detail(app) -> None:
    """Fait porter la cause d'un échec de génération par la réponse 500.

    FastAPI répond « Internal Server Error » sans autre détail à toute
    exception ; Lumen n'affichait donc que « 500 ». On renvoie le type et le
    message (CUDA à court de mémoire, noyau Triton…), et on relâche le cache
    CUDA pour que l'essai suivant reparte propre.
    """
    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:  # noqa: ARG001
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        detail = f"{type(exc).__name__}: {exc}".strip()
        print(f"[lumen-bonsai] génération en échec : {detail}", file=sys.stderr)
        return JSONResponse(status_code=500, content={"detail": detail[:2000]})


def build_app():
    if KIND == "mlx":
        _configure_mlx()
        from backend.server import app  # prism-image-studio
    else:
        _configure_gemlite()
        _patch_triton_autotune_generators()
        _patch_gemlite_param_assign()
        _patch_gemlite_lean_loader()
        from backend_gpu import server as gpu_server  # prism-image-studio-backend-gpu

        app = gpu_server.app
        # Démo mono-poste sur la boucle locale : la garde Bearer n'a pas de sens.
        verify = getattr(gpu_server, "_verify_bearer", None)
        if verify is not None:
            app.dependency_overrides[verify] = lambda: None
    _install_error_detail(app)

    # `/backends` officiel annonce aussi bfl-klein-bf16 (24 Go à télécharger au
    # premier clic) : on le remplace par une réponse limitée aux familles
    # Bonsai réellement présentes, comme le shim du dépôt de démo.
    app.router.routes = [r for r in app.router.routes if getattr(r, "path", "") not in ("/backends", "/health")]

    default_family = f"bonsai-{VARIANT}"
    if default_family not in FAMILIES:
        default_family = FAMILIES[0]

    @app.get("/backends")
    async def _backends(force_disable: bool = False) -> dict:  # noqa: ARG001
        return {
            "kind": KIND,
            "supported_families": FAMILIES,
            "default_family": default_family,
            "healthy": True,
            "reason": None,
            "lumen": True,
        }

    @app.get("/health")
    async def _health() -> dict:
        return {
            "ok": True,
            "kind": KIND,
            "variant": VARIANT,
            "families": FAMILIES,
            "model_dir": str(TERNARY_DIR if VARIANT == "ternary" else BINARY_DIR),
        }

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serveur Bonsai Image de Lumen")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LUMEN_BONSAI_PORT", "8800")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--probe", action="store_true", help="Vérifie les imports et sort sans servir.")
    args = parser.parse_args()

    import uvicorn  # fourni par prism-image-studio(-backend-gpu)

    app = build_app()
    if args.probe:
        print('{"ok": true, "kind": "%s"}' % KIND)
        return
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
