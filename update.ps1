# Retain the legacy entrypoint used by installed servers and the supervisor.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:PORTOS_PEER_UPDATE_OPERATION_ID -and -not $env:PORTOS_DEFERRED_UPDATE_ID) {
    & node scripts/deferred-update.mjs @args
} else {
    & node scripts/update.mjs @args
}
exit $LASTEXITCODE
