// Pure label formatting for the media lightbox details list. No React, no I/O:
// every function maps a normalized media item to the display strings the
// SettingsPane renders, and returns null when a row should be dropped.
import { isMiniMaxH3SpeedProfile } from '../../lib/videoGenParams.js';
import { i2vReferenceModeLabel } from '../../lib/videoReferenceModes';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import { formatDateTime, formatDurationMs, formatBytes } from '../../utils/formatters';
import { isLowResVideo } from '../../lib/videoResolution.js';

// Three lineage cases:
//   - auto-cleaned (replaced in place): "Auto-cleaned (aggressive)"
//   - manually cleaned (sidecar copy):  "Cleaned (aggressive) from <orig>"
//   - neither: returns null and the meta row is dropped by the null-filter
export function describeCleanedLineage(item) {
  if (item.autoCleaned) {
    return `Auto-cleaned (${item.cleanLevel || 'aggressive'})${item.c2paStripped ? ' · C2PA stripped' : ''}`;
  }
  // SynthID-defeat regen reuses `cleanedFrom` for grouping but is a generative
  // round-trip, not a clean — describe it honestly (issue #912).
  if (item.regenerated && item.cleanedFrom) {
    const denoise = typeof item.regenStrength === 'number' ? ` · ${Math.round(item.regenStrength * 100)}% denoise` : '';
    // Realized fidelity (how much the pixels actually changed) — stamped by the
    // server so the lineage row reflects the true delta, not just the request.
    const fidelity = typeof item.regenPixelDeltaPct === 'number' ? ` · ${item.regenPixelDeltaPct}% changed` : '';
    const method = item.regenMethod === 'light-spatial' ? ' (light)' : '';
    return `Regenerated${method} from ${item.cleanedFrom}${denoise}${fidelity}`;
  }
  // Visible-watermark removal (the Gemini ✦ corner inpaint) also reuses
  // `cleanedFrom` for grouping — describe it as its own lineage, not a clean.
  if (item.watermarkRemoved && item.cleanedFrom) {
    return `Watermark removed from ${item.cleanedFrom}`;
  }
  // A film-look bake (lib/filmLook.js) names the image it was rendered from.
  if (item.filmLookFrom) {
    const preset = item.filmLook?.preset;
    return `Film look${preset && preset !== 'custom' ? ` (${preset})` : ''} from ${item.filmLookFrom}`;
  }
  if (item.cleanedFrom) {
    return `${item.cleanLevel ? `Cleaned (${item.cleanLevel}) ` : 'Cleaned '}from ${item.cleanedFrom}`;
  }
  return null;
}

export function describeImageExecution(item) {
  const execution = item.executionProvenance || item.raw?.result?.executionProvenance;
  if (!execution) return item.kind === 'image' ? 'Unknown (legacy runner)' : null;
  if (execution.state === 'malformed') return 'Unknown (invalid runner marker)';
  if (execution.state === 'confirmed') return `Confirmed · ${execution.effectiveDevice}${execution.placement !== execution.effectiveDevice ? ` (${execution.placement})` : ''}`;
  if (execution.state === 'degraded') return `Degraded · CPU fallback${execution.requestedDevice !== 'cpu' ? ` (requested ${execution.requestedDevice})` : ''}`;
  return 'Unknown';
}

// Speed profile (#4875). The REQUESTED schedule, annotated with whatever the
// runner could not actually apply. Without this the degraded case exists only
// as a transient STATUS line during the render, so a user who wasn't watching
// would never learn their "faster" render ran without TeaCache or without the
// distilled adapter — which is precisely the misleading speed claim the
// feature is built to avoid. Absent on every Quality render.
export function formatSpeedProfileLabel(item) {
  const id = item.raw?.speedProfileId;
  if (!id) return null;
  const applied = item.raw?.speedProfileApplied;
  // No report at all: the request named a profile but the runner never said
  // what it managed to apply. Say exactly that rather than let a bare id read
  // as a clean full run — the whole point is that an unverified speed-up is
  // never presented as a verified one.
  if (!applied) return `${id} — outcome not reported`;
  if (isMiniMaxH3SpeedProfile(applied)) {
    return `${id} · ${applied.denoisingSteps} updates · shifts ${applied.videoShift}/${applied.audioShift} · ${applied.adapter?.file || 'adapter unknown'} · ${applied.applied === true && applied.fallback === false ? 'applied, no fallback' : 'outcome unverified'}`;
  }
  const degraded = applied.degraded;
  return Array.isArray(degraded) && degraded.length
    ? `${id} — reduced: ${degraded.join(', ')} unavailable`
    : id;
}

