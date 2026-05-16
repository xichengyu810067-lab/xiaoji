param(
  [string] $Destination = ".release-upload"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$target = Join-Path $root $Destination
$resolvedRoot = $root.Path
$resolvedTarget = [System.IO.Path]::GetFullPath($target)

if (!$resolvedTarget.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must stay inside the project directory."
}

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null

$directories = @(
  "docs",
  "logs",
  "scripts",
  "src",
  "test"
)

$rootFiles = @(
  ".env.example",
  ".gitignore",
  "deploy-commands.js",
  "ecosystem.config.cjs",
  "package-lock.json",
  "package.json",
  "README.md"
)

foreach ($file in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $target $file)
}

foreach ($directory in $directories) {
  Copy-Item -LiteralPath (Join-Path $root $directory) -Destination (Join-Path $target $directory) -Recurse
}

$privatePatterns = @(
  ".env",
  "node_modules",
  "logs/*",
  "src/data/*.json",
  ".release-upload",
  "*-player-script.js",
  "prompt.md"
)

Get-ChildItem -LiteralPath $target -Recurse -Force |
  Where-Object {
    $relative = $_.FullName.Substring($target.Length).TrimStart("\", "/").Replace("\", "/")
    foreach ($privatePattern in $privatePatterns) {
      if ($relative -like $privatePattern) {
        return $true
      }
    }
    return $false
  } |
  Sort-Object FullName -Descending |
  Remove-Item -Recurse -Force

New-Item -ItemType Directory -Path (Join-Path $target "logs") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src/data") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $target "logs/.gitkeep") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $target "src/data/.gitkeep") -Force | Out-Null

Write-Host "Release staging created at $target"
