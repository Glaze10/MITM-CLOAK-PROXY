<#
  Cloak - launcher.

  Starts the proxy engine and opens the window. First run sets up a virtual
  environment beside this script and installs the dependencies; after that it
  just starts.

    .\Cloak.ps1                  # window, proxy on 8080, no console left behind
    .\Cloak.ps1 -Port 8081       # a different proxy port
    .\Cloak.ps1 -Console         # keep this terminal attached and print the log
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
  [switch]$Console,                   # stay attached: logs in this terminal
  [switch]$Shortcut,
  [string]$Venv                       # reuse an existing venv instead of making one
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── find or build the environment ────────────────────────────────────────────
function Resolve-Python {
  if ($Venv) { return (Join-Path $Venv 'Scripts\python.exe') }
  $local  = Join-Path $Root '.venv\Scripts\python.exe'
  $shared = Join-Path $env:USERPROFILE 'mitmcloak-venv\Scripts\python.exe'
  if (Test-Path $local)  { return $local }
  if (Test-Path $shared) { return $shared }      # the mitmcloak CLI's env, if present
  Write-Host '[cloak] first run - creating .venv and installing dependencies' -ForegroundColor Cyan
  python -m venv (Join-Path $Root '.venv')
  & $local -m pip install --quiet --upgrade pip
  & $local -m pip install --quiet -r (Join-Path $Root 'requirements.txt')
  return $local
}

$Py = Resolve-Python
if (-not (Test-Path $Py)) { throw "no python found at $Py" }
# pythonw.exe is the same interpreter without a console window attached
$Pyw = Join-Path (Split-Path -Parent $Py) 'pythonw.exe'
if (-not (Test-Path $Pyw)) { $Pyw = $Py }

# ── a Desktop shortcut: straight to pythonw, no shell in the middle ──────────
if ($Shortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cloak.lnk'
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($lnk)
  # pointing at pythonw rather than powershell is what keeps a console from
  # flashing up: a .ps1 needs a shell, and a shell needs a window
  $s.TargetPath = $Pyw
  $s.Arguments = "-m cloakproxy --port $Port --ui-port $UiPort --mode $Mode --preset $Preset"
  $s.WorkingDirectory = $Root
  $s.IconLocation = "$env:SystemRoot\System32\netshell.dll,85"
  $s.Description = 'Cloak - intercepting proxy with a real browser TLS fingerprint'
  $s.WindowStyle = 7                  # minimised, in case a console ever appears
  $s.Save()
  Write-Host "Shortcut: $lnk  ->  $Pyw -m cloakproxy" -ForegroundColor Green
  return
}

& $Py -c "import mitmproxy, mitmcloak, tornado" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host '[cloak] installing dependencies' -ForegroundColor Cyan
  & $Py -m pip install --quiet -r (Join-Path $Root 'requirements.txt')
}

$argv = @('-m', 'cloakproxy', '--port', $Port, '--ui-port', $UiPort, '--mode', $Mode, '--preset', $Preset)
if ($NoWindow) { $argv += '--no-window' }
if ($NoStart)  { $argv += '--no-start' }

Write-Host "[cloak] proxy :$Port  ui http://127.0.0.1:$UiPort  mode=$Mode  preset=$Preset" -ForegroundColor Cyan

if ($Console -or $NoWindow) {
  # attached: this terminal is the log
  Push-Location $Root
  try { & $Py @argv } finally { Pop-Location }
} else {
  # detached: hand it to pythonw and let this shell go
  Start-Process -FilePath $Pyw -ArgumentList $argv -WorkingDirectory $Root -WindowStyle Hidden
  Write-Host '[cloak] running in the background - close the Cloak window to stop it' -ForegroundColor DarkGray
}
