/**
 * FableLoom scene editor — the side panel for the selected node: title/prose,
 * ending flag + label, the intent-transition list, scene image prompt and
 * image/video previews via the shared local media lanes, a known camera-move
 * selector, a dedicated single-clip video prompt, and the AI branch action.
 *
 * Fields save on blur (silent PATCH, skipped when unchanged; the server
 * returns the full loom, which the parent folds into state). Paths save one
 * row at a time against the transition sub-resources — a row exists on the
 * server the moment it is added, so its id is known here and nothing has to be
 * reconciled back after a save. The AI actions read server-side state, so they
 * gate on in-flight saves per the client save-gating convention.
 */

import { useEffect, useMemo, useState } from 'react';
import { GitBranch, Loader2, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { FormField } from '../ui/FormField.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  addLoomTransition, branchLoomNode, deleteLoomNode, deleteLoomTransition,
  updateLoomNode, updateLoomTransition,
} from '../../services/api';
import { fieldClass, labelClass, sceneFieldClass } from './fieldStyles';
import { isTeleplayFormat } from './loomFormats';
import LoomSceneMedia from './LoomSceneMedia';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import { FABLELOOM_PLAYBACK_MODES } from '../../../../server/lib/fableLoomPlayback.js';
import { FABLELOOM_AUDIENCE_CONNECTION_STATES } from '../../../../server/lib/fableLoomParticipation.js';

const toRow = (t) => ({ ...t, triggersText: (t.triggers || []).join('; ') });
const rowToPatch = ({ targetNodeId, intent, triggersText, description }) => ({
  targetNodeId,
  intent: intent || '',
  triggers: (triggersText || '').split(';').map((s) => s.trim()).filter(Boolean),
  description: description || '',
});

