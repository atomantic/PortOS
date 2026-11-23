/** Display-string helpers for MusicGenPanel (flattened from nested ternaries). */

export function engineOptionLabel(e) {
  let suffix = '';
  if (e.platformSupported === false) suffix = ' (unavailable on this host)';
  else if (e.cudaRequired && e.cudaState !== 'available') suffix = ' (CUDA unavailable)';
  else if (e.vramState === 'insufficient') suffix = ' (insufficient VRAM)';
  else if (e.vramState === 'unknown-size') suffix = ' (VRAM unknown)';
  else if (!e.ready) suffix = ' (setup required)';
  return `${e.name}${suffix}`;
}

export function instrumentalHint({ forcedInstrumental, generationEngine, effectiveInstrumentalOnly, hasLyrics, isRemote }) {
  if (forcedInstrumental) {
    return generationEngine?.lyrics
      ? 'This peer runs a PortOS build that cannot carry lyrics, so this render is instrumental. Your prompt and lyrics stay on this instance.'
      : 'The selected remote model is instrumental-only. Your prompt and lyrics stay on this instance.';
  }
  if (effectiveInstrumentalOnly) {
    return `An explicit no-vocals instruction will be added${hasLyrics ? '; saved lyrics will not condition this render' : ''}.`;
  }
  if (generationEngine?.lyrics && hasLyrics) {
    return isRemote
      ? 'The track’s lyrics will be sent to this peer as conditioning; your prompt stays on this instance.'
      : 'This engine will use the track’s lyrics as conditioning.';
  }
  return 'No lyric text will condition this render, but vocals may still follow the prompt unless instrumental mode is enabled.';
}

export function generateButtonTitle({ prompt, isRemote, remoteTarget, engine, selectedModelReady, track }) {
  if (!prompt?.trim()) return 'Add a generation prompt';
  if (isRemote && !remoteTarget.canSubmit) return remoteTarget.blockedReason || 'Wait for the remote peer to report ready capacity';
  if (!isRemote && !engine?.ready) return 'Complete engine setup first';
  if (!isRemote && !selectedModelReady) return 'Install the selected model first';
  return track?.id ? 'Generate audio' : 'Generate and create a standalone track';
}

export function renderStatusLabel(activeJob, generationEngine) {
  if (activeJob?.status === 'queued') return `Queued${activeJob.position ? ` · position ${activeJob.position}` : ''}`;
  return generationEngine?.cudaRequired ? 'Processing on the GPU' : 'Rendering audio';
}

export function renderHint(generationEngine) {
  if (generationEngine?.id === 'minimax-music3') return 'MiniMax Music 3 does not report an exact percentage yet; a 60-second track can take tens of minutes on a 24 GB GPU.';
  if (generationEngine?.id === 'minimax-music3-mlx') return 'MiniMax Music 3 MLX does not report an exact percentage yet; the first render includes model loading.';
  return 'Generation is still active. Longer requested durations take more time.';
}
