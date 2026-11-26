import { existsSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { videoLoraLayoutIssue } from '../../../lib/safetensors.js';
import { formatLoraEffect, loraEffectIssue } from '../../../lib/loraEffect.js';
import { assertSafeLoraFilename, getLoraKeyLayout } from '../../loras.js';
import { LORA_EFFECT_PROBE_BUDGET_MS, probeLoraEffect } from '../../loraEffectProbe.js';
import { icLoraSpecForMode, assertIcReferenceCount, icResolutionIssue } from '../../../lib/icLoraWeights.js';

// Resolve picker `{ filename, scale }` LoRA entries into absolute
// `{ path, strength }` pairs the ltx2 helper fuses via the pipeline's
// `_pending_loras` hook (see scripts/ml/generate_ltx2.py). Validates each
// basename can't escape PATHS.loras (assertSafeLoraFilename) and that the file
// exists — a typo or a deleted LoRA would otherwise surface as an opaque
// Python FileNotFoundError deep inside the render. Returns [] for no LoRAs.
// The ltx2 and MiniMax H3 MLX runtimes consume the result; buildArgs rejects
// LoRAs on the other runtimes before this is even reached for a doomed job.
//
// Also gates on the safetensors KEY LAYOUT. The loader fuses `lora_A`/`lora_B`
// pairs after stripping a leading `diffusion_model.`. The MiniMax H3 adapter
// also normalizes kohya (lora_down/lora_up) and Diffusers/PEFT-prefixed files,
// so only the LTX loader keeps the older layout restriction. Refuse an
// unsupported LTX layout up front with the layout named.
export const resolveVideoLoras = async (loras, { probeEffect = false, runtime = null } = {}) => {
  if (!Array.isArray(loras) || loras.length === 0) return [];
  const out = [];
  // ONE budget for every selected adapter, not one each. This runs before
  // generateVideo mints a job id, so anything spent here is silence in the UI —
  // a 4-LoRA render must not be able to stall for four full probe budgets.
  const effectDeadline = probeEffect ? Date.now() + LORA_EFFECT_PROBE_BUDGET_MS : null;
  for (const l of loras) {
    assertSafeLoraFilename(l?.filename);
    const path = join(PATHS.loras, l.filename);
    if (!existsSync(path)) {
      throw new ServerError(`LoRA not found: ${l.filename}`, { status: 400, code: 'LORA_NOT_FOUND' });
    }
    const layout = await getLoraKeyLayout(l.filename);
    const issue = ['minimax_h3', 'minimax_h3_cuda'].includes(runtime) && layout !== 'not_a_lora'
      ? null
      : videoLoraLayoutIssue(layout);
    if (issue) {
      throw new ServerError(
        `LoRA "${l.filename}" can't be used for video: ${issue}.`,
        { status: 400, code: 'LORA_LAYOUT_UNSUPPORTED' },
      );
    }
    if (layout == null) {
      console.log(`⚠️ LoRA key layout undetermined for ${l.filename} — fusing anyway`);
    }
    // Adapter-effect gate (#4872). Opt-in — a passive library read must never
    // spawn a probe — and the render path opts in, because this is the last
    // moment before GPU minutes are spent on weights that may be inert. The
    // measurement is cached in the sidecar, so this costs a Python child once
    // per LoRA file and nothing thereafter.
    //
    // Only a POSITIVE measurement of entirely-zero effect refuses. A probe that
    // could not run (no numpy anywhere), an unreadable adapter, or one whose
    // modules all measured NaN, all render exactly as they did before this
    // gate existed — see loraEffectIssue().
    if (probeEffect) {
      const report = await probeLoraEffect(l.filename, { deadline: effectDeadline });
      const effectIssue = loraEffectIssue(report);
      if (effectIssue) {
        throw new ServerError(
          `LoRA "${l.filename}" can't be used for video: ${effectIssue}.`,
          { status: 400, code: 'LORA_EFFECT_ZERO' },
        );
      }
      if (report?.measured > 0) {
        console.log(`🔬 LoRA effect ${l.filename}: ${formatLoraEffect(report)}`);
      }
    }
    const strength = Number.isFinite(l?.scale) ? l.scale : 1.0;
    out.push({ path, strength, filename: l.filename });
  }
  return out;
};

// Validate an IC-LoRA render against its weight's contract, then emit the
// helper flags. The rules themselves (reference count, resolution divisibility)
// live in the registry that owns the numbers; this asserts them and translates
// to argv.
//
// `icLoraWeightPath` is resolved asynchronously up in generateVideo (the HF
// cache lookup is I/O) and threaded down, so this stays synchronous like every
// other buildArgs branch.
//
// Exported for direct unit testing: generateVideo floors each edge to a
// multiple of 64 before buildArgs runs, so a factor-2 weight's
// resolution-divisibility branch is unreachable through the public entry point
// (64-step flooring always yields an even number). It becomes live the moment a
// weight ships with `referenceDownscaleFactor > 2`, so it's tested here rather
// than left unverified.
export const icLoraArgs = ({ mode, width, height, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2 }) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) {
    throw new ServerError(`Unknown IC-LoRA remix mode: ${mode}`, { status: 400, code: 'IC_LORA_UNKNOWN_MODE' });
  }
  if (!icLoraWeightPath) {
    // A `requiresPreDownload` weight lands here by design: resolveIcLoraWeight
    // refuses to hand the pipeline a bare repo id it would `snapshot_download`
    // (gated official repo / 708 GB mirror), so the ONLY way forward is the
    // explicit single-file download from the panel.
    throw new ServerError(
      `IC-LoRA weight for "${spec.mode}" is not downloaded — download ${spec.label} (${spec.filename}) from the model panel first.`,
      { status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' },
    );
  }
  const refs = Array.isArray(icReferencePaths) ? icReferencePaths : [];
  assertIcReferenceCount(spec, refs.length, (msg) => new ServerError(msg, {
    status: 400, code: 'IC_LORA_REFERENCE_COUNT',
  }));
  for (const ref of refs) {
    if (!ref || !existsSync(ref)) {
      throw new ServerError(
        `IC-LoRA reference not found on disk: ${ref || '(missing)'}`,
        { status: 400, code: 'IC_LORA_REFERENCE_MISSING' },
      );
    }
  }
  // Inside the pipeline a bad resolution surfaces as a bare ValueError mid-render,
  // after the model has already loaded — catch it here instead.
  const resolutionIssue = icResolutionIssue(spec, width, height);
  if (resolutionIssue) {
    throw new ServerError(resolutionIssue, { status: 400, code: 'IC_LORA_RESOLUTION_NOT_DIVISIBLE' });
  }
  const args = [
    '--ic-mode', spec.id,
    '--ic-lora-path', icLoraWeightPath,
    '--ic-strength', String(icStrength ?? 1.0),
    // Pass the bounds rather than letting the helper carry its own table: the
    // registry stays the single source of truth across both languages, and the
    // helper still enforces them for a direct/script caller.
    '--ic-min-references', String(spec.minReferences),
    '--ic-max-references', String(spec.maxReferences),
  ];
  for (const ref of refs) args.push('--ic-reference', ref);
  if (icAttentionStrength != null) args.push('--ic-attention-strength', String(icAttentionStrength));
  if (icSkipStage2) args.push('--ic-skip-stage-2');
  return args;
};
