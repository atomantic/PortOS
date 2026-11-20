import { useState, useEffect, useCallback } from 'react';
import toast from '../../ui/Toast';
import { updateCosTask } from '../../../services/apiAgents.js';
import { seedModelEffort } from '../../../utils/providers';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';

const getTaskEditData = (task, providers) => {
  const provider = task.metadata?.provider || '';
  // Tasks saved before Antigravity split model from effort carry a suffixed
  // model id (`gemini-3.6-flash-high`). Seed both controls together so editing
  // any other field cannot silently replace that tier with the provider default.
  const seeded = seedModelEffort(
    providers?.find(candidate => candidate.id === provider) || { id: provider },
    task.metadata?.model,
    task.metadata?.effort,
  );
  return {
    description: task.description,
    prompt: task.metadata?.prompt || '',
    context: task.metadata?.context || '',
    model: seeded.model,
    provider,
    effort: seeded.effort,
    executionOptions: task.metadata?.executionOptions,
    // '' = "Any instance" (#4520) — no pin, the opportunistic default.
    targetInstanceId: task.metadata?.targetInstanceId || ''
  };
};

export default function useTaskItemEditor({ task, taskSource, providers, instances, onEditingChange, onRefresh }) {
  const [editing, setEditingInternal] = useState(false);
  const setEditing = useCallback((val) => {
    setEditingInternal(val);
    onEditingChange?.(val);
  }, [onEditingChange]);
  // A task written since the #4153 split keeps its full agent-facing payload in
  // `metadata.prompt` and only a short human note in `metadata.context`. Legacy
  // tasks (and peers still on the old code) have no `prompt` at all — their
  // payload is still in `context` — so the Prompt field is offered ONLY when the
  // task actually carries one, and is omitted from the PATCH otherwise rather
  // than writing an empty `prompt` key onto every task the user edits.
  const hasPromptField = typeof task.metadata?.prompt === 'string';
  // `null` means the registry has not been read yet — distinct from a read that
  // found nothing — so a row never flashes "unknown instance" before the list lands,
  // and the editor never offers a picker built from a list it does not have.
  const registryLoaded = instances !== null;
  const knownInstances = instances || [];
  const targetInstanceId = task.metadata?.targetInstanceId || '';
  // Instance pinning (#4520) is only meaningful once this install federates.
  // Below that the picker is hidden AND the field is withheld from the PATCH, so
  // editing a task here can never silently clear a pin another machine set — with
  // one exception: a task that ALREADY carries a pin always gets the picker, or
  // removing the last peer would leave that pin permanently unclearable and the
  // task unrunnable on every instance.
  const canPinInstance = registryLoaded && (knownInstances.length > 1 || Boolean(targetInstanceId));
  // A pin naming an instance that has left the registry still renders — silently
  // dropping the badge would hide exactly the task nothing will ever run.
  const targetInstanceName = targetInstanceId && registryLoaded
    ? (knownInstances.find(i => i.instanceId === targetInstanceId)?.name || 'unknown instance')
    : '';
  const taskPrompt = task.metadata?.prompt || '';
  const taskContext = task.metadata?.context || '';
  const taskModel = task.metadata?.model || '';
  const taskProvider = task.metadata?.provider || '';
  const taskEffort = task.metadata?.effort || '';
  const savedEditData = getTaskEditData(task, providers);
  const [editData, setEditData] = useState(() => savedEditData);
  // Discarding edits has its own confirm state, separate from deleting the task.
  const { isConfirming: isConfirmingDiscard, requestDelete: requestDiscardConfirm, cancelDelete: cancelDiscardConfirm, confirmDelete: confirmDiscard } = useConfirmDelete();

  // Queue refreshes can replace a legacy task with its split form while this
  // component stays mounted under the same task id. Keep the draft current
  // whenever it is safe to do so, but never overwrite an active edit.
  useEffect(() => {
    if (!editing) setEditData(getTaskEditData(task, providers));
  }, [editing, task.id, task.description, taskPrompt, taskContext, taskModel, taskProvider, taskEffort, task, providers]);

  const handleSave = async () => {
    const { prompt, targetInstanceId: draftInstanceId, ...rest } = editData;
    const payload = {
      ...rest,
      type: taskSource,
      ...(hasPromptField ? { prompt } : {}),
      // '' is the picker's "Any instance" → null, the explicit unpin the update
      // schema preserves (absent would leave the pin untouched).
      ...(canPinInstance ? { targetInstanceId: draftInstanceId || null } : {})
    };
    const result = await updateCosTask(task.id, payload, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task updated');
    setEditing(false);
    onRefresh();
  };

  // Compares the draft against the same task fields editData was seeded from
  // (see the useState initializer above) — true only when the user actually
  // changed something, so an unmodified Cancel still discards with no friction.
  const hasUnsavedEdits =
    editData.description !== savedEditData.description ||
    (hasPromptField && editData.prompt !== savedEditData.prompt) ||
    editData.context !== savedEditData.context ||
    editData.model !== savedEditData.model ||
    editData.provider !== savedEditData.provider ||
    editData.effort !== savedEditData.effort ||
    JSON.stringify(editData.executionOptions) !== JSON.stringify(savedEditData.executionOptions) ||
    editData.targetInstanceId !== savedEditData.targetInstanceId;

  const handleCancelEdit = () => {
    if (hasUnsavedEdits) {
      requestDiscardConfirm(task.id);
    } else {
      setEditing(false);
    }
  };

  // Discarding must actually revert the draft, not just hide it — without this,
  // reopening Edit after a confirmed discard would show the just-discarded text
  // again instead of the task's real values.
  const handleConfirmDiscard = () => {
    confirmDiscard(() => {
      setEditData(getTaskEditData(task, providers));
      setEditing(false);
    });
  };

  return {
    editing, setEditing, hasPromptField, canPinInstance, knownInstances, targetInstanceId, targetInstanceName,
    taskModel, taskProvider, taskEffort, editData, setEditData, isConfirmingDiscard,
    handleConfirmDiscard, cancelDiscardConfirm, handleSave, handleCancelEdit,
  };
}
