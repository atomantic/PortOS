/**
 * Attaches a finished reference render to its Blender model. The destination is
 * the queued job's own tag, so a render that finishes after a restart (or with
 * no page open) still lands.
 */
import { createMediaJobImageHook, deriveRenderJobId } from '../mediaJobImageHook.js';
import { BLENDER_MODEL_REFERENCE_TAG, attachRenderedReference, failRenderedReference } from './references.js';

const hook = createMediaJobImageHook({
  label: 'Blender model reference',
  initLog: '🧊 Blender model reference hook initialized',
  tagKey: BLENDER_MODEL_REFERENCE_TAG,
  identify: (tag) => (['modelId', 'referenceId', 'imageId'].every((key) => typeof tag?.[key] === 'string' && tag[key])
    ? { modelId: tag.modelId, referenceId: tag.referenceId, imageId: tag.imageId, basedOn: tag.basedOn ?? null } : null),
  serializeKey: ({ modelId }) => modelId,
  describe: ({ modelId, referenceId }) => `${modelId}/${referenceId}`,
  attach: ({ modelId, referenceId, imageId, basedOn, filename, job }) => attachRenderedReference({
    modelId, referenceId, imageId, basedOn, filename, jobId: deriveRenderJobId(job, filename),
  }),
  onAttached: ({ modelId, referenceId }, image) => console.log(`🧊 Blender model ${modelId.slice(0, 15)} reference ${referenceId} ← ${image.filename}`),
  onTerminal: (ctx, status, job) => failRenderedReference(ctx, status, job?.error),
});

export const initBlenderModelReferenceHook = () => hook.init();

export const __testing = hook.__testing;
