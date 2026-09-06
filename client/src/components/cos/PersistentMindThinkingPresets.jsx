import { useEffect, useId, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels';
import * as api from '../../services/api';
import { classifyMindRouteBilling, formatMindRoute, mintMindPresetId } from '../../lib/mindThinkingPresets.js';
import MindRouteBadge, { BILLING_TONE } from './MindRouteBadge.jsx';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';

const MAX_PRESETS = 20;
const LABEL_MAX = 80;

const emptyDraft = () => ({ id: null, label: '', providerId: '', model: '', effort: '' });

/**
 * Manage the saved alternates a single Persistent Mind message may borrow.
 *
 * Everything here is inert: the whole list is written through
 * `PATCH /api/cos/config`, which never starts the mind, never resumes a paused
 * one, never infers, and never downloads a model. A list PATCH replaces the
 * whole array by design — there is no way to express "remove one entry" as a
 * merge, and a merge would resurrect a preset the user just deleted.
 *
 * `editingPresetId` is owned by the URL so an open editor is shareable and
 * survives a reload, per the "selection lives in the URL" convention.
 */
export default function PersistentMindThinkingPresets({
  presets = [],
  disabled = false,
  editingPresetId = null,
  onEditPreset,
  onSaved,
  onSavingChange,
}) {
  const labelId = useId();
  const {
    providers,
    availableModels,
    loading: providersLoading,
    setSelectedProviderId,
    setSelectedModel,
  } = useProviderModels({ allowDefault: true, withEffort: true, silent: true });
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const editingPreset = editingPresetId && editingPresetId !== 'new'
    ? presets.find((candidate) => candidate.id === editingPresetId) || null
    : null;

  // The editor's identity comes from the URL, so a deep link opens straight
  // into it and a stale id (a preset deleted in another tab) closes the editor
  // instead of silently editing a different preset.
  //
  // Keyed on the edited preset's own FIELDS rather than on the `presets` array:
  // the caller re-derives that array on every render, so an array dependency
  // would re-run this on every render — and each run replaces the draft object,
  // which re-renders. That is an unbounded loop whenever the parent's fetch has
  // not settled, which is exactly when the panel is first mounted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editingPresetId === null) {
      setDraft(emptyDraft());
      setError(null);
      return;
    }
    if (editingPresetId === 'new') {
      setDraft(emptyDraft());
      setError(null);
      setSelectedProviderId('');
      setSelectedModel('');
      return;
    }
    if (!editingPreset) {
      setError('That preset is no longer saved.');
      setDraft(emptyDraft());
      return;
    }
    setError(null);
    setDraft({ ...editingPreset, label: editingPreset.label || '', effort: editingPreset.effort || '' });
    setSelectedProviderId(editingPreset.providerId);
    setSelectedModel(editingPreset.model);
    // Setter identity is not stable across every host that mocks the provider
    // hook, so this effect describes the SELECTION change only.
  }, [
    editingPresetId,
    editingPreset?.label,
    editingPreset?.providerId,
    editingPreset?.model,
    editingPreset?.effort,
  ]);

  const persist = async (nextPresets, successMessage) => {
    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    try {
      await api.updateCosConfig(
        { persistentMindThinkingPresets: { presets: nextPresets } },
        { silent: true },
      );
      toast.success(successMessage);
      onSaved?.(nextPresets);
      return true;
    } catch (saveError) {
      // The list is the user's authority over which routes exist; a failed write
      // must leave the visible list exactly as the server still has it, never a
      // half-applied local copy that a later send would try to use.
      setError(saveError?.message || 'The preset list was not saved');
      return false;
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving || !draft.providerId || !draft.model) return;
    const isNew = draft.id === null;
    if (isNew && presets.length >= MAX_PRESETS) {
      setError(`Only ${MAX_PRESETS} presets can be saved. Remove one first.`);
      return;
    }
    const label = draft.label.trim().slice(0, LABEL_MAX);
    const id = draft.id || mintMindPresetId(label || `${draft.providerId}-${draft.model}`, presets.map((preset) => preset.id));
    const next = {
      id,
      label: label || formatMindRoute({ providerId: draft.providerId, model: draft.model }),
      providerId: draft.providerId,
      model: draft.model,
      effort: draft.effort || '',
    };
    const nextPresets = isNew
      ? [...presets, next]
      : presets.map((preset) => (preset.id === id ? next : preset));
    if (await persist(nextPresets, isNew ? 'Thinking preset saved' : 'Thinking preset updated')) {
      onEditPreset?.(null);
    }
  };

  const remove = async (preset) => {
    if (saving) return;
    if (await persist(presets.filter((candidate) => candidate.id !== preset.id), 'Thinking preset removed')) {
      if (editingPresetId === preset.id) onEditPreset?.(null);
    }
  };

  const draftProvider = providers.find((provider) => provider.id === draft.providerId) || null;
  const draftBilling = classifyMindRouteBilling(draftProvider);
  const editorOpen = editingPresetId !== null;
  const atCapacity = presets.length >= MAX_PRESETS;

  return (
    <section aria-labelledby="mind-presets-heading" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="mind-presets-heading" className="text-sm font-semibold text-port-text">Thinking presets</h3>
          <p className="mt-1 text-xs text-port-text-muted">
            Saved alternates a single message can borrow for one turn. The mind still wakes on its default profile above — saving or previewing a preset never starts a turn, resumes a paused mind, or downloads a model.
          </p>
        </div>
        {!editorOpen && (
          <button
            type="button"
            onClick={() => onEditPreset?.('new')}
            disabled={disabled || saving || atCapacity}
            className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded border border-port-border px-3 text-sm text-port-text hover:bg-port-border/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" /> Add preset
          </button>
        )}
      </div>

      {error && <p role="alert" className="rounded border border-port-error/40 bg-port-error/10 px-3 py-2 text-xs text-port-error">{error}</p>}

      {presets.length === 0 && !editorOpen ? (
        <p className="rounded border border-dashed border-port-border px-3 py-4 text-center text-xs text-port-text-muted">
          No alternates saved. Add one to unlock &ldquo;Send with another model&rdquo; in the composer.
        </p>
      ) : (
        <ul aria-label="Saved thinking presets" className="space-y-2">
          {presets.map((preset) => {
            const provider = providers.find((candidate) => candidate.id === preset.providerId) || null;
            return (
              <li key={preset.id} className="flex flex-col gap-2 rounded border border-port-border bg-port-bg px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-port-text">{preset.label}</p>
                  <MindRouteBadge route={preset} provider={provider} className="mt-0.5" />
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => onEditPreset?.(preset.id)}
                    disabled={disabled || saving}
                    aria-label={`Edit ${preset.label}`}
                    className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-port-border text-port-text hover:bg-port-border/30 disabled:opacity-50"
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(preset)}
                    disabled={disabled || saving}
                    aria-label={`Remove ${preset.label}`}
                    className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-port-border text-port-error hover:bg-port-error/10 disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editorOpen && (
        <form onSubmit={submit} aria-label={draft.id ? 'Edit thinking preset' : 'Add thinking preset'} className="space-y-3 rounded border border-port-accent/40 bg-port-card p-3">
          <div>
            <label htmlFor={labelId} className="block text-sm font-medium text-port-text">Preset name</label>
            <input
              id={labelId}
              type="text"
              value={draft.label}
              maxLength={LABEL_MAX}
              disabled={disabled || saving}
              onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              placeholder="Deep think"
              className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text disabled:opacity-50"
            />
          </div>
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={draft.providerId}
            selectedModel={draft.model}
            availableModels={availableModels}
            effort={draft.effort}
            loading={providersLoading}
            disabled={disabled || saving}
            emptyProviderOption="Select an AI provider"
            emptyModelOption="Select a model"
            alwaysShowModel
            highlightToolUse
            layout="stacked"
            label="AI provider"
            onProviderChange={(providerId) => {
              setSelectedProviderId(providerId);
              setSelectedModel('');
              setDraft((current) => ({ ...current, providerId, model: '', effort: '' }));
            }}
            onModelChange={(model) => {
              setSelectedModel(model);
              setDraft((current) => ({ ...current, model }));
            }}
            onEffortChange={(effort) => setDraft((current) => ({ ...current, effort }))}
          />
          {draft.providerId && draft.model && (
            <div className={`rounded border px-3 py-2 text-xs ${BILLING_TONE[draftBilling.billing]}`}>
              <p className="font-semibold">{draftBilling.label}</p>
              <p className="mt-0.5">{draftBilling.detail}</p>
            </div>
          )}
          <p className="text-xs text-port-text-muted">
            A preset is an exact route. If its model or effort later disappears, the message that selected it is refused rather than answered on another model.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={disabled || saving || !draft.providerId || !draft.model}
              className="flex min-h-[36px] items-center gap-1.5 rounded bg-port-accent px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={15} aria-hidden="true" /> {saving ? 'Saving…' : draft.id ? 'Save preset' : 'Add preset'}
            </button>
            <button
              type="button"
              onClick={() => onEditPreset?.(null)}
              disabled={saving}
              className="flex min-h-[36px] items-center gap-1.5 rounded border border-port-border px-3 text-sm text-port-text hover:bg-port-border/30 disabled:opacity-50"
            >
              <X size={15} aria-hidden="true" /> Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
