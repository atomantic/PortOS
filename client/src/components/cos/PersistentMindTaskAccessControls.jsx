import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const normalizeCapabilities = (value) => ({
  schemaVersion: 1,
  createTasks: value?.createTasks === true,
});

export default function PersistentMindTaskAccessControls({
  capabilities,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const createTasksId = useId();
  const [draft, setDraft] = useState(() => normalizeCapabilities(capabilities));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saving) setDraft(normalizeCapabilities(capabilities));
  }, [capabilities?.schemaVersion, capabilities?.createTasks, saving]);

  const save = async (createTasks) => {
    const previous = draft;
    const next = { ...draft, createTasks };
    setDraft(next);
    setSaving(true);
    onSavingChange?.(true);
    try {
      await api.updateCosConfig({ persistentMindCapabilities: next }, { silent: true });
      onSaved?.(next);
      toast.success(createTasks ? 'Persistent mind task access enabled' : 'Persistent mind task access disabled');
    } catch (error) {
      setDraft(previous);
      toast.error(error.message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={createTasksId} className="text-sm text-port-text">Allow mind to queue CoS agent tasks</label>
          <p className="mt-0.5 text-xs text-port-text-muted">
            Grants the reasoning loop one typed action: create auto-approved internal tasks in isolated worktrees. It cannot edit files or run arbitrary tools directly.
          </p>
        </div>
        <input
          id={createTasksId}
          type="checkbox"
          checked={draft.createTasks}
          disabled={disabled || saving}
          onChange={(event) => save(event.target.checked)}
          className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50"
        />
      </div>
      <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">The mind chooses per task</p>
        <p className="mt-1">Target app · AI provider · model · thinking effort · priority</p>
        <p className="mt-1">Landing gate: code review then merge · merge when CI is green · leave open for human review</p>
      </div>
      <p className="text-xs text-port-text-muted">
        The grant defaults off. Capacity, CoS autonomy, daily budgets, configured review defaults, and CI remain authoritative after a task is queued.
      </p>
    </div>
  );
}
