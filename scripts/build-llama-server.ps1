$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Version = if ($env:LLAMA_CPP_VERSION) { $env:LLAMA_CPP_VERSION } else { (Get-Content (Join-Path $Root "config\llama-cpp.version") -Raw).Trim() }
$Src = if ($env:LLAMA_CPP_SOURCE) { $env:LLAMA_CPP_SOURCE } else { Join-Path $Root ".localtarget\llama.cpp-$Version" }
$Out = Join-Path $Root "src-tauri\resources\llama-server\windows-x64"
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw "cmake est requis" }
if (-not (Test-Path (Join-Path $Src ".git"))) { New-Item -ItemType Directory -Force (Split-Path $Src) | Out-Null; git clone https://github.com/ggml-org/llama.cpp.git $Src }
git -C $Src fetch --tags --quiet origin $Version
git -C $Src checkout --quiet $Version

# macOS peut laisser des fichiers AppleDouble dans un clone copié depuis un
# volume HFS/APFS. Ils ne sont pas suivis par git et peuvent être vus comme
# des sources C/C++ par les GLOB CMake de llama.cpp.
function Remove-AppleDoubles([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-ChildItem -LiteralPath $Path -Force -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '._*' -or $_.Name -eq '.DS_Store' } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
Remove-AppleDoubles $Src

# Lumen embarque deux variantes : « cpu » fonctionne partout, « cuda » n'est
# utilisée qu'au démarrage si une carte NVIDIA répond (voir llama.rs).
# Le binaire CUDA est ignoré silencieusement sur une machine sans NVIDIA — il
# est donc sans danger de le livrer, mais il ne se construit qu'avec le CUDA
# Toolkit installé. LLAMA_CUDA=0 permet de sauter cette variante.
# cuBLAS n'est PAS fourni par le pilote NVIDIA : il vient du CUDA Toolkit, donc
# il est absent de la machine de tout utilisateur qui n'est pas developpeur.
# CMAKE_CUDA_RUNTIME_LIBRARY=Static ne couvre que cudart, pas cuBLAS, que
# llama.cpp lie dynamiquement. Sans ces DLL a cote du binaire, Windows refuse de
# demarrer le processus et affiche « cublas64_13.dll est introuvable ». On les
# embarque donc depuis le Toolkit de la machine de build.
# Verifie que le binaire livre trouvera toutes ses DLL sur une machine
# d'utilisateur — c'est-a-dire ailleurs que dans le PATH de cette machine-ci,
# ou le CUDA Toolkit et les outils Visual Studio ont tout mis a portee.
#
# Lumen sait desormais ecarter au demarrage une variante dont il manque une
# dependance (cf. `dependencies_resolvable`, llama.rs), mais ce repli est une
# securite, pas un objectif : une variante CUDA ecartee, c'est un utilisateur
# avec une carte NVIDIA qui tourne sur son processeur sans le savoir. Mieux vaut
# l'apprendre ici.
#
# Sans dumpbin (hors invite de commandes Visual Studio) la verification est
# simplement sautee : elle ne doit pas empecher de produire une build.
function Assert-Dependencies([string]$Exe) {
  if (-not (Test-Path $Exe)) { throw "binaire introuvable pour verification : $Exe" }
  if (-not (Get-Command dumpbin -ErrorAction SilentlyContinue)) {
    Write-Warning "dumpbin introuvable (hors invite Visual Studio) : dependances de $Exe non verifiees."
    return
  }
  $Dir = Split-Path $Exe
  $Deps = & dumpbin /DEPENDENTS $Exe 2>$null |
    ForEach-Object { if ($_ -match '^\s{4}(\S+\.dll)\s*$') { $Matches[1] } }
  $Missing = @()
  $Redist = @()
  foreach ($Dll in $Deps) {
    # Les « API sets » ne sont pas des fichiers : le loader les resout via son
    # schema interne, les chercher sur le disque donnerait un faux manque.
    if ($Dll -like "api-ms-*" -or $Dll -like "ext-ms-*") { continue }
    if (Test-Path (Join-Path $Dir $Dll)) { continue }
    # Le runtime Visual C++ est le piege de cette verification : il EST dans
    # System32 sur une machine de developpement (Visual Studio l'y installe),
    # donc « present sur le disque » ne prouve rien sur la machine d'arrivee.
    # Il n'est livre avec aucune version de Windows — seulement par le
    # Redistributable, qu'un utilisateur a souvent sans le savoir (jeux, Steam,
    # pilotes), mais pas toujours. On le traite donc comme absent quoi qu'il
    # arrive : c'est la seule facon de ne pas dependre du hasard.
    if ($Dll -like "vcruntime*" -or $Dll -like "msvcp*" -or $Dll -like "concrt*" -or $Dll -like "vccorlib*") {
      $Redist += $Dll
      continue
    }
    if (Test-Path (Join-Path $env:SystemRoot "System32\$Dll")) { continue }
    $Missing += $Dll
  }
  if ($Missing.Count) {
    throw "$Exe depend de DLL absentes du dossier livre et de System32 : $($Missing -join ', '). Elles doivent etre copiees a cote du binaire (cf. Copy-CublasRuntime), sinon Windows refusera de lancer le processus chez l'utilisateur."
  }
  if ($Redist.Count) {
    # AVERTISSEMENT, pas echec : contrairement a cuBLAS — absent de toute machine
    # sans Toolkit —, le runtime Visual C++ est present chez la plupart des
    # utilisateurs (jeux, Steam et pilotes l'installent). C'est un risque, pas une
    # certitude, et les builds precedentes fonctionnaient ainsi. Bloquer la
    # compilation pour ca punirait une situation qui marche.
    Write-Warning @"
$Exe depend du runtime Visual C++ : $($Redist -join ', ').
Ces DLL ne sont pas fournies par Windows. Elles sont presentes sur la plupart des
machines, mais pas toutes : sans elles, l'utilisateur verra la meme boite de
dialogue systeme que pour cuBLAS — et la variante CPU n'a aucun repli.
  - LLAMA_STATIC_CRT actif (defaut) devrait supprimer cette dependance ; si elle
    apparait quand meme, le lien statique n'a pas ete pris en compte.
  - Sinon, copier ces DLL a cote de llama-server.exe.
"@
  }
  Write-Host "dependances verifiees ($([IO.Path]::GetFileName($Dir))) : $($Deps.Count) DLL, toutes resolubles."
}

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
Windows refusera de lancer llama-server chez l'utilisateur.
  - Installe (ou reinstalle) le CUDA Toolkit, puis relance la build.
  - Ou lance la build avec LLAMA_CUDA=0 pour assumer une version CPU seule.
"@
  }
  Write-Host "cuBLAS embarque -> $($Copied -join ', ')"
}

