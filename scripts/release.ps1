<#
.SYNOPSIS
  Build the Windows release: release\MDViewer-<version>-Setup.exe and release\MDViewer-<version>-Portable.zip.

.DESCRIPTION
  Packages the app (npm run package), compiles install\mdview.iss with Inno Setup 6, and zips the
  packaged folder as "MD Viewer\" for the portable download. The version comes from package.json.
  ISCC.exe is looked up on PATH, then in the usual per-user and machine-wide Inno Setup 6 folders.

.EXAMPLE
  pwsh -File scripts\release.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) not found' }

Push-Location $root
try {
  npm run package
  if ($LASTEXITCODE) { throw "npm run package failed ($LASTEXITCODE)" }

  $out = Join-Path $root 'release'
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  & $iscc /Q "/DAppVersion=$version" (Join-Path $root 'install\mdview.iss')
  if ($LASTEXITCODE) { throw "ISCC failed ($LASTEXITCODE)" }

  # portable: the packaged folder under the name people see
  $stage = Join-Path $out 'portable'
  $named = Join-Path $stage 'MD Viewer'
  if (Test-Path -LiteralPath $stage) { [IO.Directory]::Delete($stage, $true) }
  New-Item -ItemType Directory -Force -Path $named | Out-Null
  Copy-Item -Path (Join-Path $root 'out\mdview-win32-x64\*') -Destination $named -Recurse
  $zip = Join-Path $out "MDViewer-$version-Portable.zip"
  if (Test-Path -LiteralPath $zip) { [IO.File]::Delete($zip) }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
  [IO.Directory]::Delete($stage, $true)

  Get-ChildItem $out -File | ForEach-Object { '{0}  {1:N1} MB  {2}' -f $_.Name, ($_.Length / 1MB), (Get-FileHash $_.FullName).Hash }
} finally {
  Pop-Location
}
