import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const normalizeCapabilities = (value) => ({
  schemaVersion: 2,
  createTasks: value?.createTasks === true,
  readPortos: value?.readPortos === true,
  writePortos: value?.writePortos === true,
});

const OPTIONS = [
  {
    key: 'readPortos',
    label: 'Allow bounded PortOS reads',
    hint: 'Lets the mind inspect the selected Brain, goals, journal, calendar, health, feed, catalog, and runtime adapters.',
  },
  {
    key: 'writePortos',
    label: 'Allow bounded PortOS updates',
    hint: 'Lets the mind use typed Brain, journal, goals, health-log, and feed-state actions. Process control, browser actions, messaging, and paid generation stay excluded.',
  },
  {
    key: 'createTasks',
    label: 'Allow mind to queue CoS agent tasks',
    hint: 'Queues typed tasks through isolated worktrees, capacity, budget, review, CI, and landing-policy gates.',
  },
];

export default function PersistentMindTaskAccessControls({
  capabilities,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState(() => normalizeCapabilities(capabilities));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saving) setDraft(normalizeCapabilities(capabilities));
  }, [capabilities?.schemaVersion, capabilities?.createTasks, capabilities?.readPortos, capabilities?.writePortos, saving]);

  const save = async (key, enabled) => {
    const previous = draft;
    const next = { ...draft, [key]: enabled };
    setDraft(next);
    setSaving(true);
    onSavingChange?.(true);
    try {
      await api.updateCosConfig({ persistentMindCapabilities: next }, { silent: true });
      onSaved?.(next);
      const option = OPTIONS.find((candidate) => candidate.key === key);
      toast.success(`${option?.label || 'Capability'} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      setDraft(previous);
      toast.error(error.message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  return (
    <div className="space-y-4">
      {OPTIONS.map((option) => {
        const id = `${idPrefix}-${option.key}`;
        return (
          <div key={option.key} className="flex items-start justify-between gap-4">
            <div>
              <label htmlFor={id} className="text-sm text-port-text">{option.label}</label>
              <p className="mt-0.5 text-xs text-port-text-muted">{option.hint}</p>
            </div>
            <input
              id={id}
              type="checkbox"
              checked={draft[option.key]}
              disabled={disabled || saving}
              onChange={(event) => save(option.key, event.target.checked)}
              className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50"
            />
          </div>
        );
      })}
      <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">Typed authority only</p>
        <p className="mt-1">Every tool has a closed input schema, explicit side-effect policy, stable request id, and normalized result. Raw PortOS routes are never accepted as tool arguments.</p>
      </div>
      <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">Task landing policy stays authoritative</p>
        <p className="mt-1">A task can run code review then merge, merge when CI is green, or leave open for human review. The selected per-task landing policy is never widened by this grant.</p>
      </div>
      <p className="text-xs text-port-text-muted">
        All grants default off. CoS autonomy, capacity, daily budgets, task review defaults, CI, and the tool-specific validation remain authoritative.
      </p>
    </div>
  );
}