export default function LoomNodeEditor({
  loom, episode, node, onLoomUpdate, onClearSelection, onMakeStart,
  mediaJobs = {}, onGenerateImage, onGenerateVideo,
  generationDisabled = false, generationDisabledReason = '',
}) {
  const [form, setForm] = useState(null);
  // In-flight blur-saves; the AI buttons (which read server-side state) stay
  // disabled until every pending save settles.
  const [pendingSaves, setPendingSaves] = useState(0);
  const [addingPath, setAddingPath] = useState(false);
  const del = useConfirmDelete();
  // A teleplay carries its own line breaks, so the editor gives it a taller
  // monospaced field — the same surface prose gets, sized for the format.
  const teleplay = isTeleplayFormat(loom.format);

  // Sync from the record on scene switch ONLY (the parent keys this component
  // by node.id, so this is effectively the mount). Re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save round-trips.
  // Server-side additions that arrive mid-edit (AI branch) are folded in
  // explicitly where they happen.
  useEffect(() => {
    setForm({
      title: node.title || '',
      prose: node.prose || '',
      imagePrompt: node.imagePrompt || '',
      videoPrompt: node.videoPrompt || '',
      cameraMovement: node.cameraMovement || '',
      playbackMode: node.playbackMode || 'decision',
      audienceConnection: node.audienceConnection || 'disconnected',
      isEnding: !!node.isEnding,
      endingLabel: node.endingLabel || '',
      transitions: (node.transitions || []).map(toRow),
    });
  }, [node.id]);

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

  const handleDelete = async () => {
    const updated = await deleteLoomNode(loom.id, episode.id, node.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onClearSelection();
    }
  };

  if (!form) return null;
  const aiBlocked = pendingSaves > 0;
  const helperMode = loom.participationMode === 'helper';
  const audienceConnected = !helperMode || form.audienceConnection === 'connected';

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Scene</h3>
          {onMakeStart && (
            <button
              type="button"
              onClick={onMakeStart}
              className="text-xs text-port-accent hover:underline"
            >
              Set as opening
            </button>
          )}
        </div>
        {del.isConfirming(node.id) ? (
          <ConfirmButtonPair prompt="Delete scene?" onConfirm={handleDelete} onCancel={del.cancelDelete} />
        ) : (
          <button
            type="button"
            onClick={() => del.requestDelete(node.id)}
            className="text-port-text-muted hover:text-port-error"
            aria-label="Delete scene"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <FormField label="Title" labelClassName={labelClass}>
        <input
          className={fieldClass}
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          onBlur={() => saveField('title', form.title)}
        />
      </FormField>

      <FormField label={teleplay ? 'Scene (teleplay)' : 'Scene prose'} labelClassName={labelClass}>
        <textarea
          rows={teleplay ? 12 : 7}
          className={sceneFieldClass(loom.format)}
          value={form.prose}
          onChange={(e) => setForm((p) => ({ ...p, prose: e.target.value }))}
          onBlur={() => saveField('prose', form.prose)}
        />
      </FormField>

      <FormField label="Playback behavior" labelClassName={labelClass}>
        <select
          className={fieldClass}
          aria-label="Playback behavior"
          value={form.playbackMode}
          onChange={(e) => {
            setForm((p) => ({ ...p, playbackMode: e.target.value }));
            patchNode({ playbackMode: e.target.value });
          }}
        >
          {FABLELOOM_PLAYBACK_MODES.map((mode) => (
            <option key={mode} value={mode} disabled={helperMode && !audienceConnected && mode === 'decision'}>
              {mode === 'cut' ? 'Automatic cut — play once, then advance' : 'Decision point — loop while awaiting input'}
            </option>
          ))}
        </select>
      </FormField>

      {helperMode && (
        <FormField label="Audience connection" labelClassName={labelClass}>
          <select
            className={fieldClass}
            aria-label="Audience connection"
            value={form.audienceConnection}
            onChange={(event) => {
              const audienceConnection = event.target.value;
              const nextPlaybackMode = audienceConnection === 'disconnected' ? 'cut' : form.playbackMode;
              setForm((current) => ({
                ...current,
                audienceConnection,
                playbackMode: nextPlaybackMode,
              }));
              patchNode({ audienceConnection, playbackMode: nextPlaybackMode });
            }}
          >
            {FABLELOOM_AUDIENCE_CONNECTION_STATES.map((state) => (
              <option key={state} value={state}>
                {state === 'connected' ? 'Connected — audience can help' : 'Disconnected — passive canon only'}
              </option>
            ))}
          </select>
          <p className="text-xs text-port-text-muted mt-1">
            {form.audienceConnection === 'connected'
              ? `The protagonist can hear the audience through ${loom.audienceCommunicationMedium || 'the configured medium'}.`
              : 'The audience watches but cannot choose until the communication medium is activated or restored.'}
          </p>
        </FormField>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-ending">
          <input
            id="loom-node-ending"
            type="checkbox"
            checked={form.isEnding}
            onChange={(e) => {
              setForm((p) => ({ ...p, isEnding: e.target.checked }));
              patchNode({ isEnding: e.target.checked });
            }}
          />
          This scene is an ending
        </label>
      </div>
      {form.isEnding && (
        <FormField label="Ending name" labelClassName={labelClass}>
          <input
            className={fieldClass}
            placeholder="e.g. Treasure found"
            value={form.endingLabel}
            onChange={(e) => setForm((p) => ({ ...p, endingLabel: e.target.value }))}
            onBlur={() => saveField('endingLabel', form.endingLabel)}
          />
        </FormField>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene media</span>
        <LoomSceneMedia
          node={node}
          jobs={mediaJobs}
          onGenerateImage={runGenerateImage}
          onGenerateVideo={runGenerateVideo}
          generationDisabled={aiBlocked || generationDisabled}
          generationDisabledReason={aiBlocked ? 'Wait for scene changes to save' : generationDisabledReason}
        />
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene image prompt</span>
        <textarea
          rows={2}
          className={fieldClass}
          placeholder="Visual description for the image generator"
          aria-label="Image prompt"
          value={form.imagePrompt}
          onChange={(e) => setForm((p) => ({ ...p, imagePrompt: e.target.value }))}
          onBlur={() => saveField('imagePrompt', form.imagePrompt)}
        />
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene video prompt</span>
        <div className="space-y-2">
          <label htmlFor="loom-node-camera-movement" className={labelClass}>Camera movement</label>
          <select
            id="loom-node-camera-movement"
            className={fieldClass}
            value={form.cameraMovement}
            onChange={(e) => {
              setForm((p) => ({ ...p, cameraMovement: e.target.value }));
              patchNode({ cameraMovement: e.target.value });
            }}
          >
            <option value="">Choose a movement</option>
            {form.cameraMovement && !FABLELOOM_CAMERA_MOVEMENTS.some((move) => move.value === form.cameraMovement) && (
              <option value={form.cameraMovement}>{form.cameraMovement} (custom)</option>
            )}
            {FABLELOOM_CAMERA_MOVEMENTS.map((move) => (
              <option key={move.value} value={move.value}>{move.label}</option>
            ))}
          </select>
          <textarea
            rows={3}
            className={fieldClass}
            placeholder="One continuous clip: action, camera move, pace, atmosphere, final beat"
            aria-label="Video prompt"
            value={form.videoPrompt}
            onChange={(e) => setForm((p) => ({ ...p, videoPrompt: e.target.value }))}
            onBlur={() => saveField('videoPrompt', form.videoPrompt)}
          />
          <p className="text-xs text-port-text-muted">Falls back to the scene text when no dedicated video prompt is set.</p>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">
            {form.playbackMode === 'cut' ? 'Next cut' : 'Viewer paths'} ({form.transitions.length})
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={runBranch}
              disabled={branching || aiBlocked || !audienceConnected}
              title={!audienceConnected ? 'Connect the audience communication medium before adding decision branches' : undefined}
              className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              {branching ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              Branch with AI
            </button>
            <button
              type="button"
              onClick={addTransition}
              disabled={addingPath}
              className="text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              + Add path
            </button>
          </div>
        </div>
        {form.isEnding && form.transitions.length > 0 && (
          <p className="text-xs text-port-warning mb-2">Endings never fire their outgoing paths.</p>
        )}
        {!form.isEnding && form.playbackMode === 'cut' && form.transitions.length !== 1 && (
          <p className="text-xs text-port-error mb-2">Automatic cuts need exactly one path to the next cut.</p>
        )}
        <div className="space-y-3">
          {form.transitions.map((tr, index) => (
            <div key={tr.id} className="border border-port-border rounded p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className={fieldClass}
                  placeholder='Reader intent, e.g. "search the wreck"'
                  aria-label="Intent"
                  value={tr.intent}
                  onChange={(e) => applyTransition(index, { intent: e.target.value })}
                  onBlur={() => saveTransition(tr)}
                />
                <button
                  type="button"
                  onClick={() => removeTransition(tr)}
                  className="text-port-text-muted hover:text-port-error shrink-0"
                  aria-label="Remove path"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <select
                className={fieldClass}
                aria-label="Leads to scene"
                value={tr.targetNodeId}
                onChange={(e) => applyTransition(index, { targetNodeId: e.target.value }, { save: true })}
              >
                {otherNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.title || 'Untitled scene'}</option>
                ))}
              </select>
              <input
                className={fieldClass}
                placeholder="Example phrasings, separated by ;"
                aria-label="Trigger phrasings"
                value={tr.triggersText}
                onChange={(e) => applyTransition(index, { triggersText: e.target.value })}
                onBlur={() => saveTransition(tr)}
              />
            </div>
          ))}
          {!form.transitions.length && !form.isEnding && (
            <p className="text-xs text-port-warning">
              No paths out — mark this an ending or add a path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
