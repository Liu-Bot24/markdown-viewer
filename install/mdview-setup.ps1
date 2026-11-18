<#
.SYNOPSIS
  Per-user install, uninstall and shortcuts for MD Viewer (no administrator rights needed).

.DESCRIPTION
  Subcommands:
    install [source] [-AddToPath] [-Associate]
        Copy the packaged app (default: ..\out\mdview-win32-x64) to
        %LOCALAPPDATA%\Programs\mdview, register mdview.exe under App Paths,
        and create desktop and Start menu shortcuts.
        -AddToPath  add the install folder to the user PATH (so `mdview` works in any shell)
        -Associate  register MD Viewer for .md/.markdown in "Open with". Windows does not let
                    programs make themselves the default; pick it once under
                    Settings > Apps > Default apps, or "Open with > Always".
    uninstall
        Undo everything `install` did. Files go to the Recycle Bin.
    shortcut [exe]
        Only create a desktop shortcut (default target: the packaged app in ..\out).

.EXAMPLE
  pwsh -File install\mdview-setup.ps1 install -AddToPath
.EXAMPLE
  pwsh -File install\mdview-setup.ps1 uninstall
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('install', 'uninstall', 'shortcut')][string]$Command,
  [Parameter(Position = 1)][string]$Source,
  [switch]$AddToPath,
  [switch]$Associate
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\mdview'
$Exe = Join-Path $InstallDir 'mdview.exe'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MD Viewer.lnk'
$DesktopLink = Join-Path $Desktop 'MD Viewer.lnk'
$AppPathKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\mdview.exe'
$ProgId = 'mdview.md'
$Exts = @('.md', '.markdown')

function New-Shortcut([string]$Link, [string]$Target) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($Link)
  $s.TargetPath = $Target
  $s.WorkingDirectory = Split-Path -Parent $Target
  $s.IconLocation = "$Target,0"
  $s.Description = 'MD Viewer'
  $s.Save()
  Write-Host "shortcut: $Link -> $Target"
}

function Remove-ToRecycleBin([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Add-Type -AssemblyName Microsoft.VisualBasic
  $ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
  $bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  if (Test-Path -LiteralPath $Path -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Path, $ui, $bin)
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, $ui, $bin)
  }
  Write-Host "recycled: $Path"
}

function Get-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-UserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }

function Stop-Running {
  $running = Get-Process -Name mdview -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
  if ($running) { throw 'MD Viewer is running from the install folder; close it first.' }
}

switch ($Command) {
  'install' {
    if (-not $Source) { $Source = Join-Path $RepoRoot 'out\mdview-win32-x64' }
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'mdview.exe'))) { throw "mdview.exe not found in $Source (run: npm run package)" }
    Stop-Running
    if (Test-Path -LiteralPath $InstallDir) { Remove-ToRecycleBin $InstallDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $InstallDir -Recurse -Force
    Write-Host "installed: $InstallDir"

    New-Item -Path $AppPathKey -Force | Out-Null
    Set-ItemProperty -Path $AppPathKey -Name '(default)' -Value $Exe
    Set-ItemProperty -Path $AppPathKey -Name 'Path' -Value $InstallDir
    New-Shortcut $DesktopLink $Exe
    New-Shortcut $StartMenu $Exe

    if ($AddToPath) {
      $parts = @((Get-UserPath) -split ';' | Where-Object { $_ })
      if ($parts -notcontains $InstallDir) { Set-UserPath (($parts + $InstallDir) -join ';'); Write-Host "PATH: added $InstallDir (new shells only)" }
    }
    if ($Associate) {
      $cls = "HKCU:\Software\Classes\$ProgId"
      New-Item -Path "$cls\shell\open\command" -Force | Out-Null
      Set-ItemProperty -Path $cls -Name '(default)' -Value 'Markdown document'
      New-Item -Path "$cls\DefaultIcon" -Force | Out-Null
      Set-ItemProperty -Path "$cls\DefaultIcon" -Name '(default)' -Value "`"$Exe`",0"
      Set-ItemProperty -Path "$cls\shell\open\command" -Name '(default)' -Value "`"$Exe`" `"%1`""
      foreach ($e in $Exts) {
        New-Item -Path "HKCU:\Software\Classes\$e\OpenWithProgids" -Force | Out-Null
        New-ItemProperty -Path "HKCU:\Software\Classes\$e\OpenWithProgids" -Name $ProgId -Value '' -PropertyType String -Force | Out-Null
      }
      $app = 'HKCU:\Software\Classes\Applications\mdview.exe'
      New-Item -Path "$app\shell\open\command" -Force | Out-Null
      Set-ItemProperty -Path "$app\shell\open\command" -Name '(default)' -Value "`"$Exe`" `"%1`""
      New-Item -Path "$app\SupportedTypes" -Force | Out-Null
      foreach ($e in $Exts) { New-ItemProperty -Path "$app\SupportedTypes" -Name $e -Value '' -PropertyType String -Force | Out-Null }
      Write-Host 'association: MD Viewer is now offered for .md/.markdown; choose it as default in Settings > Apps > Default apps.'
    }
  }

  'uninstall' {
    Stop-Running
    foreach ($l in @($DesktopLink, $StartMenu)) { Remove-ToRecycleBin $l }
    if (Test-Path $AppPathKey) { Remove-Item -Path $AppPathKey -Recurse -Force }
    if (Test-Path "HKCU:\Software\Classes\$ProgId") { Remove-Item -Path "HKCU:\Software\Classes\$ProgId" -Recurse -Force }
    if (Test-Path 'HKCU:\Software\Classes\Applications\mdview.exe') { Remove-Item -Path 'HKCU:\Software\Classes\Applications\mdview.exe' -Recurse -Force }
    foreach ($e in $Exts) {
      $k = "HKCU:\Software\Classes\$e\OpenWithProgids"
      if (Test-Path $k) { Remove-ItemProperty -Path $k -Name $ProgId -ErrorAction SilentlyContinue }
    }
    $parts = @((Get-UserPath) -split ';' | Where-Object { $_ })
    if ($parts -contains $InstallDir) { Set-UserPath (($parts | Where-Object { $_ -ne $InstallDir }) -join ';'); Write-Host "PATH: removed $InstallDir" }
    Remove-ToRecycleBin $InstallDir
    Write-Host 'uninstalled (settings in %APPDATA%\MD Viewer are kept)'
  }

  'shortcut' {
    $target = if ($Source) { (Resolve-Path -LiteralPath $Source).Path } else { Join-Path $RepoRoot 'out\mdview-win32-x64\mdview.exe' }
    if (-not (Test-Path -LiteralPath $target)) { throw "not found: $target (run: npm run package)" }
    New-Shortcut $DesktopLink $target
  }
}
