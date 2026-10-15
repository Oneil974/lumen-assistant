# Assistant de prerequis pour "Lumen Windows".
#
# A executer dans PowerShell. Le script installe via winget quand disponible:
# - Microsoft Visual Studio 2022 Build Tools (toolchain MSVC)
# - Rustup
# - Node.js 20 LTS
#
# Exemple:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-prereqs-windows.ps1

$ErrorActionPreference = "Stop"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Error "winget est introuvable. Installe manuellement Visual Studio Build Tools, Rustup et Node.js 20 LTS, puis lance .\scripts\build-windows.ps1."
}

Write-Host "-> Installation/verification Visual Studio 2022 Build Tools"
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --accept-package-agreements --accept-source-agreements --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Write-Host "-> Installation/verification Rustup"
winget install --id Rustlang.Rustup --exact --source winget --accept-package-agreements --accept-source-agreements

Write-Host "-> Installation/verification Node.js 20 LTS"
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements

Write-Host ""
Write-Host "Prerequis termines. Ouvre un nouveau PowerShell puis lance:"
Write-Host "  .\scripts\build-windows.ps1"
