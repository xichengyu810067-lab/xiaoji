param(
  [Parameter(Mandatory = $true)]
  [string] $HostName,

  [Parameter(Mandatory = $true)]
  [string] $User,

  [string] $RemoteDir = "~/xiaoji-discord-bot",

  [int] $Port = 22,

  [string] $IdentityFile = "",

  [switch] $UploadEnv,

  [switch] $InstallSystemPackages
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$releaseId = Get-Date -Format "yyyyMMddHHmmss"
$stagingDir = Join-Path $root ".release-upload"
$archivePath = Join-Path $root ".release-upload.zip"
$remote = "$User@$HostName"
$remoteArchive = "/tmp/xiaoji-release-$releaseId.zip"
$remoteReleaseDir = "$RemoteDir/releases/$releaseId"
$remoteSharedDir = "$RemoteDir/shared"
$remoteCurrentDir = "$RemoteDir/current"

function Quote-Bash {
  param([string] $Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Quote-BashPath {
  param([string] $Value)

  if ($Value -eq "~") {
    return '"$HOME"'
  }

  if ($Value.StartsWith("~/")) {
    $rest = $Value.Substring(2)
    if (!$rest) {
      return '"$HOME"'
    }
    return '"$HOME"/' + (Quote-Bash $rest)
  }

  return Quote-Bash $Value
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Program,

    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )

  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Program failed with exit code $LASTEXITCODE"
  }
}

function Get-SshArgs {
  $args = @("-p", "$Port")
  if ($IdentityFile) {
    $args += @("-i", $IdentityFile)
  }
  return $args
}

function Get-ScpArgs {
  $args = @("-P", "$Port")
  if ($IdentityFile) {
    $args += @("-i", $IdentityFile)
  }
  return $args
}

if ($UploadEnv -and !(Test-Path -LiteralPath (Join-Path $root ".env"))) {
  throw ".env does not exist locally, so it cannot be uploaded."
}

Invoke-Checked -Program "powershell.exe" -Arguments @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $root "scripts/create-release-staging.ps1")
)

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}

Compress-Archive -LiteralPath (Join-Path $stagingDir "*") -DestinationPath $archivePath -Force

if ($UploadEnv) {
  Invoke-Checked -Program "npm.cmd" -Arguments @("run", "prod:check")
}

$sshArgs = Get-SshArgs
$scpArgs = Get-ScpArgs

$installBlock = ""
if ($InstallSystemPackages) {
  $installBlock = @"
if ! command -v unzip >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y unzip curl git
fi

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi
"@
}

$prepareRemote = @"
set -euo pipefail
$installBlock
mkdir -p $(Quote-BashPath $remoteReleaseDir) $(Quote-BashPath $remoteSharedDir)
"@

Invoke-Checked -Program "ssh" -Arguments ($sshArgs + @($remote, $prepareRemote))
Invoke-Checked -Program "scp" -Arguments ($scpArgs + @($archivePath, "$remote`:$remoteArchive"))

if ($UploadEnv) {
  Invoke-Checked -Program "scp" -Arguments ($scpArgs + @((Join-Path $root ".env"), "$remote`:$remoteSharedDir/.env"))
}

$remoteDeploy = @"
set -euo pipefail
unzip -q -o $(Quote-BashPath $remoteArchive) -d $(Quote-BashPath $remoteReleaseDir)
rm -f $(Quote-BashPath $remoteArchive)

if [ ! -f $(Quote-BashPath "$remoteSharedDir/.env") ]; then
  echo ".env is missing on the VPS. Upload it once with -UploadEnv or create it at $remoteSharedDir/.env." >&2
  exit 1
fi

cp $(Quote-BashPath "$remoteSharedDir/.env") $(Quote-BashPath "$remoteReleaseDir/.env")
chmod 600 $(Quote-BashPath "$remoteSharedDir/.env") $(Quote-BashPath "$remoteReleaseDir/.env")

cd $(Quote-BashPath $remoteReleaseDir)
npm ci --omit=dev
npm run prod:check
npm run deploy

ln -sfn $(Quote-BashPath $remoteReleaseDir) $(Quote-BashPath $remoteCurrentDir)
pm2 startOrRestart $(Quote-BashPath "$remoteCurrentDir/ecosystem.config.cjs") --env production
pm2 save
pm2 status xiaoji-discord-bot
"@

Invoke-Checked -Program "ssh" -Arguments ($sshArgs + @($remote, $remoteDeploy))

Write-Host "VPS deployment completed. Secret values were not printed."