function Build-Variant([string]$Name, [string[]]$ExtraArgs) {
  $Build = Join-Path $Src "build-lumen-windows-x64-$Name"
  Remove-AppleDoubles $Build
  # Runtime MSVC lie STATIQUEMENT (CMP0091 : le choix passe par
  # CMAKE_MSVC_RUNTIME_LIBRARY et non par des flags /MT a la main).
  #
  # Sans ca, llama-server.exe importe vcruntime140.dll et msvcp140.dll, qui
  # viennent du « Visual C++ Redistributable » : present sur une machine de
  # developpement, pas forcement chez un utilisateur. C'est exactement le meme
  # scenario que cublas64_13.dll, avec la meme boite de dialogue systeme au
  # lancement — et cette fois sur la variante CPU, celle qui n'a plus aucun
  # repli. Le binaire grossit de quelques centaines de kilo-octets ; c'est le
  # prix d'un executable qui demarre partout.
  $Crt = if ($env:LLAMA_STATIC_CRT -eq "0") { @() } else {
    @("-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded")
  }
  $Common = @(
    "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF",
    "-DLLAMA_BUILD_SERVER=ON", "-DLLAMA_BUILD_COMMON=ON", "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_UI=OFF", "-DLLAMA_OPENSSL=OFF"
  )
  cmake -S $Src -B $Build @Common @Crt @ExtraArgs
  if ($LASTEXITCODE -ne 0) {
    # Une configuration ratée laisse un cache CMake à moitié écrit (langage CUDA
    # marqué cassé, architectures mémorisées). Le relancer tel quel réechoue
    # même une fois la vraie cause corrigée : on repart proprement.
    Remove-Item -LiteralPath $Build -Recurse -Force -ErrorAction SilentlyContinue
    throw "configuration cmake ($Name) en échec"
  }
  cmake --build $Build --config Release --target llama-server
  if ($LASTEXITCODE -ne 0) { throw "compilation llama-server ($Name) en échec" }
  $Bin = Join-Path $Build "bin\Release\llama-server.exe"
  if (-not (Test-Path $Bin)) { $Bin = Join-Path $Build "bin\llama-server.exe" }
  if (-not (Test-Path $Bin)) { throw "llama-server.exe introuvable ($Name)" }
  $Dest = Join-Path $Out $Name
  New-Item -ItemType Directory -Force $Dest | Out-Null
  Copy-Item $Bin (Join-Path $Dest "llama-server.exe") -Force
  # Une build CUDA en DLL partagée traîne ses runtimes à côté de l'exécutable :
  # les copier évite un binaire qui refuse de démarrer chez l'utilisateur.
  Get-ChildItem -LiteralPath (Split-Path $Bin) -Filter *.dll -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force }
  if ($Name -eq "cuda") { Copy-CublasRuntime $Dest }
  Assert-Dependencies (Join-Path $Dest "llama-server.exe")
  Write-Host "llama-server ($Name) -> $Dest"
}

