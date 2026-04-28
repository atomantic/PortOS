# Bootstrap local voice stack on Windows: whisper.cpp (STT) + active TTS backend.
# Safe to re-run: installs only what's missing, downloads only what's missing.
#
# Env overrides (same as setup-voice.sh):
#   STT_ENGINE      'whisper' (default) | 'web-speech'
#   MODEL_NAME      Whisper GGUF to fetch (default: ggml-base.en.bin)
#   VOICE_NAME      Piper voice name (default: en_GB-jenny_dioco-medium)
#   TTS_ENGINE      'kokoro' (default) | 'piper'
#   INSTALL_COREML  '1' — ignored on Windows (CoreML is Apple Silicon only)

$ErrorActionPreference = 'Stop'

$VOICE_HOME  = Join-Path $env:USERPROFILE '.portos\voice'
$MODELS_DIR  = Join-Path $VOICE_HOME 'models'
$VOICES_DIR  = Join-Path $VOICE_HOME 'voices'
$PIPER_DIR   = Join-Path $VOICE_HOME 'piper'

$MODEL_NAME  = if ($env:MODEL_NAME)  { $env:MODEL_NAME  } else { 'ggml-base.en.bin' }
$VOICE_NAME  = if ($env:VOICE_NAME)  { $env:VOICE_NAME  } else { 'en_GB-jenny_dioco-medium' }
$TTS_ENGINE  = if ($env:TTS_ENGINE)  { $env:TTS_ENGINE  } else { 'kokoro' }
$STT_ENGINE  = if ($env:STT_ENGINE)  { $env:STT_ENGINE  } else { 'whisper' }

New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $VOICES_DIR | Out-Null

function Have-Command($cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Download-File($url, $dest) {
    Write-Host "⬇️  $(Split-Path $dest -Leaf)"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
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
if ($TTS_ENGINE -eq 'piper') {
    $piperExe = Join-Path $PIPER_DIR 'piper.exe'
    if (-not (Test-Path $piperExe)) {
        $PIPER_VERSION = '2023.11.14-2'
        $arch = if ([System.Environment]::Is64BitOperatingSystem) { 'amd64' } else { 'x86' }
        $zipName = "piper_windows_${arch}.zip"
        $url = "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${zipName}"
        $tmp = Join-Path $env:TEMP $zipName
        Write-Host "⬇️  Piper TTS → $PIPER_DIR"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $PIPER_DIR | Out-Null
        Expand-Archive -Path $tmp -DestinationPath $VOICE_HOME -Force
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

# ── Whisper GGUF model ────────────────────────────────────────────────────────
if ($STT_ENGINE -eq 'whisper') {
    $modelPath = Join-Path $MODELS_DIR $MODEL_NAME
    if (-not (Test-Path $modelPath)) {
        $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
        Write-Host "⬇️  Whisper model → $modelPath"
        Invoke-WebRequest -Uri $url -OutFile $modelPath -UseBasicParsing
    }
}

# ── Piper voice (ONNX + JSON sidecar) ────────────────────────────────────────
if ($TTS_ENGINE -eq 'piper') {
    $onnxPath = Join-Path $VOICES_DIR "$VOICE_NAME.onnx"
    $jsonPath = Join-Path $VOICES_DIR "$VOICE_NAME.onnx.json"
    if (-not (Test-Path $onnxPath)) {
        # en_US-ryan-high  →  en / en_US / ryan / high
        $locale  = ($VOICE_NAME -split '-')[0]           # en_US
        $lang    = ($locale -split '_')[0]               # en
        $rest    = $VOICE_NAME.Substring($locale.Length + 1)  # ryan-high
        $parts   = $rest -split '-'
        $speaker = $parts[0]                             # ryan
        $quality = $parts[1]                             # high
        $base    = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$lang/$locale/$speaker/$quality"
        Write-Host "⬇️  Piper voice → $onnxPath"
        Invoke-WebRequest -Uri "$base/$VOICE_NAME.onnx"      -OutFile $onnxPath -UseBasicParsing
        Invoke-WebRequest -Uri "$base/$VOICE_NAME.onnx.json" -OutFile $jsonPath -UseBasicParsing
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
    Write-Host '   kokoro models:  managed by transformers.js (~/.cache/huggingface/)'
}
