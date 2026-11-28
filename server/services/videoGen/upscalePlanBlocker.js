/** Decide whether a queued video upscale plan is ready and describe the first blocker. */

import { isHardwareCompatible, hardwareUnavailableReason } from '../../lib/systemCapabilities.js';
import { ltxAlignmentBlocker } from './upscalePlan.js';

export const ltxUpscaleAdapterBlocker = (adapter) => ({
  status: 400,
  code: 'IC_LORA_WEIGHT_UNRESOLVED',
  message: `${adapter?.label || 'The LTX-2.5 upscale adapter'} is not downloaded — download it from the model panel before upscaling.`,
});

function ltxBlocker({ runtime, baseModel, adapter, alignment, source }) {
  if (!runtime.supported || !runtime.installed) {
    return {
      status: 501,
      code: 'UNSUPPORTED_RUNTIME',
      message: `Generative upscale is not available on this install: ${runtime.reason}`,
    };
  }
  // Check hardware before downloads so an incompatible host gets the actionable refusal.
  if (!isHardwareCompatible(baseModel?.hardwareCompatibility)) {
    const reason = hardwareUnavailableReason(baseModel.name || 'The LTX-2.5 pack', baseModel.hardwareCompatibility);
    return { status: 501, code: 'UNSUPPORTED_RUNTIME', message: `Generative upscale is not available on this install: ${reason}` };
  }
  if (!adapter?.cached) return ltxUpscaleAdapterBlocker(adapter);
  if (!baseModel?.cached || !baseModel.path) {
    return {
      status: 400,
      code: 'UPSCALE_BASE_MODEL_UNRESOLVED',
      message: baseModel?.reason || 'The LTX-2.5 model pack for this backend is not downloaded.',
    };
  }
  const alignmentReason = ltxAlignmentBlocker(alignment);
  if (alignmentReason) return { status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE', message: alignmentReason };
  if (!(Number(source?.fps) > 0)) {
    return {
      status: 400,
      code: 'UPSCALE_SOURCE_UNALIGNABLE',
      message: 'The source frame rate could not be measured, so the padded tail and the render frame rate cannot be set.',
    };
  }
  return null;
}

function realesrganBlocker({ runtime, source }) {
  if (!runtime.supported) {
    return {
      status: 501,
      code: 'UNSUPPORTED_RUNTIME',
      message: `Real-ESRGAN is not available on this install: ${runtime.reason}`,
    };
  }
  if (!runtime.installed) {
    return {
      status: 400,
      code: 'REALESRGAN_NOT_READY',
      message: runtime.reason || 'Install Real-ESRGAN before upscaling with it.',
    };
  }
  if (!(source?.width > 0) || !(source?.height > 0) || !(Number(source?.fps) > 0)) {
    return {
      status: 400,
      code: 'UPSCALE_SOURCE_UNMEASURED',
      message: 'The source size or frame rate could not be measured, so the upscale cannot keep its cadence.',
    };
  }
  return null;
}

function seedvr2Blocker({ runtime, estimatedCostUsd }, requireCost) {
  if (!runtime.installed) {
    return {
      status: 400,
      code: 'FAL_KEY_MISSING',
      message: runtime.reason || 'Configure FAL_KEY in Settings → Credentials to use fal.ai SeedVR2 upscaling.',
    };
  }
  if (requireCost && estimatedCostUsd == null) {
    return { status: 422, code: 'UPSCALE_GEOMETRY_UNKNOWN', message: 'The selected clip could not be measured for a cost estimate.' };
  }
  return null;
}

export function upscalePlanBlocker(plan, { requireCost = false } = {}) {
  if (plan.alreadyUpscaled) {
    return { status: 400, code: 'ALREADY_UPSCALED', message: 'Cannot upscale an already-upscaled video' };
  }
  if (plan.method === 'ltx') return ltxBlocker(plan);
  if (plan.method === 'realesrgan') return realesrganBlocker(plan);
  if (plan.method === 'fal-seedvr2') return seedvr2Blocker(plan, requireCost);
  return null;
}
