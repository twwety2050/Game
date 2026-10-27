# Keep a local copy of the game in sync with GitHub and serve it (Windows PowerShell).
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\play.ps1 [-Dir folder] [-Port 8000] [-Interval 30]
#   -Dir       where the game lives (default: the checkout this script is in, else ~\VoxelCraft);
#              cloned from GitHub first if it doesn't exist yet
#   -Port      web server port
#   -Interval  seconds between GitHub checks
# Or just double-click tools\play.bat.
param(
  [string]$Dir = '',
  [int]$Port = 8000,
  [int]$Interval = 30
)

$RepoUrl = 'https://github.com/twwety2050/Game.git'
$Branch = 'claude/minecraft-clone-3mer7c'
$ErrorActionPreference = 'Stop'

function Stamp { (Get-Date).ToString('HH:mm:ss') }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "Git isn't installed: https://git-scm.com/downloads"; exit 1
}
$py = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pyArgs = @('-3') }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = 'python' }
else { Write-Host "Python 3 isn't installed: https://www.python.org/downloads/"; exit 1 }

if (-not $Dir) {
  $here = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $here '.git')) { $Dir = $here } else { $Dir = Join-Path $HOME 'VoxelCraft' }
}

if (-not (Test-Path (Join-Path $Dir '.git'))) {
  Write-Host "Downloading the game into $Dir ..."
  git clone --branch $Branch $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
Set-Location $Dir
git checkout -q $Branch

$server = Start-Process -FilePath $py -ArgumentList ($pyArgs + @('tools/serve.py', '--port', $Port)) -NoNewWindow -PassThru
Start-Sleep -Seconds 1
if ($server.HasExited) { exit 1 }
Write-Host "Checking GitHub for updates every $Interval s."

try {
  while ($true) {
    git fetch -q origin $Branch 2>$null
    if ($LASTEXITCODE -eq 0) {
      $head = git rev-parse HEAD
      $remote = git rev-parse FETCH_HEAD
      if ($head -ne $remote) {
        git merge -q --ff-only FETCH_HEAD 2>$null
        if ($LASTEXITCODE -eq 0) {
          $msg = git log -1 --format='%h %s'
          Write-Host "[$(Stamp)] Updated to: $msg. Refresh your browser."
        } else {
          Write-Host "[$(Stamp)] An update is available but your local changes are in the way."
          Write-Host "    To throw your changes away and update: cd `"$Dir`"; git reset --hard FETCH_HEAD"
        }
      }
    } else {
      Write-Host "[$(Stamp)] Couldn't reach GitHub; will try again."
    }
    Start-Sleep -Seconds $Interval
    if ($server.HasExited) { Write-Host 'The web server stopped.'; exit 1 }
  }
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
}
