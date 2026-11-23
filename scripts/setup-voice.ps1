# Bootstrap local voice stack on Windows: whisper.cpp (STT) + active TTS backend.
# Safe to re-run: installs only what's missing, downloads only what's missing.
#
# Env overrides (same as setup-voice.sh):
#   STT_ENGINE      'whisper' (default) | 'web-speech'
#   MODEL_NAME      Whisper GGUF to fetch (default: ggml-base.en.bin)
#   VOICE_NAME      Piper voice name (default: en_GB-jenny_dioco-medium)
#   TTS_ENGINE      'piper' (default) | 'qwen3-tts'
#   INSTALL_COREML  '1' — ignored on Windows (CoreML is Apple Silicon only)
#
# Model downloads are staged to a unique temp sibling, validated, then promoted;
# a `<asset>.portos-complete.json` receipt (sizes + sha256, see
# server/lib/voiceModelAssets.js) is written only after the whole asset (for
# Piper: BOTH the .onnx and its .json) is in place. A file without a valid
# receipt is repaired on the next run — existence alone never counts.

$ErrorActionPreference = 'Stop'

$VOICE_HOME  = Join-Path $env:USERPROFILE '.portos\voice'
$MODELS_DIR  = Join-Path $VOICE_HOME 'models'
$VOICES_DIR  = Join-Path $VOICE_HOME 'voices'
$PIPER_DIR   = Join-Path $VOICE_HOME 'piper'

$MODEL_NAME  = if ($env:MODEL_NAME)  { $env:MODEL_NAME  } else { 'ggml-base.en.bin' }
$VOICE_NAME  = if ($env:VOICE_NAME)  { $env:VOICE_NAME  } else { 'en_GB-jenny_dioco-medium' }
$TTS_ENGINE  = if ($env:TTS_ENGINE)  { $env:TTS_ENGINE  } else { 'piper' }
$STT_ENGINE  = if ($env:STT_ENGINE)  { $env:STT_ENGINE  } else { 'whisper' }

New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $VOICES_DIR | Out-Null

