$ErrorActionPreference = "Stop"
# Construit whisper-server (whisper.cpp) pour Windows x64 : variante « cpu »
# toujours, « cuda » si le CUDA Toolkit est installe (Lumen la choisit au
# demarrage quand une carte NVIDIA repond, cf. src-tauri/src/whisper.rs).
#   WHISPER_CUDA=0         saute la variante CUDA
#   WHISPER_FORCE_BUILD=1  force la reconstruction
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Version = if ($env:WHISPER_CPP_VERSION) { $env:WHISPER_CPP_VERSION } else { (Get-Content (Join-Path $Root "config\whisper-cpp.version") -Raw).Trim() }
$Src = if ($env:WHISPER_CPP_SOURCE) { $env:WHISPER_CPP_SOURCE } else { Join-Path $Root ".localtarget\whisper.cpp-$Version" }
$Out = Join-Path $Root "src-tauri\resources\whisper-server\windows-x64"
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw "cmake est requis" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git est requis" }

$WantCuda = $env:WHISPER_CUDA -ne "0"
$HasNvcc = [bool](Get-Command nvcc -ErrorAction SilentlyContinue)
$StampKey = "$Version windows-x64 cuda=$([int]($WantCuda -and $HasNvcc))"
$Stamp = Join-Path $Out ".build-stamp"
if ($env:WHISPER_FORCE_BUILD -ne "1" -and (Test-Path (Join-Path $Out "cpu\whisper-server.exe")) -and (Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $StampKey)) {
  Write-Host "whisper-server $Version deja construit -> $Out (WHISPER_FORCE_BUILD=1 pour forcer)"
  exit 0
}

