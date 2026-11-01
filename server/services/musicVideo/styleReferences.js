import { basename } from 'node:path';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { promptAddition } from '../../lib/modelInput.js';
import { musicVideoStyleImages, musicVideoStylePrompt, musicVideoStyleReferenceCapacity } from '../../lib/musicVideoConditioning.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';

/** Resolve style capacity on the actual route, preserving every explicit identity input. */
export async function withMusicVideoStyle(project, params, mode, model, settings) {
  if (!project?.styleReferences?.length) return params;
  let localModel = null;
  if (mode === 'local') {
    const [{ selectLocalImageModelFromSettings }, { getImageModels }] = await Promise.all([
      import('../imageGen/prepareParams.js'), import('../../lib/mediaModels.js'),
    ]);
    localModel = selectLocalImageModelFromSettings(settings, model, getImageModels());
  }
  const identities = params.referenceImagePaths || [];
  const cloudModel = mode === 'local' ? null : model || (await import('../imageGen/cloudProviderConfig.js'))
    .resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { mode }).cloud?.modelId;
  const capacity = musicVideoStyleReferenceCapacity(mode, localModel, cloudModel);
  const styles = musicVideoStyleImages(project, identities.map((p) => basename(p)), capacity)
    .map((id) => resolveGalleryImage(id, { mustExist: false })).filter((p) => p && !identities.includes(p));
  const look = musicVideoStylePrompt(project, styles.length);
  return {
    ...params,
    prompt: [params.prompt, look].filter(Boolean).join('. '),
    promptAdditions: [...(params.promptAdditions || []), promptAddition('mood-board-style', 'Mood board style', look)].filter(Boolean),
    ...(styles.length ? {
      referenceImagePaths: [...identities, ...styles],
      referenceImageStrengths: [...(params.referenceImageStrengths || identities.map(() => 1)), ...styles.map(() => 1)],
    } : {}),
  };
}
