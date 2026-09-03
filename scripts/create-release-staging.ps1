param(
  [string] $Destination = ".release-upload"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$target = if ([System.IO.Path]::IsPathRooted($Destination)) {
  $Destination
} else {
  Join-Path $root $Destination
}
$resolvedRoot = $root.Path
$resolvedTarget = [System.IO.Path]::GetFullPath($target)
$separator = [System.IO.Path]::DirectorySeparatorChar
$rootWithSep = $resolvedRoot.TrimEnd('\', '/') + $separator

if ($resolvedTarget.Length -lt $rootWithSep.Length) {
  throw "Destination must stay inside the project directory."
}

if (-not $resolvedTarget.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must stay inside the project directory."
}

function Get-TrackedReleaseFiles([string] $repositoryRoot) {
  $raw = & git -C $repositoryRoot ls-files -z
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read git tracked files for release packaging."
  }

  $allowedRoots = @(
    "docs",
    "logs",
    "scripts",
    "src",
    "website",
    "test"
  )

  $files = New-Object System.Collections.Generic.HashSet[string]
  $lines = $raw -split "`0"
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    $trimmed = $line.Trim()

    if ($trimmed.Contains('/')) {
      $rootSegment = $trimmed.Split('/')[0]
      if ($allowedRoots -notcontains $rootSegment) {
        continue
      }
    }

    $files.Add($trimmed) > $null
  }

  return $files
}

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null


$trackedFiles = Get-TrackedReleaseFiles -repositoryRoot $root

foreach ($file in $trackedFiles) {
  $sourcePath = Join-Path $root $file
  $destinationPath = Join-Path $target $file
  $destinationParent = Split-Path $destinationPath -Parent
  if ($destinationParent) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

New-Item -ItemType Directory -Path (Join-Path $target "logs") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src/data") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $target "logs/.gitkeep") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $target "data/.gitkeep") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $target "src/data/.gitkeep") -Force | Out-Null

Write-Host "Release staging created at $target"
