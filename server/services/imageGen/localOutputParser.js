import { PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { extractGatedRepo, isGatedRepoError } from '../../lib/hfErrors.js';
import { FLUX2_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { parseByteProgress, formatDownloadMessage } from '../videoGen/generateVideoHelpers.js';

const IMAGE_EXECUTION_MARKER = 'IMAGE_EXECUTION:';
const IMAGE_EXECUTION_DEVICES = new Set(['auto', 'mps', 'cuda', 'cpu']);
const IMAGE_EXECUTION_EFFECTIVE_DEVICES = new Set(['mps', 'cuda', 'cpu']);
const IMAGE_EXECUTION_PLACEMENTS = new Set(['mps', 'cuda', 'cuda+offload', 'cpu']);
const IMAGE_EXECUTION_RUNTIMES = new Set(['flux2', 'diffusers-image']);
const IMAGE_EXECUTION_PACKAGES = new Set(['torch', 'diffusers', 'transformers', 'accelerate']);

const boundedString = (value, max = 80) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

// A malformed marker is evidence of neither GPU nor CPU execution. Keep it
// distinct from an older runner that emitted no marker at all, while refusing
// to persist arbitrary subprocess JSON into a gallery sidecar.
export function parseImageExecutionMarker(line) {
  if (typeof line !== 'string' || !line.startsWith(IMAGE_EXECUTION_MARKER)) return null;
  let value;
  try {
    value = JSON.parse(line.slice(IMAGE_EXECUTION_MARKER.length));
  } catch {
    return { state: 'malformed' };
  }
  if (!value || value.version !== 1
    || !IMAGE_EXECUTION_DEVICES.has(value.requestedDevice)
    || !IMAGE_EXECUTION_EFFECTIVE_DEVICES.has(value.effectiveDevice)
    || !IMAGE_EXECUTION_PLACEMENTS.has(value.placement)
    || !IMAGE_EXECUTION_RUNTIMES.has(value.runtime?.runtime)
    || typeof value.cpuFallback !== 'boolean') return { state: 'malformed' };
  const expectedState = value.effectiveDevice === 'cpu' ? 'degraded' : 'confirmed';
  if (value.state !== expectedState || value.cpuFallback !== (expectedState === 'degraded')) return { state: 'malformed' };
  const versions = Object.fromEntries(Object.entries(value.runtime.versions || {})
    .filter(([name, version]) => IMAGE_EXECUTION_PACKAGES.has(name) && boundedString(version))
    .map(([name, version]) => [name, version]));
  return {
    version: 1,
    state: expectedState,
    requestedDevice: value.requestedDevice,
    effectiveDevice: value.effectiveDevice,
    placement: value.placement,
    cpuFallback: value.cpuFallback,
    runtime: { runtime: value.runtime.runtime, versions },
  };
}

// Both streams share the phase. Only inference steps drive the lifecycle bus,
// since a download bar can count shards instead of image steps.
export function createLocalOutputParser({ onActivity, onExecution, onFrame, onInferenceProgress }) {
  let currentPhase = 'starting';
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed || PYTHON_NOISE_RE.test(trimmed)) return true;
    // Heartbeat — any non-noise line resets the queue's idle watchdog so
    // first-run multi-GB HF downloads don't trip the timeout when
    // tqdm is slow to update during connection-establishment.
    onActivity();

    const execution = parseImageExecutionMarker(trimmed);
    if (execution) {
      onExecution(execution);
      return true;
    }

    if (trimmed.startsWith('STAGE:')) {
      const rest = trimmed.slice(6); // strip 'STAGE:'
      const colon = rest.indexOf(':');
      const stage = colon === -1 ? rest : rest.slice(0, colon);
      const detail = colon === -1 ? '' : rest.slice(colon + 1);
      currentPhase = stage;
      onFrame({ type: 'stage', stage, detail });
      return true;
    }

    // DOWNLOAD: marker — parse byte values and emit formatted progress
    if (trimmed.startsWith('DOWNLOAD:')) {
      currentPhase = 'download';
      const rawText = trimmed.slice(9);
      const byteInfo = parseByteProgress(rawText);
      const message = formatDownloadMessage(rawText, byteInfo);
      const frame = { type: 'status', message, phase: currentPhase };
      if (byteInfo.downloaded != null) frame.downloadedBytes = byteInfo.downloaded;
      if (byteInfo.total != null) frame.totalBytes = byteInfo.total;
      onFrame(frame);
      return true;
    }

    const m = trimmed.match(/(\d+)%\|.*?(\d+)\/(\d+)/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      const step = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      // Check for byte sizes in tqdm bars during downloads
      const byteInfo = parseByteProgress(trimmed);
      let displayMessage = trimmed;
      const frame = { type: 'progress', progress: pct, phase: currentPhase };
      if (currentPhase.startsWith('download') && (byteInfo.downloaded != null || byteInfo.total != null)) {
        displayMessage = formatDownloadMessage(trimmed, byteInfo);
        if (byteInfo.downloaded != null) frame.downloadedBytes = byteInfo.downloaded;
        if (byteInfo.total != null) frame.totalBytes = byteInfo.total;
      }
      frame.message = displayMessage;
      onFrame(frame);
      // Only forward to imageGenEvents (which drives the UI step counter)
      // when we're actually in the inference phase — download tqdm bars
      // count safetensors files, not diffusion steps.
      if (currentPhase === 'inference') {
        onInferenceProgress({ progress: pct, step, totalSteps: total });
      }
      return true;
    }
    onFrame({ type: 'status', message: trimmed });
    return false;
  };
}

