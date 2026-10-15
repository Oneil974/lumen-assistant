# Build "Lumen Windows" - desktop Windows x64.
#
# A executer SUR Windows, dans PowerShell, sans mode administrateur.
# Le build Windows Tauri est le plus fiable en natif avec Visual Studio Build
# Tools + Rust MSVC. Les arguments passes au script sont transmis a `tauri build`.
#
# Exemples:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 --bundles nsis
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 --bundles msi

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Ne lance pas ce build en administrateur: cela peut creer des fichiers verrouilles dans node_modules/ et target/. Relance dans un PowerShell normal."
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Error "Rust/Cargo introuvable. Installe Rust depuis https://rustup.rs/ puis relance ce script."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js introuvable. Installe Node.js 20 LTS depuis https://nodejs.org/ puis relance ce script."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm introuvable. Verifie ton installation Node.js."
}

if (-not $env:CARGO_TARGET_DIR) {
  $env:CARGO_TARGET_DIR = Join-Path $Root "src-tauri\target"
}

Write-Host "-> Dependances frontend"
npm install

Write-Host "-> Build Tauri Windows"
npm run tauri build -- @args

Write-Host ""
Write-Host "Termine. Bundles dans src-tauri\target\release\bundle\ (NSIS/MSI selon configuration Tauri)."
