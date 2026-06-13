/**
 * Checkpoint inspection + selection for trained LoRAs.
 *
 * A training run keeps every periodic checkpoint, but only one adapter is
 * registered into `data/loras/` as the usable LoRA. mflux always hands back
 * the FINAL step's adapter — which is exactly wrong when training diverges
 * late (a recurring FLUX.2 failure: the loss keeps dropping while the sample
 * image collapses to a near-black frame). Loss is therefore NOT a reliable
 * "best checkpoint" signal — it was anti-correlated with quality on the run
 * that motivated this module. So selection is two-pronged:
 *
 *   1. A cheap COLLAPSE GUARD at finalize that only vetoes the catastrophic
 *      case — a degenerate (near-black / near-uniform) final preview — and
 *      falls back to the latest non-degenerate checkpoint.
 *   2. A MANUAL promote path (`promoteCheckpoint`) so the human can pick any
 *      checkpoint by eye from its preview thumbnail — the real safety net for
 *      subtler degradation the guard intentionally leaves alone.
 *
 * Runtime-aware: mflux checkpoints are `*_checkpoint.zip` bundles (the
 * adapter is cracked out with lib/zipStream); the torch flux2 trainer writes
 * `checkpoints/step-NNNNNN/pytorch_lora_weights.safetensors` directories.
 */

import { readFile } from 'fs/promises';
import { existsSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import sharp from 'sharp';
import { PATHS } from '../../lib/fileUtils.js';
import { extractZipEntryToBuffer } from '../../lib/zipStream.js';
import { TRAINING_RUNTIMES } from './runtimes.js';

// Collapse thresholds — calibrated against a real divergence run: the
// black-frame final preview measured entropy 2.8 / max-channel-stdev 1.7,
// while every legitimate (even ugly) frame sat at entropy 5.5–7.1 / stdev
// 18–50. The wide gap means these vetoes never fire on a real image.
export const COLLAPSE_ENTROPY_MAX = 4.0;
export const COLLAPSE_STDEV_MAX = 6.0;

const runDirFor = (runId) => join(PATHS.trainingRuns, runId);
const samplesDirFor = (runId) => join(runDirFor(runId), 'samples');

/**
 * mflux appends `_YYYYMMDD_HHMMSS` to its output dir when the configured one
 * already exists (mirrors resolve_mflux_output in train_mflux_lora.py) — pick
 * the newest real directory among the base name and its timestamped siblings.
 */
function resolveMfluxOutputDir(runId) {
  const base = join(runDirFor(runId), 'mflux');
  const dir = runDirFor(runId);
  const candidates = [base];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('mflux_2') && statSync(join(dir, name)).isDirectory()) {
        candidates.push(join(dir, name));
      }
    }
  }
  const present = candidates.filter((p) => existsSync(p) && statSync(p).isDirectory());
  if (!present.length) return base;
  return present.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Parse the step a sample basename was rendered at (both runtime namings). */
