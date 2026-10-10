<#
.SYNOPSIS
  Bootstrap claude-openrouter on a Windows machine that may have nothing installed.

.DESCRIPTION
  setup.js is a Node program, so it cannot install Node for you. This script can.
  It installs Node if it is missing or too old, repairs the current shell's PATH so
  the freshly installed Node is visible without reopening the terminal, downloads
  setup.js, and runs it.

  Run it with:

    $env:OPENROUTER_API_KEY="sk-or-v1-..."; irm https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.ps1 | iex

  Or, if you have the file locally, pass switches directly:

    .\install.ps1 -Key sk-or-v1-...  [-Status] [-Off] [-On] [-Doctor] [-Uninstall]

.NOTES
  Installer exit codes are not trusted anywhere in this script. winget in
  particular can report success and install nothing. Every step is verified by
  running the program and reading its output.
#>

[CmdletBinding()]
param(
  [string]$Key = $env:OPENROUTER_API_KEY,
  [switch]$Status,
  [switch]$Off,
  [switch]$On,
  [switch]$Uninstall,
  [switch]$Doctor,
  [switch]$NoVerify
)

# Piping through iex means no arguments can be passed, so the key comes from the
# environment in that case. Belt and braces: the param default covers the normal
# invocation, this covers everything else.
if (-not $Key -and $env:OPENROUTER_API_KEY) { $Key = $env:OPENROUTER_API_KEY }

$ErrorActionPreference = 'Stop'
$MinNode = 18
$RawBase = 'https://raw.githubusercontent.com/djerok/claude-openrouter/main'

