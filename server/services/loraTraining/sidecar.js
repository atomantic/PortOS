/**
 * Trained-LoRA sidecar builder — pure. Mirrors the Civitai sidecar shape
 * (`lib/civitai.js#buildSidecar`) so `listLoras()` surfaces a trained LoRA
 * with zero picker changes, plus a `source: 'trained'` marker, the
 * character identity block, and the training lineage.
 */

import { slugifyForFilename } from '../../lib/civitai.js';
import { RUNNER_FAMILIES } from '../../lib/runners.js';

/** `lora-trained-<slug>-<runId8>.safetensors` — runId suffix prevents collisions. */
export function trainedLoraFilename({ name, characterName, runId }) {
  const slug = slugifyForFilename(name || characterName || 'subject');
  return `lora-trained-${slug}-${String(runId).replace(/-/g, '').slice(0, 8)}.safetensors`;
}

export function buildTrainedSidecar({
  run,
  result = {},
  filename,
  previewImageUrl = null,
  sizeBytes = null,
  // The checkpoint actually deployed (collapse-guard or manual promote may
  // pick an earlier step than the final). null → the final step was used.
  selectedStep = null,
  autoSelected = false,
}) {
  const runtime = run.runtime;
  const params = run.params || {};
  const finalStep = Number.isInteger(result.steps) ? result.steps : null;
  // Note the checkpoint in the human description only when it differs from the
  // final step (i.e. the guard/promote actually moved it) — keeps the common
  // case clean.
  const ckptNote = selectedStep != null && selectedStep !== finalStep
    ? ` · checkpoint @ step ${selectedStep}${autoSelected ? ' (auto-selected; final diverged)' : ''}`
    : '';
  return {
    filename,
    name: run.name || `${run.character?.name || 'Subject'} (trained)`,
    description: `Trained in PortOS · ${params.steps ?? '?'} steps · rank ${params.rank ?? '?'}${ckptNote} · dataset ${run.datasetId}`,
    source: 'trained',
    character: run.character || null,
    datasetId: run.datasetId || null,
    runId: run.id,
    civitai: null,
    // Both runtimes (mflux MLX + torch diffusers) train FLUX.2 adapters
    // with diffusers-style key naming, so the family is always flux2 and
    // the size variant gates the compat key (flux2-4b / flux2-9b).
    runnerFamily: RUNNER_FAMILIES.FLUX2,
    fluxVariant: run.fluxVariant || null,
    triggerWords: run.triggerWord ? [run.triggerWord] : [],
    recommendedScale: 1.0,
    training: {
      baseModelId: run.baseModelId,
      runtime,
      steps: params.steps ?? null,
      rank: params.rank ?? null,
      learningRate: params.learningRate ?? null,
      resolution: params.resolution ?? null,
      seed: params.seed ?? null,
      finalLoss: Number.isFinite(result.final_loss) ? result.final_loss : null,
      trainedSteps: finalStep,
      // The checkpoint deployed as the LoRA — distinct from trainedSteps when
      // the collapse guard or a manual promote selected an earlier step.
      selectedCheckpointStep: selectedStep ?? finalStep,
      autoSelectedCheckpoint: !!autoSelected,
    },
    file: { sizeKB: Number.isFinite(sizeBytes) ? Math.round(sizeBytes / 1024) : null, hashes: {}, downloadUrl: null },
    previewImageUrl,
    installedAt: new Date().toISOString(),
  };
}
