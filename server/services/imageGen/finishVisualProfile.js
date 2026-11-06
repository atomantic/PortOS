import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { normalizeUniverseVisualProfile, visualProfileLook } from '../../lib/universeVisualProfile.js';
import { imageVisualProfileRevision } from './visualProfile.js';

/** Provider-independent finish, after its source exists and before queue completion. */
export async function finishVisualProfileImage({ result, profile: input, signal, onCleanupFailure, applyFilmFinish = true }) {
  const profile = normalizeUniverseVisualProfile(input);
  if (!profile || !result.filename) throw new Error('Image visual profile or source is invalid');
  // Catalog references are identity inputs, not graded presentation outputs.
  // Save generation provenance but suppress both automatic preview and baking.
  if (!applyFilmFinish) profile.finishing = { ...profile.finishing, mode: 'off' };
  const { assertGalleryFilename, readImageSidecar, fillImageSidecarFields } = await import('./local.js');
  assertGalleryFilename(result.filename);
  signal.throwIfAborted();
  let metadata = { visualProfile: profile, visualProfileRevision: imageVisualProfileRevision(profile) };
  if (applyFilmFinish) await fillImageSidecarFields(result.filename, metadata);
  else {
    const { editImageSidecar } = await import('./sidecarStore.js');
    await editImageSidecar(result.filename, sidecar => {
      if (!Object.keys(sidecar).length) return null;
      const saved = normalizeUniverseVisualProfile(sidecar.visualProfile) || profile;
      saved.finishing = { ...saved.finishing, mode: 'off' };
      metadata = { visualProfile: saved, visualProfileRevision: imageVisualProfileRevision(saved) };
      Object.assign(sidecar, metadata);
      return true;
    });
  }
  const look = visualProfileLook(profile);
  if (!applyFilmFinish || profile.finishing.mode !== 'save' || isFilmLookNeutral(look)) return { ...result, ...metadata };
  const { metadata: sourceMeta } = await readImageSidecar(result.filename);
  const { applyFilmLookBake } = await import('./filmLookBake.js');
  signal.throwIfAborted();
  const finishedVariant = await applyFilmLookBake({ filename: result.filename, sourceMeta: { ...sourceMeta, ...metadata,
    generationVisualProfile: sourceMeta.visualProfile, generationVisualProfileRevision: sourceMeta.visualProfileRevision }, look, signal, onCleanupFailure });
  signal.throwIfAborted();
  // The authoritative reference remains the ungraded source. Presentation
  // variants are discoverable in the gallery without contaminating identity refs.
  return { ...result, ...metadata, finishedVariant };
}