export function classifyLocalRenderFailure({ lines, usesTorchVenv }) {
  const structIdx = lines.findIndex((l) => l.startsWith('USER_ERROR:'));
  let userMessage = null;
  let userKind = null;
  let userRepo = null;
  if (structIdx >= 0) {
    // The first colon separates the kind from the rest of the payload.
    const [kind, ...rest] = lines[structIdx].slice('USER_ERROR:'.length).split(':');
    userKind = kind;
    userRepo = rest.join(':') || null;
    const proseIdx = lines.findIndex((l, i) => i > structIdx && l.startsWith('❌'));
    userMessage = proseIdx >= 0 ? lines[proseIdx].replace(/^❌\s*/, '') : null;
  }
  // Heuristic detection for non-USER_ERROR failures we can still
  // surface actionably. mflux's entry-point shim breaks when a partial
  // package upgrade leaves user-site at the right version number but
  // with stale file layout — Python imports the wrong `mflux/` first.
  // Easier to spot at the source than to teach the user to read pip diffs.
  if (!userMessage) {
    const mfluxBroken = lines.some((l) => /ModuleNotFoundError: No module named 'mflux\.models\.flux\.cli'/.test(l));
    if (mfluxBroken) {
      userKind = 'mflux_install_corrupted';
      userMessage = 'Your mflux install is corrupted (entry-point shim and package layout out of sync). Repair with: `pip uninstall -y mflux && pip install --user --force-reinstall --no-cache-dir --no-deps mflux`. If you use conda, run the same in your conda env\'s pip.';
    }
  }
  // The caller refreshes runtime health after a confirmed torch import failure.
  let invalidateTorchHealth = userKind === 'torch_runtime_broken';
  if (!userMessage && usesTorchVenv) {
    const importBroken = lines.some((l) => /^(ModuleNotFoundError|ImportError)\b/.test(l) || /cannot import name /.test(l));
    if (importBroken) {
      invalidateTorchHealth = true;
      userKind = 'torch_runtime_broken';
      userMessage = `The shared torch image runtime at ${FLUX2_VENV_DEFAULT} could not import its packages. Reinstall it from Media Gen Settings → Local, then retry this render.`;
    }
  }
  // Legacy mflux-generate is a pre-built binary, so it doesn't emit the
  // structured USER_ERROR markers the flux2/z-image Python runners use.
  // Match the raw huggingface_hub stack instead — `GatedRepoError` or the
  // "Cannot access gated repo for url …/<owner>/<name>/…" prose. Extract
  // the repo so the UI banner can link the user straight to the license
  // page (and we set kind=gated_repo so the client knows to surface the
  // token-entry form).
  if (!userMessage) {
    const gatedText = lines.join('\n');
    // Classify as gated ONLY on a gated-specific signal — extractGatedRepo
    // matches any huggingface.co/<owner>/<repo> URL, so a non-gated failure
    // (404, network error) that merely prints a HF URL must NOT be turned
    // into a misleading license-request flow. Extract the repo for the link
    // only after the gated signal is confirmed.
    const hasGatedError = isGatedRepoError(gatedText);
    if (hasGatedError) {
      userKind = 'gated_repo';
      userRepo = extractGatedRepo(gatedText);
      const repoText = userRepo || 'the model';
      userMessage = `Access to ${repoText} is gated. Accept the license at https://huggingface.co/${userRepo || '<repo>'} and paste your HuggingFace token into Image Gen settings, then retry.`;
    }
  }
  return { userMessage, userKind, userRepo, invalidateTorchHealth };
}