function stepFromSampleName(name) {
  // mflux: 0000250_preview_image_preview_1.png ; flux2: step-000250.png
  const m = name.match(/^(\d+)_preview/) || name.match(/^step-(\d+)\.png$/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the boundary step a checkpoint artifact was saved at, from its
 * basename. The mflux watcher tags its CHECKPOINT line with the POLL-TIME
 * tqdm step, which can lag the actual save boundary by a few steps — so the
 * recorded `step` may not match the boundary the preview filename embeds.
 * Deriving the step from the filename (the same source `stepFromSampleName`
 * uses) keeps the checkpoint↔preview join exact. Returns null if unparseable.
 */
function stepFromCheckpointName(name) {
  // mflux: 0000250_checkpoint.zip ; flux2: step-000250
  const m = String(name).match(/^(\d+)_checkpoint/) || String(name).match(/^step-(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Canonical (filename-derived) step for a recorded checkpoint, with fallback. */
const checkpointStep = (c) => stepFromCheckpointName(c.path) ?? c.step;

/** Map step → sample basename from the run's recorded sample artifacts. */
function sampleByStep(run) {
  const map = new Map();
  for (const s of run.artifacts?.samples || []) {
    const step = stepFromSampleName(s);
    if (step != null) map.set(step, s);
  }
  return map;
}

const sampleUrl = (runId, name) =>
  name ? `/api/lora-training/runs/${runId}/samples/${name}` : null;

/**
 * Listable view of a run's checkpoints — step, loss (captured at checkpoint
 * time), preview thumbnail URL, and which one is currently deployed. Drives
 * the manual checkpoint picker in the run UI.
 */
export function listRunCheckpoints(run) {
  const samples = sampleByStep(run);
  const deployedStep = run.output?.selectedCheckpointStep ?? null;
  const checkpoints = (run.artifacts?.checkpoints || [])
    .map((c) => {
      const step = checkpointStep(c);
      const preview = samples.get(step) || null;
      return {
        step,
        loss: Number.isFinite(c.loss) ? c.loss : null,
        previewUrl: sampleUrl(run.id, preview),
        hasPreview: !!preview,
        deployed: deployedStep != null && step === deployedStep,
      };
    })
    .sort((a, b) => a.step - b.step);
  return checkpoints;
}

/**
 * Every mid-training sample the run has recorded so far, as `{ step, url }`
 * sorted by step. Unlike listRunCheckpoints this is keyed off the SAMPLE
 * artifacts alone (samples are written on their own cadence, often denser than
 * checkpoints) — it seeds the live progress gallery so a mid-run reload shows
 * the full sample timeline, not just frames that arrived after re-subscribe.
 */
export function listRunSamples(run) {
  return (run.artifacts?.samples || [])
    .map((name) => ({ step: stepFromSampleName(name), url: sampleUrl(run.id, name) }))
    .filter((s) => s.step != null)
    .sort((a, b) => a.step - b.step);
}

/**
 * Decide whether a preview image is a degenerate collapse (near-black /
 * near-uniform). Conservative by design — only the catastrophic case. A
 * missing/unreadable preview returns false (don't veto on analysis failure).
 */
export async function isPreviewCollapsed(previewPath) {
  if (!previewPath || !existsSync(previewPath)) return false;
  const stats = await sharp(previewPath).stats().catch(() => null);
  if (!stats?.channels?.length) return false;
  const rgb = stats.channels.slice(0, 3);
  const maxStdev = Math.max(...rgb.map((c) => c.stdev));
  const entropy = Number.isFinite(stats.entropy) ? stats.entropy : 0;
  return entropy < COLLAPSE_ENTROPY_MAX || maxStdev < COLLAPSE_STDEV_MAX;
}

// Step zero-pad widths mirror each trainer's own naming: mflux writes
// NNNNNNN_checkpoint.zip (7 digits); the flux2 diffusers wrapper writes
// step-NNNNNN/ (6 digits). Used only as a fallback when the run record
// didn't capture the artifact's basename.
const pad7 = (n) => String(n).padStart(7, '0');
const pad6 = (n) => String(n).padStart(6, '0');

/**
 * Resolve a checkpoint's adapter weights to a Buffer, runtime-aware:
 *   - mflux: crack `*_adapter.safetensors` out of the step's checkpoint zip.
 *   - flux2: read `checkpoints/step-NNNNNN/pytorch_lora_weights.safetensors`.
 * Throws a clear error if the checkpoint artifact is missing.
 */
export async function resolveCheckpointAdapterBuffer(run, step) {
  // Match on the canonical (filename-derived) step so a promote request from
  // listRunCheckpoints — which reports filename steps — finds the right
  // artifact even when the recorded poll-time `step` drifted.
  if (run.runtime === TRAINING_RUNTIMES.MFLUX) {
    const recorded = (run.artifacts?.checkpoints || []).find((c) => checkpointStep(c) === step);
    const zipName = recorded?.path || `${pad7(step)}_checkpoint.zip`;
    const zipPath = join(resolveMfluxOutputDir(run.id), 'checkpoints', basename(zipName));
    if (!existsSync(zipPath)) {
      throw new Error(`checkpoint zip missing for step ${step} (${zipPath})`);
    }
    const adapter = await extractZipEntryToBuffer(
      zipPath,
      (name) => name.endsWith('_adapter.safetensors') && !name.includes('optimizer'),
    );
    if (!adapter) throw new Error(`no adapter found inside checkpoint zip for step ${step}`);
    return adapter;
  }
  // flux2 torch runtime — diffusers save_lora_weights dir. Prefer the recorded
  // checkpoint basename (symmetric with the mflux path) so a trainer naming
  // change can't silently break resolution; fall back to the derived name.
  const recorded = (run.artifacts?.checkpoints || []).find((c) => checkpointStep(c) === step);
  const dirName = recorded?.path ? basename(recorded.path) : `step-${pad6(step)}`;
  const file = join(runDirFor(run.id), 'checkpoints', dirName, 'pytorch_lora_weights.safetensors');
  if (!existsSync(file)) {
    throw new Error(`checkpoint adapter missing for step ${step} (${file})`);
  }
  return readFile(file);
}

/**
 * Collapse guard for finalize: given the final adapter PortOS already
 * extracted and the run's checkpoints, deploy the final unless its preview is
 * a degenerate collapse — in which case walk back to the latest checkpoint
 * with a healthy preview. Returns the adapter Buffer to register plus the
 * selection metadata (which step, its preview, whether the guard overrode).
 *
 * `finalAdapterPath` is the wrapper-extracted adapter on disk (the final
 * step). `finalStep` is its step. Falls back silently to the final adapter
 * when there are no previews to judge (sampling disabled).
 */
export async function selectDeployableCheckpoint(run, finalAdapterPath, finalStep) {
  const samples = sampleByStep(run);
  const withPreview = listRunCheckpoints(run).filter((c) => c.hasPreview);
  // `finalStep` is the trainer's reported end step, which IS the deployed
  // adapter: for mflux it equals the final checkpoint's (filename-derived)
  // step, so the picker's deployed flag matches a listed checkpoint; for flux2
  // the final adapter is written separately AT finalStep (not as a checkpoint),
  // and flux2 renders a sample at that step, so the proxy below still finds it.
  // Health proxy: the final step's own preview, or — since mflux saves the
  // final checkpoint a few steps PAST the last sampled step — the most recent.
  const latest = withPreview.length ? withPreview[withPreview.length - 1] : null;
  const finalPreviewName = samples.get(finalStep) || (latest ? samples.get(latest.step) : null);

  const readFinal = async (reason = null) => ({
    buffer: await readFile(finalAdapterPath),
    step: finalStep,
    previewUrl: sampleUrl(run.id, finalPreviewName),
    autoSelected: false,
    reason,
  });

  // Nothing to judge (sampling disabled) → trust the trainer's final adapter.
  if (!finalPreviewName) return readFinal();

  const finalCollapsed = await isPreviewCollapsed(join(samplesDirFor(run.id), finalPreviewName));
  if (!finalCollapsed) return readFinal();

  // Final diverged. Walk earlier checkpoints newest→oldest for a healthy one.
  const earlier = withPreview
    .filter((c) => c.step < finalStep)
    .sort((a, b) => b.step - a.step);
  for (const cand of earlier) {
    const previewName = samples.get(cand.step);
    const collapsed = await isPreviewCollapsed(join(samplesDirFor(run.id), previewName));
    if (collapsed) continue;
    const buffer = await resolveCheckpointAdapterBuffer(run, cand.step).catch(() => null);
    if (!buffer) continue;
    return {
      buffer,
      step: cand.step,
      previewUrl: sampleUrl(run.id, previewName),
      autoSelected: true,
      reason: `final preview collapsed — auto-selected step ${cand.step}`,
    };
  }
  // Every preview collapsed (or no earlier adapter recoverable) — keep final
  // so the run still registers a (flawed) LoRA the user can inspect/replace.
  return readFinal(`all previews collapsed — kept final step ${finalStep}`);
}
