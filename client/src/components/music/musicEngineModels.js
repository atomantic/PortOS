/**
 * Pure music-engine model helpers shared by MusicGenPanel and its hooks: model
 * fallback resolution, readiness derivation, the setup banner state and the one
 * SSE install-stream driver.
 */

import toast from '../ui/Toast';
import { formatDownloadGb } from '../../utils/formatters';
import { installAudioModel } from '../../services/apiMusic.js';

// The effective model for an engine: the requested id, else the engine default,
// else its first model.
export function resolveEngineModel(engine, modelId) {
  return engine?.models?.find((item) => item.id === modelId)
    || engine?.models?.find((item) => item.id === engine.defaultModelId)
    || engine?.models?.[0]
    || null;
}

// A fixed-model engine is ready per model when the server reports per-id
// readiness, else by its single flag. Non-fixed engines have nothing to install.
export function isEngineModelReady(engine, modelId) {
  if (!engine?.fixedModelInstall) return true;
  return engine.modelReadyById
    ? engine.modelReadyById[modelId] === true
    : engine.modelReady === true;
}

/**
 * Drives one streamed model install. `onProgress` receives {message, progress?}.
 * Resolves true on success; false after toasting a failed or interrupted stream
 * (the terminal promise rejects both), so callers keep their retry state.
 */
export async function streamModelInstall({ engineId, repo, onProgress, isMounted }) {
  let ok = true;
  await installAudioModel({ engine: engineId, repo }, (ev) => {
    if (!isMounted()) return;
    if (ev.type === 'progress') onProgress({ message: `${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`, progress: ev.progress });
    else if (ev.type === 'stage') onProgress({ message: ev.stage });
  }).catch((err) => { ok = false; if (isMounted()) toast.error(err.message || 'Install failed'); });
  return ok;
}

/**
 * What an engine still needs, the sentence explaining it, and the label for the
 * one button that fixes it. Single derivation so the banner text and the button
 * can't disagree, and so the handlers branch on the same flags the UI shows
 * rather than re-deriving them.
 *
 * `label` is null when there's nothing to install — the engine is provisioned,
 * or it's CUDA-only on a host with no usable NVIDIA GPU, where an install button
 * would just be a slower way to fail.
 */
export function engineSetupState(engine, selectedModelReady = null, selectedModelSizeGb = null) {
  if (!engine) return null;
  const needsRuntime = engine.runtimeReady !== true;
  const needsWeights = engine.fixedModelInstall === true
    && (selectedModelReady === null ? engine.modelReady === false : selectedModelReady === false);
  // Older servers do not send a VRAM verdict. Preserve their CUDA-only
  // behavior during rolling upgrades; a new explicit verdict is authoritative.
  const vramBlocked = engine.cudaRequired === true
    && engine.vramState != null
    && engine.vramState !== 'sufficient';
  const blocked = engine.platformSupported === false
    || (engine.cudaRequired === true && engine.cudaState !== 'available')
    || vramBlocked;

  let message;
  if (engine.platformSupported === false) message = `${engine.name} requires ${engine.platformLabel || 'a different host'} and is unavailable on this machine.`;
  else if (engine.cudaRequired === true && engine.cudaState === 'unknown') message = `${engine.name} is disabled because CUDA availability could not be determined.`;
  else if (engine.cudaRequired === true && engine.cudaState !== 'available') message = `${engine.name} requires an NVIDIA CUDA GPU and is unavailable on this host.`;
  else if (engine.cudaRequired === true && engine.vramState === 'insufficient') message = `${engine.name} requires at least ${engine.minVramGb} GB of VRAM for the ${engine.vramProfileLabel || 'selected'} profile; this host reports ${engine.maxVramGb} GB.`;
  else if (engine.cudaRequired === true && engine.vramState === 'unknown-size') message = `${engine.name} cannot run because the GPU VRAM requirement has not been measured for the ${engine.vramProfileLabel || 'selected'} execution profile.`;
  else if (engine.runtimeReady === false && needsWeights) message = `${engine.name} needs its runtime and model weights before generation.`;
  else if (engine.runtimeReady === false) message = `${engine.name} needs its runtime before generation.`;
  else if (needsWeights) message = `${engine.name} ${engine.modelReadyById && selectedModelReady === false ? 'selected model weights' : 'model weights'} are not installed yet.`;
  else message = `${engine.name} is not installed yet. Install the runtime to enable generation.`;

  const size = formatDownloadGb(selectedModelSizeGb ?? engine.modelSizeGb);
  const suffix = size ? ` (${size})` : '';
  let label = null;
  if (!blocked && needsRuntime && needsWeights) label = `Install runtime + weights${suffix}`;
  else if (!blocked && needsRuntime) label = 'Install runtime';
  else if (!blocked && needsWeights) label = `Download model weights${suffix}`;

  return { needsRuntime, needsWeights, blocked, message, label };
}

export function supportsAutoDuration(engine) {
  // The server capability is authoritative: an older server may know the
  // MiniMax engine but will silently fall back to its fixed default when it
  // receives no lyric-aware duration implementation.
  return engine?.autoDuration === true;
}

export function formatExecutionProfile(profile) {
  if (profile === 'cuda-bf16-full') return 'CUDA BF16 (full GPU)';
  if (profile === 'cuda-bf16-component-offload') return 'CUDA BF16 (component offload)';
  return profile || '';
}

// The POST /music/generate payload. Local and remote renders differ only in how
// the engine/model/lyrics are chosen; the track-vs-standalone and duration
// rules are shared.
export function buildGenerateBody({
  prompt, lyrics, track, title, artistId, artist, albumId, generationEngine, engine, selectedModelId, isRemote,
  selectedRemotePeer, remoteProfile, remoteLyricsAvailable, effectiveInstrumentalOnly, usingAutoDuration, durationSec,
}) {
  const body = {
    prompt,
    engine: generationEngine.id || generationEngine.engine,
    modelId: isRemote ? generationEngine.modelId : selectedModelId,
    instrumentalOnly: effectiveInstrumentalOnly,
  };
  if (isRemote) {
    body.mediaProviderPeerId = selectedRemotePeer.id;
    body.remoteMusicProfile = remoteProfile;
    // Only when the resolved capability says the peer carries them. Sending
    // otherwise is the 400 `forcedInstrumental` exists to avoid.
    if (remoteLyricsAvailable) body.lyrics = lyrics || '';
  } else if (engine.lyrics) {
    // Keep authored lyrics available to the track record even when the server
    // deliberately excludes them from this render's engine conditioning.
    body.lyrics = lyrics || '';
  }
  if (track?.id) body.trackId = track.id;
  else {
    body.title = title.trim();
    body.artistId = artistId;
    body.artist = artist;
    body.albumId = albumId;
  }
  if (usingAutoDuration) body.durationMode = 'auto';
  else if (Number.isFinite(durationSec)) body.durationSec = durationSec;
  return body;
}