function Have-Command($cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ── Completion contract (shared with setup-voice.sh via scripts/voice-asset.js) ─
# Staged files/dirs are unique temp siblings of the final path; the finally block at
# the install sections removes whatever a failed transfer left behind.
$script:StagedFiles = @()
$script:StagedDirs = @()

function Invoke-VoiceAsset {
    $out = & node (Join-Path $PSScriptRoot 'voice-asset.js') @args
    if ($LASTEXITCODE -ne 0) { throw "voice-asset $($args -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}

function Get-AssetState($kind, $path) {
    [string](Invoke-VoiceAsset state $kind $path | Select-Object -Last 1).Trim()
}

function Test-PiperConfig($path) {
    & node (Join-Path $PSScriptRoot 'voice-asset.js') check-config $path
    return ($LASTEXITCODE -eq 0)
}

function Get-VoiceAssetUrl($kind, $name) {
    [string](Invoke-VoiceAsset url $kind $name | Select-Object -Last 1).Trim()
}

function Verify-VoiceModel($assetName, $path) {
    & node (Join-Path $PSScriptRoot 'voice-asset.js') verify-model $assetName $path
    if ($LASTEXITCODE -ne 0) { throw "$assetName failed SHA-256 verification — refusing to promote" }
}

# Content-Length of a remote file, or $null when it cannot be determined.
function Get-RemoteSize($url) {
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing
        $len = $resp.Headers['Content-Length']
        if ($len -is [array]) { $len = $len[0] }
        if ($len) { return [int64]$len }
    } catch { }
    return $null
}

# Download into a fresh temp sibling of $final and return its path.
function Download-Staged($url, $final) {
    $tmp = "$final.part.$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $script:StagedFiles += $tmp
    Write-Host "⬇️  $(Split-Path $final -Leaf)"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -eq 0) {
        throw "Empty download from $url"
    }
    return $tmp
}

function Ensure-WhisperModel {
    $path = Join-Path $MODELS_DIR $MODEL_NAME
    $url = Get-VoiceAssetUrl 'whisper' $MODEL_NAME
    $state = Get-AssetState 'whisper' $path
    if ($state -eq 'verified') { return }
    if ($state -eq 'unverified') {
        # Installed before completion receipts (or user-supplied). A partial
        # transfer looks identical to a complete file, so compare against the
        # remote size: adopt a match, replace a mismatch, and leave the file
        # alone when the remote size cannot be read.
        $want = Get-RemoteSize $url
        $have = (Get-Item -LiteralPath $path).Length
        if ($null -eq $want) {
            Write-Host "⚠️  Cannot verify existing Whisper model (remote size unavailable) — leaving $path as is" -ForegroundColor Yellow
            return
        }
        if ($want -eq $have) {
            Invoke-VoiceAsset receipt whisper $path | Out-Null
            return
        }
        Write-Host "⚠️  Existing Whisper model is $have bytes, expected $want — re-downloading" -ForegroundColor Yellow
    }
    Write-Host "⬇️  Whisper model → $path"
    $tmp = Download-Staged $url $path
    Verify-VoiceModel $MODEL_NAME $tmp
    Move-Item -LiteralPath $tmp -Destination $path -Force
    Invoke-VoiceAsset receipt whisper $path | Out-Null
}

# Both halves are staged and validated before either is promoted, so a failed
# replacement leaves the previous (complete) pair untouched.
function Ensure-PiperVoice {
    $onnxPath = Join-Path $VOICES_DIR "$VOICE_NAME.onnx"
    $jsonPath = Join-Path $VOICES_DIR "$VOICE_NAME.onnx.json"
    $state = Get-AssetState 'piper' $onnxPath
    if ($state -eq 'verified') { return }
    if ($state -eq 'unverified') {
        # Pair predates receipts. The old script fetched the sidecar only after
        # the ONNX finished, so a parseable sidecar next to a non-empty ONNX is a
        # complete pair — adopt it without touching the network.
        Invoke-VoiceAsset receipt piper $onnxPath | Out-Null
        return
    }
    $base    = Get-VoiceAssetUrl 'piper' $VOICE_NAME
    Write-Host "⬇️  Piper voice → $onnxPath"
    $onnxTmp = Download-Staged "$base/$VOICE_NAME.onnx" $onnxPath
    Verify-VoiceModel "$VOICE_NAME.onnx" $onnxTmp
    $jsonTmp = Download-Staged "$base/$VOICE_NAME.onnx.json" $jsonPath
    if (-not (Test-PiperConfig $jsonTmp)) {
        throw "Downloaded Piper config for $VOICE_NAME is not a valid voice config"
    }
    Move-Item -LiteralPath $onnxTmp -Destination $onnxPath -Force
    Move-Item -LiteralPath $jsonTmp -Destination $jsonPath -Force
    Invoke-VoiceAsset receipt piper $onnxPath | Out-Null
}

# ── whisper-server ────────────────────────────────────────────────────────────
if ($STT_ENGINE -eq 'whisper') {
    $whisperExe = Join-Path $PIPER_DIR '..\whisper\whisper-server.exe'
    $whisperOnPath = Have-Command 'whisper-server'
    if (-not $whisperOnPath) {
        if (Have-Command 'winget') {
            Write-Host '📦 winget install ggerganov.whisper.cpp'
            winget install --id ggerganov.whisper.cpp --accept-source-agreements --accept-package-agreements
        } elseif (Have-Command 'scoop') {
            Write-Host '📦 scoop install whisper'
            scoop install whisper
        } else {
            Write-Host '❌ whisper-server not found and no package manager available.' -ForegroundColor Red
            Write-Host '   Install via:  winget install ggerganov.whisper.cpp' -ForegroundColor Yellow
            Write-Host '   Or:           scoop install whisper' -ForegroundColor Yellow
            Write-Host '   Or download:  https://github.com/ggerganov/whisper.cpp/releases' -ForegroundColor Yellow
            exit 1
        }
    }
} else {
    Write-Host "ℹ️  STT_ENGINE=$STT_ENGINE — skipping whisper-cpp install and model download"
}

# ── piper TTS binary ──────────────────────────────────────────────────────────
# The archive is downloaded to a unique temp file, its pinned sha256 is verified BEFORE
# extraction, and the tree is extracted into a staging dir; $PIPER_DIR is only replaced by an
# atomic rename once the staged tree is complete.
function Ensure-PiperBinary {
    $piperExe = Join-Path $PIPER_DIR 'piper.exe'
    if (Test-Path $piperExe) { return }
    $PIPER_VERSION = '2023.11.14-2'
    $arch = if ([System.Environment]::Is64BitOperatingSystem) { 'amd64' } else { 'x86' }
    $zipName = "piper_windows_${arch}.zip"
    $url = "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${zipName}"
    $nonce = [guid]::NewGuid().ToString('N').Substring(0, 8)
    # Expand-Archive insists on a .zip extension, so the unique part goes before it.
    $zip = Join-Path $VOICE_HOME ".piper-$nonce.zip"
    $stage = Join-Path $VOICE_HOME ".piper-stage-$nonce"
    $script:StagedFiles += $zip
    $script:StagedDirs += $stage
    Write-Host "⬇️  Piper TTS → $PIPER_DIR"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    & node (Join-Path $PSScriptRoot 'voice-asset.js') verify-archive $zipName $zip
    if ($LASTEXITCODE -ne 0) { throw "$zipName failed SHA-256 verification — refusing to extract" }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'piper\piper.exe'))) {
        throw "$zipName did not contain piper\piper.exe"
    }
    $old = $null
    if (Test-Path -LiteralPath $PIPER_DIR) {
        $old = "$PIPER_DIR.old.$nonce"
        Move-Item -LiteralPath $PIPER_DIR -Destination $old
        $script:StagedDirs += $old
    }
    try {
        Move-Item -LiteralPath (Join-Path $stage 'piper') -Destination $PIPER_DIR
    } catch {
        if ($old) { Move-Item -LiteralPath $old -Destination $PIPER_DIR }
        throw
    }
}

# ── Whisper GGUF model + Piper voice (ONNX + JSON sidecar) ────────────────────
try {
    if ($TTS_ENGINE -eq 'piper') { Ensure-PiperBinary }
    if ($STT_ENGINE -eq 'whisper') { Ensure-WhisperModel }
    if ($TTS_ENGINE -eq 'piper') { Ensure-PiperVoice }
} finally {
    foreach ($staged in $script:StagedFiles) {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    foreach ($staged in $script:StagedDirs) {
        Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host '✅ Voice stack ready'
if ($STT_ENGINE -eq 'whisper') {
    $wCmd = Get-Command 'whisper-server' -ErrorAction SilentlyContinue
    $w = if ($wCmd) { $wCmd.Source } else { '<not installed>' }
    Write-Host "   whisper-server: $w"
    Write-Host "   stt model:      $(Join-Path $MODELS_DIR $MODEL_NAME)"
} else {
    Write-Host "   stt engine:     $STT_ENGINE (browser-native, no server provisioning)"
}
Write-Host "   tts engine:     $TTS_ENGINE"
if ($TTS_ENGINE -eq 'piper') {
    Write-Host "   piper:          $(Join-Path $PIPER_DIR 'piper.exe')"
    Write-Host "   piper voice:    $(Join-Path $VOICES_DIR "$VOICE_NAME.onnx")"
} else {
    Write-Host '   Qwen3 models: managed in Settings → Voice'
}
