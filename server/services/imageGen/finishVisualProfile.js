import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { normalizeUniverseVisualProfile, visualProfileLook } from '../../lib/universeVisualProfile.js';
import { imageVisualProfileRevision } from './visualProfile.js';

/** Provider-independent finish, after its source exists and before queue completion. */
export async function finishVisualProfileImage({ result, profile: input, signal }) {
  const profile = normalizeUniverseVisualProfile(input);
  if (!profile || !result.filename) throw new Error('Image visual profile or source is invalid');
  const { assertGalleryFilename, readImageSidecar, fillImageSidecarFields } = await import('./local.js');
  assertGalleryFilename(result.filename);
  signal.throwIfAborted();
  const metadata = { visualProfile: profile, visualProfileRevision: imageVisualProfileRevision(profile) };
  await fillImageSidecarFields(result.filename, metadata);
  const look = visualProfileLook(profile);
  if (profile.finishing.mode !== 'save' || isFilmLookNeutral(look)) return { ...result, ...metadata };
  const { metadata: sourceMeta } = await readImageSidecar(result.filename);
  const { applyFilmLookBake } = await import('./filmLookBake.js');
  signal.throwIfAborted();
  const finishedVariant = await applyFilmLookBake({ filename: result.filename, sourceMeta: { ...sourceMeta, ...metadata,
    generationVisualProfile: sourceMeta.visualProfile, generationVisualProfileRevision: sourceMeta.visualProfileRevision }, look, signal });
  signal.throwIfAborted();
  // The authoritative reference remains the ungraded source. Presentation
  // variants are discoverable in the gallery without contaminating identity refs.
  return { ...result, ...metadata, finishedVariant };
}
