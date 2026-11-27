import { useEffect, useMemo, useState } from 'react';
import { normalizeTitleCard, titleCardVisible, titleCardWindows } from '../../../../server/lib/musicVideo/musicVideoTitleCard.js';
import useGeneratedPreview from '../../hooks/useGeneratedPreview.js';
import { hashString } from '../../utils/hashString.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { usePreviewFilmLook } from './PreviewFilmLook.jsx';

// What the lyric playthrough page is built from: the song length, the word times,
// the sheet's sections, the shots' timing and text zones, and the title card's spot. A change rebuilds it.
// Hashed: the preview socket caps `revision` at 500 characters and a whole song's word times run far past it.
const playthroughKey = (project) => JSON.stringify([
  project.audioAnalysis?.durationSec ?? null,
  project.lyricOverlayEnabled,
  (project.lyricCues || []).map((cue) => [cue.text, cue.startSec, cue.endSec, (cue.words || []).map((w) => [w.startSec, w.endSec])]),
  (project.lyricMarkers || []).map((m) => [m.type, m.label, m.line]),
  (project.scenes || []).map((s) => [s.startSec, s.endSec, s.textZone, s.lyricRole, s.lyricSize]),
  // The lyrics step off the title card's corner while it shows.
  titleCardVisible(project.titleCard) ? [project.titleCard.position, titleCardWindows(project.titleCard)] : null,
  project.composition?.mode === 'document' ? [project.composition.textCues, project.composition.style, project.treatment?.brief] : null,
]);
export const playthroughVersion = (project) => {
  const key = playthroughKey(project);
  return `pt-${key.length.toString(36)}-${hashString(key).toString(36)}`;
};

// The shot pictures and effect inputs a document session stages at open (its
// selected clip or still is copied in), including what makes an end-frame effect eligible (its still's media and medium). A change
// reopens it, so a new effect draws (or is named as unsupported) and a removed one clears.
const shotEffectsKey = (project) => JSON.stringify([project.audioAnalysis?.durationSec ?? null, project.productionPolicy?.strategy ?? null,
  project.overscan ?? null, project.templateEffects ?? null,
  (project.cameras || []).map((camera) => [camera.id, camera.filmLook, camera.frame, camera.cuts, camera.osd]),
  (project.treatment?.shotDirections || []).map((d) => [d.sceneId, d.medium]),
  (project.scenes || []).map((s) => [s.sceneId, s.startSec, s.endSec,
    s.transitionIn, s.transitionOut, s.glitches, s.imageEffect, s.endImageId, s.visualLayer,
    s.videoHistoryId, s.sourceTake, s.referenceImageId, s.photoSequence, s.direction?.medium, s.filmLook, s.templateEffects])]);
const shotEffectsVersion = (project) => {
  const key = shotEffectsKey(project);
  return `fx-${key.length.toString(36)}-${hashString(key).toString(36)}`;
};

/** The reopen key of a project's live document preview, or null without a document. */
export const documentPreviewRevision = (project, { draft = false } = {}) => {
  const doc = draft ? project.composition?.documentDraft : project.composition?.document;
  return doc ? `${doc.directory}|${doc.updatedAt || ''}${project.lyricOverlayEnabled === false ? '|lyrics-off' : ''}|${shotEffectsVersion(project)}` : null;
};

const shotLooksAvailable = (project) => (project.scenes || []).some(scene => !isFilmLookNeutral(scene.filmLook))
  || (project.cameras || []).some(camera => !isFilmLookNeutral(camera.filmLook));

/** The film look a document preview sends its worker: the video's, a neutral base under per-shot looks, or none. */
export const documentPreviewLook = (project, lookOn) => (lookOn ? (project.filmLook ?? (shotLooksAvailable(project) ? { preset: 'none' } : null)) : null);

// A phone's collapsed mini-player has no picture to show, so it must not start
// the isolated renderer up front. Without matchMedia, load eagerly.
const DESKTOP_QUERY = '(min-width: 1024px)';
const startsDeferred = (collapsed) => collapsed && window.matchMedia?.(DESKTOP_QUERY).matches === false;

export default function useCompositionPreview({
  project, lyrics, draft, collapsed,
}) {
  const doc = lyrics ? { playthrough: true } : (draft ? project.composition?.documentDraft : project.composition?.document) || null;
  const [wanted, setWanted] = useState(() => !startsDeferred(collapsed));
  useEffect(() => {
    if (!collapsed) { setWanted(true); return undefined; }
    const desktop = window.matchMedia?.(DESKTOP_QUERY);
    const reveal = () => { if (!desktop || desktop.matches) setWanted(true); };
    reveal();
    desktop?.addEventListener?.('change', reveal);
    return () => desktop?.removeEventListener?.('change', reveal);
  }, [collapsed]);
  const [lookOn, toggleLook] = usePreviewFilmLook();
  const shotLookAvailable = shotLooksAvailable(project);
  const filmLook = lyrics ? null : documentPreviewLook(project, lookOn);
  const lookAvailable = !lyrics && (!isFilmLookNeutral(project.filmLook) || shotLookAvailable);
  const titleCard = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  const revision = lyrics ? playthroughVersion(project) : documentPreviewRevision(project, { draft });
  const request = useMemo(() => {
    if (!wanted || !revision || !doc) return null;
    return {
      kind: 'music-video', projectId: project.id, draft: !!draft, lyrics: !!lyrics, revision,
    };
  }, [wanted, revision, doc, project.id, draft, lyrics]);
  const controls = useMemo(() => ({ look: filmLook, card: titleCard }), [filmLook, titleCard]);
  const preview = useGeneratedPreview({ active: !!request, request, controls });
  return { doc, wanted, request, preview, lookOn, toggleLook, lookAvailable };
}
