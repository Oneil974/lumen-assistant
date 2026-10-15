# Installation runtime "tout-en-un" de Lumen sur Windows 10/11 x64.
#
# Installe ce dont l'app a besoin pour fonctionner tout de suite :
#   - Ollama (moteur LLM local) + un modele par defaut ;
#   - optionnellement Piper MIT et deux voix neuronales locales.
# Les voix systeme Windows restent disponibles en complement. La dictee locale
# neuronale (whisper) n'est pas fournie sous Windows aujourd'hui.
#
# A executer dans PowerShell :
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
# Modele personnalise :
#   $env:LUMEN_MODEL="qwen2.5:3b"; powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
param([switch]$Yes)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Model = if ($env:LUMEN_MODEL) { $env:LUMEN_MODEL } else { "liquidai/lfm2.5-350m:latest" }

function Confirm-Step($prompt) {
  if ($Yes) { Write-Host "-> $prompt [oui]"; return $true }
  $a = Read-Host "$prompt [O/n]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $true }
  return ($a -match '^(o|oui|y|yes)$')
}

function Install-Ollama {
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "-> Ollama deja present"
    return
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Error "winget est introuvable. Installe Ollama manuellement : https://ollama.com/download/windows"
  }
  Write-Host "-> Installation d'Ollama via winget"
  winget install --id Ollama.Ollama --exact --source winget --accept-package-agreements --accept-source-agreements
  # Rendre `ollama` disponible dans la session courante (sinon nouveau terminal).
  $ollamaBin = Join-Path $env:LOCALAPPDATA "Programs\Ollama"
  if (Test-Path $ollamaBin) { $env:Path = "$ollamaBin;$env:Path" }
}

function Wait-Ollama {
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:11434/api/tags -TimeoutSec 2 | Out-Null; return $true }
    catch { Start-Sleep -Seconds 1 }
  }
  return $false
}

function Install-PiperVoice($Name, $ModelUrl, $ConfigUrl) {
  $VoiceDir = Join-Path $env:APPDATA "com.lumen.app\piper-voices"
  New-Item -ItemType Directory -Force -Path $VoiceDir | Out-Null
  Write-Host "-> Telechargement de la voix Piper $Name"
  Invoke-WebRequest -UseBasicParsing -Uri $ModelUrl -OutFile (Join-Path $VoiceDir "$Name.onnx")
  Invoke-WebRequest -UseBasicParsing -Uri $ConfigUrl -OutFile (Join-Path $VoiceDir "$Name.onnx.json")
}

function Install-PiperAndVoices {
  & (Join-Path $Root "scripts\piper\install-windows.ps1")
  Install-PiperVoice "fr_FR-siwis-medium" `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx" `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json"
  Install-PiperVoice "en_US-lessac-medium" `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
}

Write-Host "=== Lumen - installation runtime Windows ==="
Install-Ollama

if (Confirm-Step "Telecharger le modele Ollama `"$Model`" maintenant ?") {
  # Demarre le serveur Ollama en arriere-plan s'il ne tourne pas deja.
  if (-not (Wait-Ollama)) {
    Write-Host "-> Demarrage du service Ollama"
    Start-Process -WindowStyle Hidden -FilePath "ollama" -ArgumentList "serve" -ErrorAction SilentlyContinue
    Wait-Ollama | Out-Null
  }
  Write-Host "-> ollama pull $Model"
  ollama pull $Model
}

if (Confirm-Step "Installer Piper MIT (+ voix FR et EN par defaut) ?") {
  Install-PiperAndVoices
}

Write-Host ""
Write-Host "OK Termine."
Write-Host "   - Modele local : $Model (modifiable dans Reglages -> IA)."
Write-Host "   - Voix : Piper local si installe, avec les voix systeme Windows en complement."
Write-Host "   - Cloud optionnel : ajoute une cle API dans Reglages -> IA."