// Map raw `entryKind` tokens to user-facing labels — the sidecar stores
// 'canon' / 'variation' / 'sheet' (ENTRY_REF_KIND values) for parity with
// the server contract; users shouldn't see the wire tokens.
const ENTRY_KIND_LABELS = { canon: 'Canon entry', variation: 'Category variation', sheet: 'Composite sheet' };

function formatResolution(item, isVideo) {
  if (!(item.width && item.height)) return null;
  return `${item.width}×${item.height}${isVideo && isLowResVideo(item) ? ' · under 720p' : ''}`;
}

function formatUserLoraStagesRequested(raw) {
  const stages = raw?.a2vLoraStageStrengths;
  return stages ? `motion ×${stages[0]}, detail ×${stages[1]}` : null;
}

function formatUserLoraStagesApplied(raw) {
  return raw?.a2vLoraStageStrengths && raw?.loraStrategyApplied?.adapters
    ?.filter((adapter) => adapter.role === 'user')
    .map((adapter) => `${adapter.name}: ${adapter.stages.join(', ')} = ${adapter.strength}`).join('; ');
}

export function buildLightboxMeta(item, isVideo) {
  const isCodex = item.mode === IMAGE_GEN_MODE.CODEX;
  return [
    // Universe Builder context — placed first so "this is Ash from MyVerse"
    // reads before the technical render params. Sidecars without a universe
    // tag fall through the null-filter at the end.
    ['Universe', item.universeName],
    ['Entity', item.entryName],
    ['Kind', ENTRY_KIND_LABELS[item.entryKind] || item.entryKind],
    ['Category', item.entryCategory],
    ['Model', item.modelId],
    ['Resolution', formatResolution(item, isVideo)],
    ['Speed profile', formatSpeedProfileLabel(item)],
    ['Steps', item.steps],
    ['Guidance', item.guidance],
    ['CFG', item.raw?.cfgScale ?? item.raw?.cfg_scale],
    ['Quantize', item.quantize],
    // Codex doesn't expose a seed; show "n/a" rather than hiding the row so
    // it's clear why — and surface the codex session-id below as the closest
    // unique-run identifier.
    ['Seed', item.seed ?? (isCodex ? 'n/a (gpt-image-2)' : null)],
    ['Codex session', item.codexSessionId],
    ['Cleaned', describeCleanedLineage(item)],
    ['Look words', item.filmLookWords],
    ['Execution', describeImageExecution(item)],
    ['Frames', item.numFrames],
    ['FPS', item.fps],
    ['File size', item.fileSizeBytes != null ? formatBytes(item.fileSizeBytes) : null],
    // What the conditioning image promised (#4874). Recorded on the render only
    // when it wasn't the default, so this row appears exactly on the clips whose
    // opening frame was generated rather than reproduced — the one fact the
    // Image Strength number alone never told anyone.
    ['Reference', item.raw?.i2vReferenceMode ? i2vReferenceModeLabel(item.raw.i2vReferenceMode) : null],
    ['Image strength', item.raw?.imageStrength],
    ['User LoRA stages requested', formatUserLoraStagesRequested(item.raw)],
    ['User LoRA stages applied', formatUserLoraStagesApplied(item.raw)],
    ['Created', item.createdAt && formatDateTime(item.createdAt)],
    // Wall-clock the render itself took, excluding queue wait (see the renderMs
    // contract in normalize.js). Absent drops the row via the null-filter below.
    ['Render time', item.renderMs != null ? formatDurationMs(item.renderMs) : null],
  ].filter(([, v]) => v != null && v !== '');
}
