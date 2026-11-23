import { useRef, useState } from 'react';
import toast from '../../ui/Toast';
import { updateMusicVideoProject } from '../../../services/apiMusicVideo.js';
import useMusicVideoCastAndSets from './useMusicVideoCastAndSets.js';
import useMusicVideoDevArtifacts from './useMusicVideoDevArtifacts.js';

// A saved art draft needs every field the server schema requires.
const EMPTY_PRODUCTION_DRAFT = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };

/**
 * Look step (Cast & Sets): the check-in and the development files it saves,
 * the creative setup and style references (whose unsaved edits lock the
 * header), and the queued visual-spec saves.
 */
export default function useCastSetsStageWiring({ selected, replaceProject, patchProject, productionReview, saveOwnEdit }) {
  const [creativeSetupPending, setCreativeSetupPending] = useState(false);
  const [styleReferencesPending, setStyleReferencesPending] = useState(false);
  // Cast & Sets check-in (before the plan) and the development files it saves.
  const castSets = useMusicVideoCastAndSets({ project: selected, replaceProject });
  const devArtifacts = useMusicVideoDevArtifacts({ project: selected, replaceProject });

  // Reconcile each response beneath newer optimistic patches so a slow save
  // cannot erase later edits; a failed save falls back to the last saved spec.
  const visualSpecSaveChain = useRef(Promise.resolve());
  const visualSpecPending = useRef(new Map());
  const saveVisualSpec = (patch) => {
    const projectId = selected.id;
    let state = visualSpecPending.current.get(projectId);
    if (!state) {
      state = { base: selected.visualSpec || {}, pending: [] };
      visualSpecPending.current.set(projectId, state);
    }
    const entry = { patch };
    state.pending.push(entry);
    patchProject(projectId, (p) => ({ visualSpec: { ...(p.visualSpec || {}), ...patch } }));
    // `edit.project.visualSpec` is the saved spec when the save changed it; absent, the saved spec is the one before.
    const settle = (reply) => {
      if (reply) state.base = reply.edit?.project?.visualSpec ?? state.base;
      state.pending = state.pending.filter((item) => item !== entry);
      const desired = state.pending.reduce((spec, item) => ({ ...spec, ...item.patch }), state.base);
      const fields = new Set([...Object.keys(patch), ...state.pending.flatMap((item) => Object.keys(item.patch))]);
      patchProject(projectId, (p) => {
        const visualSpec = { ...(p.visualSpec || {}) };
        for (const field of fields) {
          if (Object.hasOwn(desired, field)) visualSpec[field] = desired[field];
          else delete visualSpec[field];
        }
        return { visualSpec };
      });
      if (!state.pending.length) visualSpecPending.current.delete(projectId);
      return reply;
    };
    visualSpecSaveChain.current = visualSpecSaveChain.current
      .then(() => saveOwnEdit(projectId, (options) => updateMusicVideoProject(projectId, { visualSpec: patch }, options)))
      .then(settle)
      .catch((err) => { toast.error(err?.message || 'Failed to save visual spec'); return settle(null); });
    return visualSpecSaveChain.current;
  };

  return {
    castSets,
    devArtifacts,
    creativeSetupPending,
    styleReferencesPending,
    saveVisualSpec,
    board: {
      castSets,
      devArtifacts,
      saveVisualSpec,
      saveCreativeSetup: (patch) => saveOwnEdit(selected.id, (options) => updateMusicVideoProject(selected.id, patch, options)),
      applyCatalogCheckin: (catalogCheckin) => patchProject(selected.id, (project) => ({
        castAndSets: { ...project.castAndSets, catalogCheckin },
      })),
      applyCastLinks: ({ concept, updatedAt }) => patchProject(selected.id, { concept, ...(updatedAt ? { updatedAt } : {}) }),
      // Only labels still empty here: an edit made while the request ran keeps its own.
      applyReferenceLabels: (labels) => patchProject(selected.id, (p) => ({ visualSpec: { ...(p.visualSpec || {}),
        references: (p.visualSpec?.references || []).map((ref) => (labels[ref.id] && !ref.label?.trim() ? { ...ref, label: labels[ref.id] } : ref)) } })),
      setCreativeSetupPending,
      setStyleReferencesPending,
      saveStyleReferences: (patch) => saveOwnEdit(selected.id, (options) => updateMusicVideoProject(selected.id, patch, options)),
      // Choose a Development file as the art-direction visual guide (saved with the rest of the draft).
      useAsGuide: (artifactId) => productionReview.save({ ...EMPTY_PRODUCTION_DRAFT, ...(selected.productionReview?.draft || {}), guideArtifactId: artifactId }),
    },
  };
}
