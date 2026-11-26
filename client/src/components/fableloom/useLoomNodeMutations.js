import { useEffect, useMemo, useState } from 'react';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  addLoomTransition,
  branchLoomNode,
  deleteLoomNode,
  deleteLoomTransition,
  updateLoomNode,
  updateLoomTransition,
} from '../../services/apiFableLoom.js';

const toRow = (t) => ({ ...t, triggersText: (t.triggers || []).join('; ') });
const rowToPatch = ({ targetNodeId, intent, triggersText, description }) => ({
  targetNodeId,
  intent: intent || '',
  triggers: (triggersText || '').split(';').map((s) => s.trim()).filter(Boolean),
  description: description || '',
});

export default function useLoomNodeMutations({
  loom, episode, node, onLoomUpdate, onClearSelection, onGenerateImage, onGenerateVideo,
  onAutomateFalVideo,
}) {
  const [form, setForm] = useState(null);
  const [referenceCharacterId, setReferenceCharacterId] = useState(null);
  // In-flight blur-saves; the AI buttons (which read server-side state) stay
  // disabled until every pending save settles.
  const [pendingSaves, setPendingSaves] = useState(0);
  const [addingPath, setAddingPath] = useState(false);
  const del = useConfirmDelete();

  // Sync from the record on scene switch ONLY (the parent keys this component
  // by node.id, so this is effectively the mount). Re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save round-trips.
  // Server-side additions that arrive mid-edit (AI branch) are folded in
  // explicitly where they happen.
  useEffect(() => {
    setForm({
      title: node.title || '',
      shot: node.shot || null,
      prose: node.prose || '',
      imagePrompt: node.imagePrompt || '',
      videoPrompt: node.videoPrompt || '',
      cameraMovement: node.cameraMovement || '',
      visualCanon: node.visualCanon ? {
        ...node.visualCanon,
        characterAppearances: [...(node.visualCanon.characterAppearances || [])],
        objectIds: [...(node.visualCanon.objectIds || [])],
      } : null,
      playbackMode: node.playbackMode || 'decision',
      audienceConnection: node.audienceConnection || 'disconnected',
      protagonistPresence: node.protagonistPresence || null,
      playbackAssets: node.playbackAssets || null,
      interactionWindow: node.interactionWindow || {
        enabled: false,
        protagonistCharacterId: null,
        protagonistPresence: 'offscreen',
        audioTarget: 'host',
        ambientDuckDb: -8,
        holdLoopRotation: 'deterministic',
      },
      isEnding: !!node.isEnding,
      endingLabel: node.endingLabel || '',
      transitions: (node.transitions || []).map(toRow),
    });
  }, [node.id]);

  // A replacement still invalidates approval even when the scene stays selected.
  const storyboardImageApproved = node.visualCanon?.storyboardImageApproved === true;
  useEffect(() => {
    setForm((current) => {
      if (!current?.visualCanon || current.visualCanon.storyboardImageApproved === storyboardImageApproved) {
        return current;
      }
      return {
        ...current,
        visualCanon: { ...current.visualCanon, storyboardImageApproved },
      };
    });
  }, [node.id, node.image, storyboardImageApproved]);

  const otherNodes = useMemo(
    () => episode.nodes.filter((n) => n.id !== node.id),
    [episode.nodes, node.id],
  );

  // Every write from this panel goes through here so the AI gate sees it and a
  // failure surfaces once, in one place.
  const runSave = async (write) => {
    setPendingSaves((n) => n + 1);
    const result = await write().catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    setPendingSaves((n) => n - 1);
    return result;
  };

  const patchNode = async (patch) => {
    const updated = await runSave(() => updateLoomNode(loom.id, episode.id, node.id, patch, { silent: true }));
    if (updated) onLoomUpdate(updated);
    return updated;
  };

  const saveVisualCanon = (next) => {
    setForm((current) => ({ ...current, visualCanon: next }));
    patchNode({ visualCanon: next });
  };

  const updateVisualCanon = (patch) => saveVisualCanon({ ...form.visualCanon, ...patch });

  // Blur-save helper: skip the round-trip when the value matches the record
  // (tabbing through the panel shouldn't rewrite the loom).
  const saveField = (key, value) => {
    if (value === (node[key] || '')) return null;
    return patchNode({ [key]: value });
  };

  // Blur-save for one path. Skipped when the row already matches the record,
  // so tabbing through a path doesn't rewrite the loom.
  const saveTransition = async (row) => {
    const saved = (node.transitions || []).find((t) => t.id === row.id);
    const patch = rowToPatch(row);
    // No record row to compare against means the panel is ahead of the loom in
    // state, NOT that nothing changed — save rather than silently drop the edit.
    if (saved && JSON.stringify(patch) === JSON.stringify(rowToPatch(toRow(saved)))) return;
    const updated = await runSave(
      () => updateLoomTransition(loom.id, episode.id, node.id, row.id, patch, { silent: true }),
    );
    if (updated) onLoomUpdate(updated);
  };

  // The save fires OUTSIDE the setState updater — StrictMode runs updaters
  // twice, so a PATCH inside one double-fires.
  const applyTransition = (index, patch, { save = false } = {}) => {
    const transitions = form.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t));
    setForm((prev) => ({ ...prev, transitions }));
    if (save) saveTransition(transitions[index]);
  };

  const removeTransition = async (row) => {
    setForm((prev) => ({ ...prev, transitions: prev.transitions.filter((t) => t.id !== row.id) }));
    const updated = await runSave(
      () => deleteLoomTransition(loom.id, episode.id, node.id, row.id, { silent: true }),
    );
    // The row went out of the list before the round-trip; put the record back
    // if the delete never landed, rather than leaving a path that only looks gone.
    if (updated) onLoomUpdate(updated);
    else setForm((prev) => ({ ...prev, transitions: (node.transitions || []).map(toRow) }));
  };

  // The row is created server-side first, so it arrives with its id already
  // set and every later edit is a plain PATCH against it.
  const addTransition = async () => {
    const target = otherNodes[0];
    if (!target) {
      toast.error('Add another scene first — a path needs somewhere to go');
      return;
    }
    setAddingPath(true);
    const result = await runSave(
      () => addLoomTransition(loom.id, episode.id, node.id, { targetNodeId: target.id, intent: '' }, { silent: true }),
    );
    setAddingPath(false);
    if (!result?.transition) return;
    setForm((prev) => ({ ...prev, transitions: [...prev.transitions, toRow(result.transition)] }));
    onLoomUpdate(result.loom);
  };

  const [runBranch, branching] = useAsyncAction(async () => {
    const result = await branchLoomNode(loom.id, episode.id, node.id, { branchCount: 2 }, { silent: true });
    onLoomUpdate(result.loom);
    // The AI writes new paths straight onto the record; this panel is keyed by
    // node.id so it never remounts to pick them up.
    const wovenNode = result.loom?.episodes.find((e) => e.id === episode.id)
      ?.nodes.find((n) => n.id === node.id);
    if (wovenNode) {
      setForm((prev) => ({
        ...prev,
        playbackMode: wovenNode.playbackMode || 'decision',
        transitions: (wovenNode.transitions || []).map(toRow),
      }));
    }
    toast.success('New branches woven');
  }, { errorMessage: 'Branching failed' });

  const runGenerateImage = async () => {
    const prompt = form.imagePrompt.trim();
    if (!prompt) {
      toast.error('Write an image prompt first');
      return;
    }
    // Persist the prompt if the blur hasn't already, then queue the render
    // with the fableLoom destination tag — the server-side completion hook
    // files the finished image onto this node even if the page unmounts
    // mid-render.
    await saveField('imagePrompt', prompt);
    await onGenerateImage?.({ ...node, imagePrompt: prompt });
  };

  const runGenerateVideo = async () => {
    const authoredPrompt = form.videoPrompt.trim() || form.prose.trim();
    if (!authoredPrompt) {
      toast.error('Write the scene first');
      return;
    }
    await saveField('videoPrompt', form.videoPrompt);
    await onGenerateVideo?.({
      ...node,
      prose: form.prose,
      videoPrompt: form.videoPrompt,
      cameraMovement: form.cameraMovement,
    });
  };

  const runAutomateFalVideo = async () => {
    const authoredPrompt = form.videoPrompt.trim() || form.prose.trim();
    if (!authoredPrompt) {
      toast.error('Write the scene first');
      return;
    }
    await saveField('videoPrompt', form.videoPrompt);
    await onAutomateFalVideo?.({
      ...node,
      prose: form.prose,
      videoPrompt: form.videoPrompt,
      cameraMovement: form.cameraMovement,
    });
  };

  const attachGalleryVideo = async (_targetNode, item) => {
    if (!item?.id || !item?.filename) {
      toast.error('The selected video is missing its gallery record');
      return;
    }
    // Scene playback has historically resolved history ids as `${id}.mp4`.
    // fal H3 Max downloads MP4, so refuse a different gallery container rather
    // than attaching a record whose preview URL this schema cannot represent.
    if (item.filename !== `${item.id}.mp4`) {
      toast.error('Choose an MP4 uploaded here; this gallery video uses a different filename');
      return;
    }
    const updated = await patchNode({ videoHistoryId: item.id });
    if (updated) toast.success('Scene video attached');
  };

  const handleDelete = async () => {
    const updated = await deleteLoomNode(loom.id, episode.id, node.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onClearSelection();
    }
  };

  const setScenePresence = (value, recommendedPresence) => {
    const canonicalProtagonistId = loom.protagonistCharacterId;
    const interactionProtagonistId = form.interactionWindow?.protagonistCharacterId;
    const nextPresence = value || null;
    const protagonistIds = new Set([canonicalProtagonistId, interactionProtagonistId].filter(Boolean));
    let nextVisualCanon = form.visualCanon;
    if (form.visualCanon && value === 'offscreen') {
      nextVisualCanon = {
        ...form.visualCanon,
        characterAppearances: form.visualCanon.characterAppearances.filter(
          (appearance) => !protagonistIds.has(appearance.characterId),
        ),
      };
    } else if (form.visualCanon && value === 'onscreen' && canonicalProtagonistId
      && !form.visualCanon.characterAppearances.some((appearance) => appearance.characterId === canonicalProtagonistId)) {
      nextVisualCanon = {
        ...form.visualCanon,
        characterAppearances: [
          ...form.visualCanon.characterAppearances,
          {
            characterId: canonicalProtagonistId,
            wardrobeId: loom.protagonistWardrobeId || null,
            expression: '',
            continuityNotes: '',
          },
        ],
      };
    }
    const nextInteraction = form.interactionWindow?.enabled
      ? {
        ...form.interactionWindow,
        protagonistPresence: value || recommendedPresence || 'offscreen',
      }
      : form.interactionWindow;
    setForm((current) => ({
      ...current,
      protagonistPresence: nextPresence,
      visualCanon: nextVisualCanon,
      interactionWindow: nextInteraction,
    }));
    patchNode({
      protagonistPresence: nextPresence,
      ...(form.interactionWindow?.enabled ? { interactionWindow: nextInteraction } : {}),
      ...(nextVisualCanon !== form.visualCanon ? { visualCanon: nextVisualCanon } : {}),
    });
  };

  return {
    form, setForm, referenceCharacterId, setReferenceCharacterId, pendingSaves, addingPath, del,
    otherNodes, patchNode, saveVisualCanon, updateVisualCanon, saveField, saveTransition,
    applyTransition, removeTransition, addTransition, runBranch, branching, runGenerateImage,
    runGenerateVideo, runAutomateFalVideo, attachGalleryVideo, handleDelete, setScenePresence,
  };
}