function Write-Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok  ($m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    warn $m" -ForegroundColor Yellow }

# Piped into iex, this script runs inside the person's own PowerShell window, and
# `exit` there closes that window -- taking the error message with it, before
# anyone can read it. So it exits only when run as a file ($PSCommandPath is set
# then, and empty under iex); otherwise every caller returns right after Fail.
function Fail($m, $hint) {
  Write-Host ""
  Write-Host "fatal: $m" -ForegroundColor Red
  if ($hint) { Write-Host $hint -ForegroundColor DarkGray }
  $global:LASTEXITCODE = 1
  if ($PSCommandPath) { exit 1 }
}

# Installers write to the machine/user environment, not to this already-running
# process. Without this, "node" stays invisible until the terminal is reopened.
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# Truth comes from running the program, never from an installer's exit code.
function Get-NodeMajor {
  Sync-Path
  $exe = Get-Command node -ErrorAction SilentlyContinue
  if (-not $exe) { return 0 }
  try { $v = & node --version 2>$null } catch { return 0 }
  if ($v -match 'v(\d+)\.') { return [int]$Matches[1] }
  return 0
}

function Install-Node {
  Write-Step 'Installing Node.js'

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '    trying winget...' -ForegroundColor DarkGray
    try {
      winget install --id OpenJS.NodeJS.LTS --source winget `
        --accept-package-agreements --accept-source-agreements --silent | Out-Null
    } catch {
      Write-Warn "winget threw: $($_.Exception.Message)"
    }
    if ((Get-NodeMajor) -ge $MinNode) { return }
    Write-Warn 'winget did not produce a usable Node (it reports success even when it installs nothing)'
  }

  # Fall back to the official MSI, verified by size rather than by exit code.
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  # Problems here are warnings: the caller checks for a working Node afterwards
  # and stops there, with the instructions, if there is none.
  if (-not $lts) { Write-Warn 'Could not determine the current Node LTS version.'; return }

  $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$arch.msi"
  $msi = Join-Path $env:TEMP "node-$($lts.version)-$arch.msi"
  Write-Host "    downloading $url" -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing

  $size = (Get-Item $msi).Length
  if ($size -lt 5MB) {
    Write-Warn "The Node installer downloaded only $size bytes -- truncated, or replaced by a proxy."
    return
  }
  Write-Ok "downloaded $([math]::Round($size / 1MB, 1)) MB"

  # /passive, not /qn. Node's MSI installs for all users and needs elevation,
  # and a fully silent (/qn) install cannot show the UAC prompt, so on any
  # account that is not already elevated it failed without a word.
  Write-Host '    running the installer (a UAC prompt may appear)' -ForegroundColor DarkGray
  try {
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Wait
  } catch {
    Write-Warn "the Node installer did not run: $($_.Exception.Message)"
  }
  Remove-Item $msi -ErrorAction SilentlyContinue
}

# --- Node -------------------------------------------------------------------

Write-Step 'Checking Node.js'
$major = Get-NodeMajor

if ($major -ge $MinNode) {
  Write-Ok "node $(& node --version)"
} else {
  if ($major -gt 0) { Write-Warn "node $(& node --version) is older than v$MinNode -- upgrading" }
  else { Write-Warn 'node not found' }

  Install-Node
  $major = Get-NodeMajor

  if ($major -lt $MinNode) {
    Fail 'Node still is not usable after installing it.' @"
Two things usually cause this:
  1. The installer needs a new terminal. Close this window, open a new PowerShell, and run
     this script again -- it will skip straight past the install.
  2. The install genuinely failed. Download the LTS installer from https://nodejs.org,
     run it yourself, then re-run this script. Behind a proxy, download it by hand.
"@
    return
  }
  Write-Ok "node $(& node --version)"
}

# --- npm --------------------------------------------------------------------

Write-Step 'Checking npm'
Sync-Path
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'npm is missing even though Node is installed.' @"
npm ships with Node, so this usually means a partial install. Reinstall Node from
https://nodejs.org, making sure "npm package manager" stays checked, then re-run.
"@
  return
}
Write-Ok "npm $(& npm --version)"

# --- setup.js ---------------------------------------------------------------

Write-Step 'Downloading setup.js'
$setup = Join-Path $env:TEMP 'claude-openrouter-setup.js'
try {
  Invoke-WebRequest -Uri "$RawBase/setup.js" -OutFile $setup -UseBasicParsing
} catch {
  Fail "Could not download setup.js: $($_.Exception.Message)" 'Check your network or proxy, then re-run.'
  return
}

# A proxy or captive portal returning an HTML error page is a classic silent
# failure here, so check what actually arrived rather than the request's status.
$head = (Get-Content $setup -TotalCount 1 -ErrorAction SilentlyContinue)
if ((Get-Item $setup).Length -lt 5KB -or $head -notmatch 'node') {
  Fail 'What downloaded is not setup.js.' 'Something on your network replaced the file. Try a different connection, or clone the repository manually.'
  return
}
Write-Ok "$([math]::Round((Get-Item $setup).Length / 1KB)) KB"

# --- run --------------------------------------------------------------------

$fwd = @()
if ($Key)         { $fwd += @('--key', $Key) }
if ($Status)      { $fwd += '--status' }
if ($Off)         { $fwd += '--off' }
if ($On)          { $fwd += '--on' }
if ($Uninstall)   { $fwd += '--uninstall' }
if ($Doctor)      { $fwd += '--doctor' }
if ($NoVerify)    { $fwd += '--no-verify' }

if (-not $Key -and -not ($Status -or $Off -or $On -or $Uninstall -or $Doctor)) {
  Write-Warn 'No OpenRouter key given, so the one already installed here is used, if there is one.'
  Write-Host '    To use a new key: $env:OPENROUTER_API_KEY="sk-or-v1-..." before the install line' -ForegroundColor DarkGray
}

Write-Step 'Running setup'
Write-Host ''
& node $setup @fwd
# As a file, pass on setup.js's exit code. Under iex, $LASTEXITCODE already
# holds it, and exit would close the window this was pasted into.
if ($PSCommandPath) { exit $LASTEXITCODE }