New-Item -ItemType Directory -Force $Out | Out-Null
Build-Variant "cpu" @()

$WantCuda = $env:LLAMA_CUDA -ne "0"
$HasNvcc = [bool](Get-Command nvcc -ErrorAction SilentlyContinue)
if ($WantCuda -and $HasNvcc) {
  # Architectures visees : de Pascal (61) a Blackwell (120), ce qui couvre
  # Ampere (86 : les RTX 30xx, dont la 3050). Elles ne peuvent PAS etre codees
  # en dur : chaque version majeure du Toolkit retire les plus anciennes (CUDA
  # 13 a supprime Pascal et Volta) et nvcc refuse alors de compiler quoi que ce
  # soit. On demande donc a nvcc ce qu'il sait produire et on garde
  # l'intersection ; a defaut de reponse exploitable, on laisse llama.cpp
  # choisir son defaut plutot que d'imposer une liste invalide.
  $Wanted = @(61, 70, 75, 80, 86, 89, 120)
  $Supported = @()
  try {
    $Supported = @(& nvcc --list-gpu-arch 2>$null |
      ForEach-Object { if ($_ -match 'compute_(\d+)') { [int]$Matches[1] } })
  } catch { $Supported = @() }
  $Archs = @($Wanted | Where-Object { $Supported -contains $_ })
  $CudaArgs = @("-DGGML_CUDA=ON")
  if ($Archs.Count -gt 0) {
    $CudaArgs += "-DCMAKE_CUDA_ARCHITECTURES=$($Archs -join ';')"
    Write-Host "CUDA : architectures compilees -> $($Archs -join ', ')"
  } else {
    Write-Warning "nvcc --list-gpu-arch illisible : architectures laissees au defaut de llama.cpp."
  }
  # Evite de dependre de cudart64_*.dll, absent des machines sans Toolkit
  # (c'est-a-dire celles de tous les utilisateurs).
  $CudaArgs += "-DCMAKE_CUDA_RUNTIME_LIBRARY=Static"
  Build-Variant "cuda" $CudaArgs
} elseif ($WantCuda) {
  # Echec franc, et non un avertissement noye dans des milliers de lignes de
  # compilation : une build sans variante CUDA produit un Lumen qui tourne sur
  # le processeur en silence, ce qui ne se remarque qu'a l'usage.
  throw @"
nvcc introuvable : la variante CUDA ne peut pas etre compilee.
Lumen tournerait alors sur le processeur meme avec une carte NVIDIA.
  - Installe le CUDA Toolkit NVIDIA, rouvre le terminal, puis relance la build.
  - Ou lance la build avec LLAMA_CUDA=0 pour assumer une version CPU seule.
"@
}

# Le binaire à plat reste écrit pour rester lisible par une version de Lumen
# antérieure au choix de backend (elle ne connaît pas les sous-dossiers).
Copy-Item (Join-Path $Out "cpu\llama-server.exe") (Join-Path $Out "llama-server.exe") -Force
Copy-Item (Join-Path $Src "LICENSE") (Join-Path $Out "llama.cpp-LICENSE.txt") -Force
Set-Content (Join-Path $Out "VERSION") $Version

# Recapitulatif finalpour que l'etat GPU de la build soit lisible sans relire le
# journal complet : c'est la seule ligne qui dise si Lumen saura utiliser une
# carte NVIDIA.
$Variants = @(Get-ChildItem -LiteralPath $Out -Directory | Select-Object -ExpandProperty Name)
Write-Host "llama-server $Version -> variantes : $($Variants -join ', ')"
