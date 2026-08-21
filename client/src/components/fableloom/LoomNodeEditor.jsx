/**
 * FableLoom scene editor — the side panel for the selected node: title/prose,
 * ending flag + label, the intent-transition list, the scene image (prompt +
 * queued render via the shared image-gen lane), and the AI branch action.
 *
 * Fields save on blur (silent PATCH, skipped when unchanged; the server
 * returns the full loom, which the parent folds into state). The AI actions
 * read server-side state, so they gate on in-flight saves per the client
 * save-gating convention.
 */

import { useEffect, useMemo, useState } from 'react';
import { GitBranch, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { FormField } from '../ui/FormField.jsx';
import MediaImage from '../MediaImage';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  branchLoomNode, deleteLoomNode, generateImage, updateLoomNode,
} from '../../services/api';
import { fieldClass, labelClass, sceneFieldClass } from './fieldStyles';
import { isTeleplayFormat } from './loomFormats';

const toRow = (t) => ({ ...t, triggersText: (t.triggers || []).join('; ') });
const rowsToTransitions = (rows) => rows
  .filter((t) => t.targetNodeId)
  .map(({ id, targetNodeId, intent, triggersText, description }) => ({
    id, targetNodeId, intent,
    triggers: (triggersText || '').split(';').map((s) => s.trim()).filter(Boolean),
    description: description || '',
  }));

export default function LoomNodeEditor({ loom, episode, node, onLoomUpdate, onClearSelection, onMakeStart }) {
  const [form, setForm] = useState(null);
  // In-flight blur-saves; the AI buttons (which read server-side state) stay
  // disabled until every pending save settles.
  const [pendingSaves, setPendingSaves] = useState(0);
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
      isEnding: !!node.isEnding,
      endingLabel: node.endingLabel || '',
      transitions: (node.transitions || []).map(toRow),
    });
  }, [node.id]);

  const otherNodes = useMemo(
    () => episode.nodes.filter((n) => n.id !== node.id),
    [episode.nodes, node.id],
  );

  const patchNode = async (patch) => {
    setPendingSaves((n) => n + 1);
    const updated = await updateLoomNode(loom.id, episode.id, node.id, patch, { silent: true })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    setPendingSaves((n) => n - 1);
    if (updated) onLoomUpdate(updated);
    return updated;
  };

  // Blur-save helper: skip the round-trip when the value matches the record
  // (tabbing through the panel shouldn't rewrite the loom).
  const saveField = (key, value) => {
    if (value === (node[key] || '')) return null;
    return patchNode({ [key]: value });
  };

  const syncTransitionsFrom = (updatedLoom) => {
    const saved = updatedLoom?.episodes.find((e) => e.id === episode.id)
      ?.nodes.find((n) => n.id === node.id)?.transitions;
    if (!saved) return;
    setForm((prev) => ({ ...prev, transitions: saved.map(toRow) }));
  };

  const saveTransitions = async (rows) => {
    const payload = rowsToTransitions(rows);
    const current = (node.transitions || []).map((t) => ({
      id: t.id, targetNodeId: t.targetNodeId, intent: t.intent, triggers: t.triggers, description: t.description,
    }));
    if (JSON.stringify(payload) === JSON.stringify(current)) return;
    const updated = await patchNode({ transitions: payload });
    // Re-sync just the transition rows so server-minted ids replace the
    // locally-added rows' missing ones (id churn otherwise re-mints per save).
    syncTransitionsFrom(updated);
  };

  // The save fires OUTSIDE the setState updater — StrictMode runs updaters
  // twice, so a PATCH inside one double-fires.
  const applyTransition = (index, patch, { save = false } = {}) => {
    const transitions = form.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t));
    setForm((prev) => ({ ...prev, transitions }));
    if (save) saveTransitions(transitions);
  };

  const removeTransition = (index) => {
    const transitions = form.transitions.filter((_, i) => i !== index);
    setForm((prev) => ({ ...prev, transitions }));
    saveTransitions(transitions);
  };

  const addTransition = () => {
    const target = otherNodes[0];
    if (!target) {
      toast.error('Add another scene first — a path needs somewhere to go');
      return;
    }
    setForm((prev) => ({
      ...prev,
      transitions: [...prev.transitions, { targetNodeId: target.id, intent: '', triggersText: '', description: '' }],
    }));
  };

  const [runBranch, branching] = useAsyncAction(async () => {
    const result = await branchLoomNode(loom.id, episode.id, node.id, { branchCount: 2 }, { silent: true });
    onLoomUpdate(result.loom);
    syncTransitionsFrom(result.loom);
    toast.success('New branches woven');
  }, { errorMessage: 'Branching failed' });

  const [runGenerateImage, rendering] = useAsyncAction(async () => {
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
    await generateImage({
      prompt: loom.styleNotes ? `${prompt}\n\nStyle: ${loom.styleNotes}` : prompt,
      fableLoom: { loomId: loom.id, episodeId: episode.id, nodeId: node.id },
    }, { silent: true });
    toast.success('Scene render queued — it will attach when it completes');
  }, { errorMessage: 'Could not queue the render' });

  const handleDelete = async () => {
    const updated = await deleteLoomNode(loom.id, episode.id, node.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onClearSelection();
    }
  };

  if (!form) return null;
  const aiBlocked = pendingSaves > 0;

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
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">Scene image</span>
          <button
            type="button"
            onClick={runGenerateImage}
            disabled={rendering || aiBlocked}
            className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
          >
            {rendering ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
            Generate
          </button>
        </div>
        <textarea
          rows={2}
          className={fieldClass}
          placeholder="Visual description for the image generator"
          aria-label="Image prompt"
          value={form.imagePrompt}
          onChange={(e) => setForm((p) => ({ ...p, imagePrompt: e.target.value }))}
          onBlur={() => saveField('imagePrompt', form.imagePrompt)}
        />
        {node.image && (
          <MediaImage
            src={`/data/images/${node.image}`}
            alt={form.title || 'Scene render'}
            className="mt-2 rounded max-w-full max-h-48 object-cover"
          />
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">
            Paths out ({form.transitions.length})
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={runBranch}
              disabled={branching || aiBlocked}
              className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              {branching ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              Branch with AI
            </button>
            <button type="button" onClick={addTransition} className="text-xs text-port-accent hover:underline">
              + Add path
            </button>
          </div>
        </div>
        {form.isEnding && form.transitions.length > 0 && (
          <p className="text-xs text-port-warning mb-2">Endings never fire their outgoing paths.</p>
        )}
        <div className="space-y-3">
          {form.transitions.map((tr, index) => (
            <div key={tr.id || `new-${index}`} className="border border-port-border rounded p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className={fieldClass}
                  placeholder='Reader intent, e.g. "search the wreck"'
                  aria-label="Intent"
                  value={tr.intent}
                  onChange={(e) => applyTransition(index, { intent: e.target.value })}
                  onBlur={() => saveTransitions(form.transitions)}
                />
                <button
                  type="button"
                  onClick={() => removeTransition(index)}
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
                onBlur={() => saveTransitions(form.transitions)}
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
