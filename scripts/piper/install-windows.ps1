# Installe la dernière release historique MIT de Piper sur Windows 10/11 x64.
# Le projet rhasspy/piper est archivé ; cette version reste volontairement
# figée à 2023.11.14-2 afin de conserver sa licence MIT.

param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Lumen\Piper")
)

$ErrorActionPreference = "Stop"
$Version = "2023.11.14-2"
$Archive = "piper_windows_amd64.zip"
$Url = "https://github.com/rhasspy/piper/releases/download/$Version/$Archive"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Piper MIT ne fournit pas de binaire Windows 32 bits. Windows x64 est requis."
}

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("lumen-piper-" + [Guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir $Archive
$UnpackDir = Join-Path $TempDir "unpacked"

try {
  New-Item -ItemType Directory -Force -Path $TempDir, $UnpackDir | Out-Null
  Write-Host "-> Telechargement de Piper MIT $Version (Windows x64)"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $ZipPath
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $UnpackDir -Force

  $SourceDir = Join-Path $UnpackDir "piper"
  $PiperExe = Join-Path $SourceDir "piper.exe"
  if (-not (Test-Path -LiteralPath $PiperExe -PathType Leaf)) {
    throw "Archive Piper invalide : piper.exe est absent."
  }

  if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallDir) | Out-Null
  Move-Item -LiteralPath $SourceDir -Destination $InstallDir

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Entries = @($UserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($Entries -notcontains $InstallDir) {
    $NewPath = (@($Entries) + $InstallDir) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  }
  if (($env:Path -split ';') -notcontains $InstallDir) {
    $env:Path = "$InstallDir;$env:Path"
  }

  Write-Host "OK Piper MIT $Version installe : $(Join-Path $InstallDir 'piper.exe')"
  Write-Host "   Redemarre Lumen pour qu'il voie le nouveau PATH."
}
finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
