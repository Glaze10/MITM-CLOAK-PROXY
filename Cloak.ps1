<#
  Cloak - launcher.

  Starts the proxy engine and opens the window. First run sets up a virtual
  environment beside this script and installs the dependencies; after that it
  just starts.

    .\Cloak.ps1                  # window, proxy on 8080
    .\Cloak.ps1 -Port 8081       # a different proxy port
    .\Cloak.ps1 -NoWindow        # serve the UI only, open it yourself
    .\Cloak.ps1 -Shortcut        # put a shortcut on the Desktop and exit
#>
param(
  [int]$Port = 8080,
  [int]$UiPort = 8099,
  [ValidateSet('auto','mirror','static')][string]$Mode = 'auto',
  [string]$Preset = 'ios-safari-18',
  [switch]$NoWindow,
  [switch]$NoStart,
  [switch]$Shortcut,
  [string]$Venv                       # reuse an existing venv instead of making one
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── a Desktop shortcut, for when you'd rather click than type ────────────────
if ($Shortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cloak.lnk'
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($lnk)
  $s.TargetPath = 'powershell.exe'
  $s.Arguments  = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Root\Cloak.ps1`""
  $s.WorkingDirectory = $Root
  $s.IconLocation = "$env:SystemRoot\System32\netshell.dll,85"
  $s.Description = 'Cloak - intercepting proxy with a real browser TLS fingerprint'
  $s.Save()
  Write-Host "Shortcut: $lnk" -ForegroundColor Green
  return
}

# ── find or build the environment ────────────────────────────────────────────
if ($Venv) { $Py = Join-Path $Venv 'Scripts\python.exe' }
else {
  $local = Join-Path $Root '.venv\Scripts\python.exe'
  $shared = Join-Path $env:USERPROFILE 'mitmcloak-venv\Scripts\python.exe'
  if (Test-Path $local)       { $Py = $local }
  elseif (Test-Path $shared)  { $Py = $shared }   # the CLI tool's env, if it's there
  else {
    Write-Host '[cloak] first run - creating .venv and installing dependencies' -ForegroundColor Cyan
    python -m venv (Join-Path $Root '.venv')
    $Py = $local
    & $Py -m pip install --quiet --upgrade pip
    & $Py -m pip install --quiet -r (Join-Path $Root 'requirements.txt')
  }
}
if (-not (Test-Path $Py)) { throw "no python found at $Py" }

& $Py -c "import mitmproxy, mitmcloak, tornado" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host '[cloak] installing dependencies' -ForegroundColor Cyan
  & $Py -m pip install --quiet -r (Join-Path $Root 'requirements.txt')
}

$argv = @('-m', 'cloakproxy', '--port', $Port, '--ui-port', $UiPort, '--mode', $Mode, '--preset', $Preset)
if ($NoWindow) { $argv += '--no-window' }
if ($NoStart)  { $argv += '--no-start' }

Write-Host "[cloak] proxy :$Port  ui http://127.0.0.1:$UiPort  mode=$Mode  preset=$Preset" -ForegroundColor Cyan
Push-Location $Root
try { & $Py @argv } finally { Pop-Location }
