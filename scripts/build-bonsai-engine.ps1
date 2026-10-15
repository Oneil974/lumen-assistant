# Empaquette le moteur PrismML Bonsai Image pour Windows x64 (GPU NVIDIA :
# torch CUDA 12.8 + triton-windows + gemlite/HQQ + backend GPU d'image-studio)
# en runtime Python autonome dans src-tauri\resources\bonsai\windows-x64\,
# où src-tauri\src\bonsai.rs le cherche. Pendant de build-bonsai-engine.sh.
#
# Prérequis : uv (https://astral.sh/uv), git, pilote NVIDIA 566.07+ sur la
# machine cible. ~4 Go (le wheel torch+cu128 pèse 2,6 Go à lui seul).
#
# Variables : BONSAI_DEMO_DIR, BONSAI_PYTHON (3.11), BONSAI_TORCH_INDEX,
# BONSAI_SKIP_PROBE=1.
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Target = "windows-x64"
$Kind = "gemlite"
$FinalOut = Join-Path $Root "src-tauri\resources\bonsai\$Target"
$ServerSrc = Join-Path $Root "src-tauri\bonsai\lumen_bonsai_server.py"
$PyVer = if ($env:BONSAI_PYTHON) { $env:BONSAI_PYTHON } else { "3.11" }
$Demo = if ($env:BONSAI_DEMO_DIR) { $env:BONSAI_DEMO_DIR } else { Join-Path $Root ".localtarget\Bonsai-Image-Demo" }
$TorchIndex = if ($env:BONSAI_TORCH_INDEX) { $env:BONSAI_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu128" }
# Horodatée à la minute : deux builds le même jour doivent porter des noms
# distincts, sinon la publication croit l'archive « déjà en ligne » et l'app
# (bonsai.rs compare les versions par inégalité) ne voit pas la mise à jour.
# « T » trie après « - » : un 20260920T1716 l'emporte sur un 20260920.
$EngineVersion = (Get-Date -Format "yyyyMMddTHHmm") + "-gemlite"

if ([System.Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    Write-Host "build-bonsai-engine : triton-windows et torch cu128 sont x64 uniquement ; rien à faire."
    exit 0
}
foreach ($tool in @("uv", "git")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool est requis" }
}

function Clone-IfMissing($Url, $Dest) {
    if (-not (Test-Path (Join-Path $Dest ".git"))) {
        Write-Host "→ clone $Url"
        & git clone --quiet $Url $Dest
        if ($LASTEXITCODE -ne 0) { throw "git clone $Url a échoué" }
    }
}
New-Item -ItemType Directory -Force -Path (Split-Path $Demo) | Out-Null
Clone-IfMissing "https://github.com/PrismML-Eng/Bonsai-Image-Demo.git" $Demo
New-Item -ItemType Directory -Force -Path (Join-Path $Demo "vendor") | Out-Null
Clone-IfMissing "https://github.com/PrismML-Eng/image-studio.git" (Join-Path $Demo "vendor\image-studio")

# ── CPython autonome ──────────────────────────────────────────────────────
$Out = Join-Path $env:TEMP "lumen-bonsai-engine-stage\$Target"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Dist = Join-Path $Out ".python-dist"
Write-Host "→ Python $PyVer autonome (python-build-standalone)"
& uv python install $PyVer --install-dir $Dist
if ($LASTEXITCODE -ne 0) { throw "uv python install a échoué" }
# La disposition du dossier varie selon la version d'uv (python.exe à la
# racine de cpython-*, ou sous install\) : on cherche l'exécutable au lieu de
# supposer un chemin, et on aplatit pour finir sur python\python.exe.
$Exe = Get-ChildItem -Recurse -File -Filter "python.exe" $Dist |
    Where-Object { $_.FullName -notmatch "\\(Lib|Scripts|venv|site-packages)\\" } |
    Sort-Object { $_.FullName.Length } | Select-Object -First 1
if (-not $Exe) {
    Write-Host "Contenu de $Dist :"
    Get-ChildItem -Recurse -Depth 2 $Dist | ForEach-Object { Write-Host "  $($_.FullName)" }
    throw "Python autonome introuvable sous $Dist (python.exe absent)"
}
Move-Item $Exe.DirectoryName (Join-Path $Out "python")
Remove-Item -Recurse -Force $Dist
$Py = Join-Path $Out "python\python.exe"
if (-not (Test-Path $Py)) { throw "Interpréteur absent : $Py" }
Get-ChildItem -Recurse -Filter "EXTERNALLY-MANAGED" (Join-Path $Out "python") | Remove-Item -Force

# ── Paquets : même recette que setup.ps1 du dépôt de démo ─────────────────
Write-Host "→ torch CUDA 12.8"
# Couple torch/triton ÉPINGLÉ comme dans le setup.ps1 officiel : torch 2.11
# va avec triton 3.6. Surtout pas de triton-windows 3.8 : son autotuner fait
# `len(configs)` alors que gemlite 0.5.1 lui passe un GÉNÉRATEUR → la première
# génération meurt en « object of type 'generator' has no len() ».
& uv pip install --python $Py --no-progress --index-url $TorchIndex "torch==2.11.*"
if ($LASTEXITCODE -ne 0) { throw "installation de torch a échoué" }
Write-Host "→ triton-windows, gemlite, hqq, backend GPU"
& uv pip install --python $Py --no-progress "triton-windows>=3.6,<3.7"
if ($LASTEXITCODE -ne 0) { throw "installation de triton-windows a échoué" }
# --no-deps : gemlite/hqq exigent le « triton » Linux de PyPI, que triton-windows remplace.
# Épinglés sur le uv.lock du dépôt de démo : backend_gpu ne suit pas gemlite 0.6
# (cf. build-bonsai-engine.sh, GEMLITE_PIN).
& uv pip install --python $Py --no-progress --no-deps "gemlite==0.5.1.post1" "hqq==0.2.8.post1"
if ($LASTEXITCODE -ne 0) { throw "installation de gemlite/hqq a échoué" }
# Le --no-deps ci-dessus saute aussi les VRAIES dépendances de gemlite/hqq
# (tqdm, termcolor, einops, et surtout transformers/tokenizers : hqq.models.hf
# l'importe au chargement du text encoder). Sans elles le build passe mais le
# moteur meurt au préchauffage (« No module named 'transformers' »). Même
# liste que le setup.ps1 du dépôt de démo. Pas de --exclude-newer ici : le
# backend_gpu vendorisé exige diffusers>=0.38, dont safetensors>=0.8.0rc0,
# tous deux postérieurs au uv.lock ; seuls gemlite/hqq restent épinglés.
& uv pip install --python $Py --no-progress `
    (Join-Path $Demo "vendor\image-studio\backend_gpu") `
    tqdm termcolor einops transformers accelerate safetensors huggingface_hub hf-transfer
if ($LASTEXITCODE -ne 0) { throw "installation du backend GPU a échoué" }
# Toute la pile doit s'importer ensemble (uv peut désinstaller un paquet en
# résolvant le suivant) : même fumée que le setup.ps1 officiel.
& $Py -c "import torch, triton, gemlite, hqq, transformers, accelerate; import hqq.models.hf.base; from backend_gpu.pipeline_gpu import GpuPipeline; print('ok')"
if ($LASTEXITCODE -ne 0) { throw "la pile GPU ne s'importe pas entièrement (voir ci-dessus)" }

# ── Serveur de Lumen, lanceur, métadonnées ────────────────────────────────
Copy-Item $ServerSrc (Join-Path $Out "lumen_bonsai_server.py")
@"
@echo off
rem Lanceur de diagnostic : lumen-bonsai.cmd [--port 8800] (mêmes variables LUMEN_BONSAI_*)
set PYTHONNOUSERSITE=1
set PYTHONUNBUFFERED=1
set PYTHONPATH=
set PYTHONHOME=
"%~dp0python\python.exe" "%~dp0lumen_bonsai_server.py" %*
"@ | Set-Content -Encoding ASCII (Join-Path $Out "lumen-bonsai.cmd")
Set-Content -Path (Join-Path $Out "VERSION") -Value $EngineVersion
if (Test-Path (Join-Path $Demo "LICENSE.txt")) { Copy-Item (Join-Path $Demo "LICENSE.txt") (Join-Path $Out "Bonsai-Image-Demo-LICENSE.txt") }
Get-ChildItem -Recurse -Directory -Filter "__pycache__" (Join-Path $Out "python") | Remove-Item -Recurse -Force

# ── Sonde d'import ────────────────────────────────────────────────────────
if ($env:BONSAI_SKIP_PROBE -ne "1") {
    Write-Host "→ Sonde d'import"
    $env:LUMEN_BONSAI_KIND = $Kind
    $env:LUMEN_BONSAI_MODELS_DIR = $Out
    $env:PYTHONNOUSERSITE = "1"
    Push-Location $Out
    & $Py lumen_bonsai_server.py --probe
    $probe = $LASTEXITCODE
    Pop-Location
    if ($probe -ne 0) { throw "la sonde d'import a échoué" }
}

# ── Archive téléchargeable + manifeste (voir build-bonsai-engine.sh §8) ───
$Dist = Join-Path $Root "dist\bonsai-engine"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$Zip = Join-Path $Dist "lumen-bonsai-engine-$Target-$EngineVersion.zip"
if (Test-Path $Zip) { Remove-Item -Force $Zip }
Write-Host "→ Archive $(Split-Path -Leaf $Zip)"
# tar.exe (bsdtar, livré avec Windows 10+) plutôt que Compress-Archive :
# celui de PowerShell 5.1 échoue au-delà de 2 Go, et le runtime CUDA en fait
# 3 à 4. Même arborescence que le .sh : le dossier <cible> à la racine du zip.
& tar.exe -a -cf $Zip -C (Split-Path $Out) $Target
if ($LASTEXITCODE -ne 0) { throw "archivage tar.exe a échoué" }
& node (Join-Path $Root "scripts\bonsai-engine-manifest.mjs") $Target $Zip $EngineVersion
if ($LASTEXITCODE -ne 0) { throw "manifeste non mis à jour" }

# ── Copie de développement dans resources\ (jamais embarquée) ────────────
if ($env:BONSAI_DEV_COPY -ne "0") {
    Write-Host "→ Copie de développement vers $FinalOut"
    if (Test-Path $FinalOut) { Remove-Item -Recurse -Force $FinalOut }
    New-Item -ItemType Directory -Force -Path (Split-Path $FinalOut) | Out-Null
    Copy-Item -Recurse $Out $FinalOut
}
$size = (Get-Item $Zip).Length / 1MB
Write-Host ("OK moteur Bonsai {0:N0} Mo -> {1}" -f $size, $Zip)
