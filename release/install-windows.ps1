# CFLS client installer for Windows PowerShell 5.1+.
#
# Keep this file beside cfls.exe downloaded from the CFLS release page, then:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 `
#     -Workspace C:\work\project -Name alice -Invite '<code>'
#
# The installer uses the deployed relay by default, installs only for the
# current Windows user, and creates a per-user Task Scheduler agent on success.

[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Name,
    [string]$Team = $(if ($env:CFLS_TEAM_ID) { $env:CFLS_TEAM_ID } else { "cyberkunju-cfls" }),
    [string]$Invite = $env:CFLS_INVITATION,
    [string]$Endpoint = $(if ($env:CFLS_ENDPOINT) { $env:CFLS_ENDPOINT } else { "wss://sync.cfls.cyberkunju.com" }),
    [string]$Binary = $env:CFLS_BINARY,
    [string]$InstallDir = $(if ($env:CFLS_INSTALL_DIR) { $env:CFLS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "CFLS\bin" }),
    [switch]$NoService
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    throw "CFLS installer: $Message"
}

function Note([string]$Message) {
    Write-Host "CFLS installer: $Message"
}

if (-not $Endpoint.StartsWith("wss://", [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "-Endpoint must use wss:// (got: $Endpoint)"
}

if ([string]::IsNullOrWhiteSpace($Binary)) {
    $Binary = Join-Path $PSScriptRoot "cfls.exe"
}
if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
    Fail "standalone executable not found: $Binary"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Destination = Join-Path $InstallDir "cfls.exe"
Copy-Item -LiteralPath $Binary -Destination $Destination -Force
Note "installed $Destination"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
    Note "binary installation complete. Open your project in VS Code, install the CFLS extension, then click the CFLS status item to pair this computer."
    exit 0
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    Fail "workspace is not a directory: $Workspace"
}
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path

$joinArgs = @("join", "--host", $Endpoint, "--team", $Team)
if (-not [string]::IsNullOrWhiteSpace($Name)) {
    $joinArgs += @("--name", $Name)
}
Push-Location -LiteralPath $Workspace
try {
    & $Destination @joinArgs
    if ($LASTEXITCODE -ne 0) { Fail "could not save relay configuration" }

    if (-not [string]::IsNullOrWhiteSpace($Invite)) {
        & $Destination connect $Invite
        if ($LASTEXITCODE -ne 0) { Fail "could not save invitation" }
    }
} finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($Invite)) {
    Note "relay configuration was saved. For the easy demo flow, open this folder in VS Code and use CFLS: Set Up This Workspace (Demo Pairing)."
    exit 0
}

if ($NoService) {
    Note "relay and invitation configured. Start manually with: $Destination agent"
    exit 0
}

$windowsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& $Destination service install --workspace $Workspace --windows-user $windowsUser
if ($LASTEXITCODE -ne 0) { Fail "could not install the background CFLS agent" }
& $Destination service status --workspace $Workspace
Note "ready: the CFLS agent starts automatically for $Workspace and connects to $Endpoint"
