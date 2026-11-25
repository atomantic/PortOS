import { useRef, useState } from 'react';
import toast from '../../ui/Toast';
import { refreshMusicVideoSongStyleFromSuno, updateMusicVideoProject } from '../../../services/apiMusicVideo.js';
import useFieldDraft from '../../../hooks/useFieldDraft.js';
import useMusicVideoTreatment from '../../../hooks/useMusicVideoTreatment.js';

/**
 * Story step: the concept, style and song-style drafts, their chained saves,
 * the pre-production treatment and the storyboard link.
 */
export default function useStoryStageWiring({ selected, patchProject, replaceProject }) {
  const [conceptSavePending, setConceptSavePending] = useState(0);
  const [conceptSaveFailures, setConceptSaveFailures] = useState({});
  const conceptSaveChain = useRef(Promise.resolve());
  const conceptSaveVersions = useRef({});
  const conceptSaveSequence = useRef(0);
  const [songStyleReadPending, setSongStyleReadPending] = useState(false);
  // Pre-production treatment (#8980): brief, compiled arc, shot direction
  // and the non-destructive Apply review.
  const treatment = useMusicVideoTreatment({ project: selected, onProjectPatch: patchProject, replaceProject });

  // Project-level concept/style (issue #3168) — optimistic-local + silent-PATCH on
  // commit. Sends only the changed sub-field; the server merges it into the
  // existing concept (applyProjectPatch), so a stale local copy can't clobber a
  // sibling sub-field. Consumed by buildScenePlanPrompt (AI Plan) and by the
  // server's frame and clip composers (lib/musicVideo/musicVideoShotPrompt.js), both already reading concept.
  const commitConcept = (patch) => {
    const version = ++conceptSaveSequence.current;
    for (const key of Object.keys(patch)) conceptSaveVersions.current[key] = version;
    patchProject(selected.id, (project) => ({ concept: { ...project.concept, ...patch } }));
    setConceptSavePending((count) => count + 1);
    const run = conceptSaveChain.current.then(() => updateMusicVideoProject(selected.id, { concept: patch }, { silent: true }));
    conceptSaveChain.current = run.catch(() => {});
    return run.then(() => {
      setConceptSaveFailures((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => conceptSaveVersions.current[key] !== version)));
    }).catch((err) => {
      setConceptSaveFailures((previous) => ({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([key]) => conceptSaveVersions.current[key] === version)) }));
      toast.error(err?.message || 'Failed to save concept');
    })
      .finally(() => setConceptSavePending((count) => count - 1));
  };

  // Buffered so a concept/style keystroke doesn't fire a round-trip per character,
  // and a focus-without-edit blur doesn't re-PATCH an unchanged value.
  const conceptDraft = useFieldDraft(selected?.concept?.prompt, (v) => commitConcept({ prompt: v }));
  const styleDraft = useFieldDraft(selected?.concept?.style, (v) => commitConcept({ style: v }));
  const songStyleDraft = useFieldDraft(selected?.concept?.songStyle, (v) => commitConcept({ songStyle: v }));
  // The workspace remounts per project, so a still-focused, unblurred draft
  // cannot survive a project switch and be committed onto the next project.
  // Re-read the song style (with its excluded styles) from the song's Suno link.
  const songStyleFromSuno = (url) => {
    setSongStyleReadPending(true);
    return refreshMusicVideoSongStyleFromSuno(selected.id, url, { silent: true })
      .then(({ project, excludedStylesKnown }) => {
        songStyleDraft.reset();
        patchProject(project.id, (current) => ({ concept: { ...current.concept, songStyle: project.concept?.songStyle }, updatedAt: project.updatedAt }));
        if (excludedStylesKnown) toast.success('Song style read from Suno');
        else toast.warning('Read the style, but Suno only shows excluded styles when the PortOS Browser is signed in to Suno');
        return true;
      })
      .catch((err) => { toast.error(err?.message || 'Could not read the song style from Suno'); return false; })
      .finally(() => setSongStyleReadPending(false));
  };

  return {
    board: {
      storySavePending: conceptSavePending > 0 || Object.keys(conceptSaveFailures).length > 0 || songStyleReadPending || treatment.pendingWrites > 0 || treatment.applying,
      conceptSaveFailures,
      conceptSavePending,
      retryConceptSave: () => commitConcept(conceptSaveFailures),
      treatment,
      conceptDraft,
      styleDraft,
      songStyleDraft,
      songStyleFromSuno,
      patchStoryProject: (patch) => patchProject(selected.id, patch),
      saveStoryLink: (storyboardId) => updateMusicVideoProject(selected.id, { storyboardId }, { silent: true })
        .then((saved) => { patchProject(saved.id, { storyboardId: saved.storyboardId, updatedAt: saved.updatedAt }); return saved; }),
    },
  };
}
