/**
 * Job params for a queued image render on a caller-chosen backend: the cloud
 * provider bag, or the local model. Shared by the record renders that ride the
 * media queue (mood board notes, storyboard panels) so backend resolution,
 * the disabled-provider error and the image cleaners stay one rule.
 *
 * The backend is the caller's pin when given, else the render target's saved
 * default, else the install's default. Only queueable backends apply — a
 * completion hook rides the media queue — and a pinned backend that resolves
 * to another is refused rather than substituted.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';

/**
 * @param {object} settings - getSettings() result
 * @param {{ mode?: string|null, model?: string|null, target?: string|null }} route
 * @param {object} common - params every backend gets (prompt, size, tag…)
 * @param {{ what: string, code: string }} refusal - names the caller in the 409
 */
export async function queueableImageParams(settings, { mode = null, model = null, target = null }, common, refusal) {
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }] = await Promise.all([
    import('./cloudProviderConfig.js'),
    import('../../lib/imageCleanDefaults.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, target, { mode, model, usableInstallFallback: true });
  if ((mode && resolved.mode !== mode) || !QUEUEABLE_IMAGE_MODES.includes(resolved.mode)) {
    throw new ServerError(`The ${mode || resolved.mode} image backend cannot render ${refusal.what}`, {
      status: 409, code: refusal.code,
    });
  }
  if (resolved.cloud && !resolved.cloud.enabled) throw resolved.cloud.disabledError;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, resolved.mode);
  if (resolved.cloud) return { ...resolved.cloud.jobParams, ...common, cleanC2PA, denoise };
  const { resolveLocalImageModel } = await import('./prepareParams.js');
  const { pythonPath, selectedModel } = resolveLocalImageModel(settings, { modelId: model || undefined });
  return { ...common, cleanC2PA, denoise, pythonPath, ...(selectedModel?.id ? { modelId: selectedModel.id } : {}) };
}