if (-not (Test-Path (Join-Path $Src ".git"))) { New-Item -ItemType Directory -Force (Split-Path $Src) | Out-Null; git clone https://github.com/ggml-org/whisper.cpp.git $Src }
git -C $Src fetch --tags --quiet origin $Version
git -C $Src checkout --quiet $Version

function Remove-AppleDoubles([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-ChildItem -LiteralPath $Path -Force -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '._*' -or $_.Name -eq '.DS_Store' } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
Remove-AppleDoubles $Src

function Copy-CublasRuntime([string]$Dest) {
  # Ou chercher les DLL du Toolkit.
  #
  # La disposition a CHANGE : jusqu'a CUDA 12 les bibliotheques d'execution
  # etaient dans %CUDA_PATH%\bin ; CUDA 13 les a deplacees dans
  # %CUDA_PATH%\bin\x64. Ne regarder que dans `bin`, c'est donc echouer sur les
  # installations recentes — precisement celles qui livrent cublas64_13.dll.
  # On essaie les dispositions connues, puis on balaie le Toolkit en dernier
  # recours plutot que de miser sur la prochaine reorganisation de NVIDIA.
  $Roots = @()
  if ($env:CUDA_PATH) { $Roots += $env:CUDA_PATH }
  $Nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
  if ($Nvcc) { $Roots += (Split-Path (Split-Path $Nvcc.Source)) }  # ...\bin\nvcc.exe -> racine
  $Roots = @($Roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)

  $Dirs = @()
  foreach ($Root in $Roots) {
    $Dirs += (Join-Path $Root "bin\x64")   # CUDA 13+
    $Dirs += (Join-Path $Root "bin")        # CUDA 12 et anterieurs
  }
  $Dirs = @($Dirs | Where-Object { Test-Path $_ } | Select-Object -Unique)

  $Patterns = @("cublas64_*.dll", "cublasLt64_*.dll")
  $Found = @()
  foreach ($Dir in $Dirs) {
    foreach ($Pattern in $Patterns) {
      $Found += @(Get-ChildItem -LiteralPath $Dir -Filter $Pattern -File -ErrorAction SilentlyContinue)
    }
  }
  # Dernier recours : balayage du Toolkit. Lent, mais il ne se declenche que si
  # les emplacements connus n'ont rien donne, et vaut mieux qu'un echec de build.
  if (-not $Found.Count) {
    foreach ($Root in $Roots) {
      foreach ($Pattern in $Patterns) {
        $Found += @(Get-ChildItem -LiteralPath $Root -Filter $Pattern -File -Recurse -ErrorAction SilentlyContinue)
      }
    }
  }

  $Copied = @()
  foreach ($File in $Found) {
    Copy-Item $File.FullName (Join-Path $Dest $File.Name) -Force
    $Copied += $File.Name
  }

  $HasCublas = @($Copied | Where-Object { $_ -like "cublas64_*" }).Count -gt 0
  $HasCublasLt = @($Copied | Where-Object { $_ -like "cublasLt64_*" }).Count -gt 0
  if (-not $HasCublas -or -not $HasCublasLt) {
    # Message actionnable : ou on a cherche, et les deux facons de debloquer.
    # Une build sans cuBLAS produirait une variante CUDA que Lumen ecarterait au
    # demarrage — un utilisateur avec carte NVIDIA tournerait sur son processeur
    # sans le savoir, ce qui est pire qu'un echec ici.
    $Looked = if ($Dirs.Count) { $Dirs -join "; " } else { "(aucun dossier candidat trouve)" }
    throw @"
cuBLAS introuvable dans le CUDA Toolkit.
  CUDA_PATH  : $($env:CUDA_PATH)
  Cherche    : cublas64_*.dll et cublasLt64_*.dll
  Dans       : $Looked
  Trouve     : $(if ($Copied.Count) { $Copied -join ', ' } else { 'rien' })
Ces DLL viennent du Toolkit, pas du pilote NVIDIA : sans elles a cote du binaire,
Windows refusera de lancer whisper-server chez l'utilisateur.
  - Installe (ou reinstalle) le CUDA Toolkit, puis relance la build.
  - Ou lance la build avec WHISPER_CUDA=0 pour assumer une version CPU seule.
"@
  }
  Write-Host "cuBLAS embarque -> $($Copied -join ', ')"
}

# Les DLL cuBLAS que la variante CUDA importera doivent exister chez
# llama-server, avec la MEME version majeure (cublas64_13 pour CUDA 13…).
function Assert-SharedCublas {
  $LlamaCuda = Join-Path $Root "src-tauri\resources\llama-server\windows-x64\cuda"
  $Have = @(Get-ChildItem -LiteralPath $LlamaCuda -Filter "cublas64_*.dll" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  $Major = ""
  try { if ((& nvcc --version 2>$null | Out-String) -match 'release (\d+)\.') { $Major = $Matches[1] } } catch {}
  if (-not $Have.Count) {
    Write-Warning "llama-server n'a pas de variante CUDA avec cuBLAS : whisper-server CUDA ne demarrera pas, Lumen utilisera la variante CPU. Construis llama-server (npm run build:llama) ou relance avec WHISPER_BUNDLE_CUBLAS=1."
  } elseif ($Major -and -not ($Have -contains "cublas64_$Major.dll")) {
    Write-Warning "CUDA $Major ici, mais llama-server embarque $($Have -join ', ') : reconstruis llama-server avec le meme Toolkit."
  } else {
    Write-Host "cuBLAS partage avec llama-server ($($Have -join ', '))"
  }
}

function Build-Variant([string]$Name, [string[]]$ExtraArgs) {
  $Build = Join-Path $Src "build-lumen-windows-x64-$Name"
  Remove-AppleDoubles $Build
  # Runtime MSVC statique : pas de dependance au « Visual C++ Redistributable ».
  $Common = @(
    "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF",
    "-DWHISPER_BUILD_SERVER=ON", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_SDL2=OFF", "-DWHISPER_CURL=OFF",
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
  )
  cmake -S $Src -B $Build @Common @ExtraArgs
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $Build -Recurse -Force -ErrorAction SilentlyContinue
    throw "configuration cmake ($Name) en echec"
  }
  cmake --build $Build --config Release --target whisper-server
  if ($LASTEXITCODE -ne 0) { throw "compilation whisper-server ($Name) en echec" }
  $Bin = Join-Path $Build "bin\Release\whisper-server.exe"
  if (-not (Test-Path $Bin)) { $Bin = Join-Path $Build "bin\whisper-server.exe" }
  if (-not (Test-Path $Bin)) { throw "whisper-server.exe introuvable ($Name)" }
  $Dest = Join-Path $Out $Name
  New-Item -ItemType Directory -Force $Dest | Out-Null
  Copy-Item $Bin (Join-Path $Dest "whisper-server.exe") -Force
  Get-ChildItem -LiteralPath (Split-Path $Bin) -Filter *.dll -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force }
  if ($Name -eq "cuda") {
    if ($env:WHISPER_BUNDLE_CUBLAS -eq "1") {
      # whisper-server autonome (hors Lumen) : DLL embarquees a cote.
      Copy-CublasRuntime $Dest
    } else {
      # Dans Lumen, les DLL cuBLAS (~500 Mo) ne sont livrees qu'une fois, a cote
      # de llama-server ; whisper.rs ajoute ce dossier au PATH au lancement.
      Get-ChildItem -LiteralPath $Dest -Filter "cublas*64_*.dll" -ErrorAction SilentlyContinue | Remove-Item -Force
      Assert-SharedCublas
    }
  }
  Write-Host "whisper-server ($Name) -> $Dest"
}

New-Item -ItemType Directory -Force $Out | Out-Null
Build-Variant "cpu" @()

if ($WantCuda -and $HasNvcc) {
  $Wanted = @(61, 70, 75, 80, 86, 89, 120)
  $Supported = @()
  try { $Supported = @(& nvcc --list-gpu-arch 2>$null | ForEach-Object { if ($_ -match 'compute_(\d+)') { [int]$Matches[1] } }) } catch { $Supported = @() }
  $Archs = @($Wanted | Where-Object { $Supported -contains $_ })
  $CudaArgs = @("-DGGML_CUDA=ON", "-DCMAKE_CUDA_RUNTIME_LIBRARY=Static")
  if ($Archs.Count -gt 0) { $CudaArgs += "-DCMAKE_CUDA_ARCHITECTURES=$($Archs -join ';')" }
  Build-Variant "cuda" $CudaArgs
} elseif ($WantCuda) {
  # Pas d'echec ici (contrairement a llama-server) : la dictee reste utilisable
  # sur le processeur, et whisper.cpp y est deja bien plus rapide que le WASM.
  Write-Warning "nvcc introuvable : whisper-server sans variante CUDA (processeur seulement)."
  Remove-Item -LiteralPath (Join-Path $Out "cuda") -Recurse -Force -ErrorAction SilentlyContinue
}

Copy-Item (Join-Path $Out "cpu\whisper-server.exe") (Join-Path $Out "whisper-server.exe") -Force
Copy-Item (Join-Path $Src "LICENSE") (Join-Path $Out "whisper.cpp-LICENSE.txt") -Force
Set-Content (Join-Path $Out "VERSION") $Version
Set-Content $Stamp $StampKey
$Variants = @(Get-ChildItem -LiteralPath $Out -Directory | Select-Object -ExpandProperty Name)
Write-Host "whisper-server $Version -> variantes : $($Variants -join ', ')"
