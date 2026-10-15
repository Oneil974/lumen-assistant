"""PyTorch factice pour le runtime Bonsai/MLX de Lumen.

mflux déclare torch en dépendance mais, sur le chemin Bonsai (safetensors déjà
au format mflux), ne s'en sert que pour les modes « torch_checkpoint » /
« torch_convert », jamais empruntés. `weight_loader.py` fait pourtant
`import torch` et `from safetensors.torch import load_file` au niveau du
module. Ce paquet (installé par scripts/build-bonsai-engine.sh à la place des
400 Mo de PyTorch) satisfait ces imports et échoue EXPLICITEMENT si l'un de
ces chemins était pris. Sans dist-info : transformers le considère absent et
reste en mode « sans torch », ce qui est le comportement voulu.
"""

import sys
import types

__version__ = "0.0.0+lumen-stub"


def _missing(*_args, **_kwargs):
    raise RuntimeError(
        "Ce runtime Bonsai n'embarque pas PyTorch : chargement de poids .pt / conversion torch non disponible."
    )


class Tensor:  # noqa: D101
    pass


load = _missing
from_numpy = _missing
float16 = bfloat16 = float32 = float64 = None

# `safetensors.torch` importe le vrai torch au chargement : on le remplace par
# un module minimal, avant que mflux ne le demande.
_st = types.ModuleType("safetensors.torch")
_st.load_file = _missing
_st.save_file = _missing
sys.modules.setdefault("safetensors.torch", _st)
