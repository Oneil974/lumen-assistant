# Prépare le PC pour Sync Hub : serveur OpenSSH + clé publique du Mac + PowerShell
# comme shell SSH. À lancer UNE FOIS dans PowerShell **en administrateur** :
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ssh-windows.ps1 -PubKey ..\mac-id_ed25519.pub
#
# -PubKey : fichier contenant la clé publique du Mac (déposé sur le partage par
#           le Mac : \Partage\mac-id_ed25519.pub). Sans lui, la clé est lue
#           dans le presse-papiers.
# Idempotent : relançable sans risque.
param([string]$PubKey = "")
$ErrorActionPreference = "Stop"
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Ouvre PowerShell en administrateur (clic droit -> Executer en tant qu'administrateur)."
}

# 1. Serveur OpenSSH (composant optionnel de Windows 10/11)
$cap = Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*"
if ($cap.State -ne "Installed") {
    Write-Host "-> Installation du serveur OpenSSH"
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
Set-Service sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# 2. PowerShell comme shell par défaut des sessions SSH (sinon cmd.exe)
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null

# 3. Clé publique du Mac
if ($PubKey -and (Test-Path $PubKey)) { $key = (Get-Content $PubKey -Raw).Trim() }
else { $key = (Get-Clipboard).Trim() }
if ($key -notmatch "^(ssh-ed25519|ssh-rsa|ecdsa-sha2) ") { throw "Cle publique introuvable : passe -PubKey <fichier> ou copie la ligne 'ssh-ed25519 ...' dans le presse-papiers." }

function Add-Key($file) {
    $dir = Split-Path $file
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not (Test-Path $file) -or -not ((Get-Content $file) -contains $key)) { Add-Content -Path $file -Value $key }
}
# Compte membre du groupe Administrateurs : sshd ignore ~\.ssh\authorized_keys
# et lit administrators_authorized_keys, qui doit n'etre modifiable que par
# SYSTEM et Administrateurs (sinon la cle est refusee en silence).
$admins = (Get-LocalGroupMember -Group "Administrators" -ErrorAction SilentlyContinue).Name
$isAdminUser = $admins -contains "$env:COMPUTERNAME\$env:USERNAME" -or $admins -contains $env:USERNAME
if ($isAdminUser) {
    $f = "$env:ProgramData\ssh\administrators_authorized_keys"
    Add-Key $f
    icacls $f /inheritance:r /grant "SYSTEM:F" /grant "BUILTIN\Administrators:F" | Out-Null
    Write-Host "-> Cle ajoutee dans $f (compte administrateur)"
} else {
    $f = "$env:USERPROFILE\.ssh\authorized_keys"
    Add-Key $f
    icacls $f /inheritance:r /grant "${env:USERNAME}:F" /grant "SYSTEM:F" | Out-Null
    Write-Host "-> Cle ajoutee dans $f"
}
Restart-Service sshd

# Adresse de la carte qui porte la route par defaut (pas une carte virtuelle
# Hyper-V/WSL/VirtualBox, qui sortait en premier avec Get-NetIPAddress).
$ifIndex = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1).InterfaceIndex
$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "<voir ipconfig>" }
Write-Host ""
Write-Host "OK. Depuis le Mac :  ssh $env:USERNAME@$ip"
Write-Host "Sync Hub -> Configurer la cible PC : Hote SSH = $env:USERNAME@$ip"
