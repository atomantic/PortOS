import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const normalizeCapabilities = (value) => ({
  schemaVersion: 3,
  createTasks: value?.createTasks === true,
  manageMind: value?.manageMind === true,
  readPortos: value?.readPortos === true,
  writePortos: value?.writePortos === true,
  taskModelAllowlist: Array.isArray(value?.taskModelAllowlist)
    ? value.taskModelAllowlist.map(({ providerId, model }) => ({ providerId, model }))
    : [],
  ...(value?.taskModelAllowlistInvalid === true ? { taskModelAllowlistInvalid: true } : {}),
  ...(Array.isArray(value?.allowedAppIds) ? { allowedAppIds: [...new Set(value.allowedAppIds)] } : {}),
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
  {
    key: 'manageMind',
    label: 'Allow mind to clean up its mindspace',
    hint: 'Lets the mind archive only its own memories, forget older trajectory history, or rebuild derived context. Cleanup remains bounded and auditable.',
  },
];

export default function PersistentMindTaskAccessControls({
  capabilities,
  taskCatalog,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState(() => normalizeCapabilities(capabilities));
  const [saving, setSaving] = useState(false);
  const taskApps = Array.isArray(taskCatalog?.apps) ? taskCatalog.apps : [];
  const allowedAppIds = Array.isArray(draft.allowedAppIds) ? draft.allowedAppIds : null;

  useEffect(() => {
    if (!saving) setDraft(normalizeCapabilities(capabilities));
  }, [capabilities?.schemaVersion, capabilities?.createTasks, capabilities?.manageMind, capabilities?.readPortos, capabilities?.writePortos, capabilities?.taskModelAllowlist, capabilities?.taskModelAllowlistInvalid, capabilities?.allowedAppIds?.join('\0'), saving]);

  const save = async (key, enabled) => {
    const previous = draft;
    const next = { ...draft, [key]: enabled };
    const payload = { ...next };
    delete payload.taskModelAllowlistInvalid;
    if (draft.taskModelAllowlistInvalid) delete payload.taskModelAllowlist;
    setDraft(next);
    setSaving(true);
    onSavingChange?.(true);
    try {
      await api.updateCosConfig({ persistentMindCapabilities: payload }, { silent: true });
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

  const saveAllowedAppIds = async (appId, enabled) => {
    const current = allowedAppIds || taskApps.map((app) => app.id);
    const next = enabled
      ? [...new Set([...current, appId])]
      : current.filter((id) => id !== appId);
    const previous = draft;
    const nextCapabilities = { ...draft, allowedAppIds: next };
    delete nextCapabilities.taskModelAllowlistInvalid;
    if (draft.taskModelAllowlistInvalid) delete nextCapabilities.taskModelAllowlist;
    setDraft(nextCapabilities);
    setSaving(true);
    onSavingChange?.(true);
    try {
      await api.updateCosConfig({ persistentMindCapabilities: nextCapabilities }, { silent: true });
      onSaved?.(nextCapabilities);
      toast.success(`${taskApps.find((app) => app.id === appId)?.name || 'Managed app'} task access ${enabled ? 'enabled' : 'disabled'}`);
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
      {taskCatalog && (
        <div className="border-t border-port-border pt-4">
          <div>
            <p className="text-sm text-port-text">Managed app access</p>
            <p className="mt-0.5 text-xs text-port-text-muted">Choose which configured apps the task grant may target. Existing installs start with every runnable app allowed.</p>
          </div>
          {taskApps.length > 0 ? (
            <div className="mt-3 space-y-3">
              {taskApps.map((app) => {
                const id = `${idPrefix}-app-${app.id}`;
                const checked = allowedAppIds ? allowedAppIds.includes(app.id) : app.granted !== false;
                return (
                  <div key={app.id} className="flex items-start justify-between gap-4">
                    <div>
                      <label htmlFor={id} className="text-sm text-port-text">{app.name}</label>
                      <p className="mt-0.5 text-xs text-port-text-muted">{app.planOnly ? 'Implementation or Plan & File Issue' : 'Implementation delivery'}</p>
                    </div>
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || saving || !draft.createTasks}
                      onChange={(event) => saveAllowedAppIds(app.id, event.target.checked)}
                      className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50"
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 rounded border border-dashed border-port-border p-3 text-xs text-port-text-muted">No runnable managed apps are currently configured.</p>
          )}
          {!draft.createTasks && <p className="mt-3 text-xs text-port-text-muted">Enable the task capability above before selecting managed apps.</p>}
        </div>
      )}
      <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">Typed authority only</p>
        <p className="mt-1">Every tool has a closed input schema, explicit side-effect policy, stable request id, and normalized result. Raw PortOS routes are never accepted as tool arguments.</p>
      </div>
      <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">Task landing policy stays authoritative</p>
        <p className="mt-1">A task can run code review then merge, merge when CI is green, or leave open for human review. The selected per-task landing policy is never widened by this grant.</p>
      </div>
      <p className="text-xs text-port-text-muted">
        An empty model list allows every currently configured coding model. Add exact provider/model pairs below to restrict task creation to a subscription or local-only lane.
      </p>
      <p className="text-xs text-port-text-muted">
        All grants default off. CoS autonomy, capacity, daily budgets, task review defaults, CI, and the tool-specific validation remain authoritative.
      </p>
    </div>
  );
}
