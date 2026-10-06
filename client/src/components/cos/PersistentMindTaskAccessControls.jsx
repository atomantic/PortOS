import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const normalizeCapabilities = (value) => ({
  schemaVersion: 12,
  createTasks: value?.createTasks === true,
  fileIssues: value?.fileIssues === true,
  auditReports: value?.auditReports === true,
  manageMind: value?.manageMind === true,
  manageToolRecipes: value?.manageToolRecipes === true,
  manageEidoverse: value?.manageEidoverse === true,
  visitEidoversePeers: value?.visitEidoversePeers === true,
  promoteEidoverseFoundations: value?.promoteEidoverseFoundations === true,
  installEidoverseControllers: value?.installEidoverseControllers === true,
  callUser: value?.callUser === true,
  adjustLocalContext: value?.adjustLocalContext === true,
  readPortos: value?.readPortos === true,
  writePortos: value?.writePortos === true,
  taskModelAllowlist: Array.isArray(value?.taskModelAllowlist)
    ? value.taskModelAllowlist.map(({ providerId, model }) => ({ providerId, model }))
    : [],
  ...(value?.taskModelAllowlistInvalid === true ? { taskModelAllowlistInvalid: true } : {}),
  ...(Array.isArray(value?.allowedAppIds) ? { allowedAppIds: [...new Set(value.allowedAppIds)] } : {}),
});

const OPTIONS = [
  { group: 'work', key: 'createTasks', label: 'Allow mind to queue CoS agent tasks', hint: 'Queue a task on an authorized app. Budget, review, CI, and landing policy still apply. Model choice is the allowlist below, or every configured coding model when that list is empty.' },
  { group: 'work', key: 'fileIssues', label: 'Allow mind to read and file GitHub/GitLab issues', hint: 'Read and file issues on authorized trackers. No edits, comments, or closes.' },
  { group: 'work', key: 'auditReports', label: 'Allow private CoS process audits', hint: 'Review up to three finished jobs per turn. Filing a finding needs the issue grant.' },
  { group: 'work', key: 'manageToolRecipes', label: 'Allow mind to manage saved tool recipes', hint: 'Lets the mind edit recipes. You can edit the library with this off. Reads still need their own grants.' },
  { group: 'records', key: 'readPortos', label: 'Allow bounded PortOS reads', hint: 'Brain, goals, journal, calendar, health, feed, catalog, and runtime.' },
  { group: 'records', key: 'writePortos', label: 'Allow bounded PortOS updates', hint: 'Typed updates to Brain, journal, goals, health logs, and feed state.' },
  { group: 'records', key: 'manageMind', label: 'Allow mind to clean up its mindspace', hint: 'Archive its own memories, trim history, or rebuild context.' },
  { group: 'records', key: 'adjustLocalContext', label: 'Allow mind to adjust local model context (numCtx)', hint: 'Change this mind\'s local context window inside RAM and GPU limits.' },
  { group: 'records', key: 'callUser', label: 'Allow mind to call you on FaceTime Audio', hint: 'Calls the handle in Settings → Voice. Quiet hours apply, at most 3 calls per day.' },
  { group: 'world', key: 'manageEidoverse', label: 'Allow private Eidoverse world management', hint: 'Build and speak in this install\'s private world.' },
  { group: 'world', key: 'visitEidoversePeers', label: 'Allow guest travel and chat with federated worlds', hint: 'Visit enabled peers and chat. Private records stay on this install.' },
  { group: 'world', key: 'promoteEidoverseFoundations', label: 'Allow promoting Eidoverse foundations to the shared baseline', hint: 'Offer a foundation this install authored. The server rechecks it before it is shared.' },
  { group: 'world', key: 'installEidoverseControllers', label: 'Allow installing executable world controllers', hint: 'Run a controller PortOS already ships. It cannot call a provider or the network.' },
];

const GROUPS = [
  { id: 'work', title: 'Work' },
  { id: 'records', title: 'Records and reach' },
  { id: 'world', title: 'Eidoverse' },
];

/** What each grant can actually do with one managed app, for its row's sub-label. */
const managedAppLanes = (app) => [
  app.planOnly ? 'Implementation or Plan & File Issue' : 'Implementation delivery',
  app.forge ? `Issue filing (${app.forge})` : 'No forge tracker — issues cannot be filed',
].join(' · ');

export default function PersistentMindTaskAccessControls({
  capabilities,
  // The server's single roster: every runnable app, forge-tracked or not, so
  // narrowing the shared allowlist here can never silently revoke an app one
  // grant needs because the other grant could not see it.
  managedApps,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState(() => normalizeCapabilities(capabilities));
  const [saving, setSaving] = useState(false);
  const apps = Array.isArray(managedApps) ? managedApps : [];
  const allowedAppIds = Array.isArray(draft.allowedAppIds) ? draft.allowedAppIds : null;

  useEffect(() => {
    if (!saving) setDraft(normalizeCapabilities(capabilities));
  }, [capabilities?.schemaVersion, capabilities?.createTasks, capabilities?.fileIssues, capabilities?.auditReports, capabilities?.manageMind, capabilities?.manageToolRecipes, capabilities?.manageEidoverse, capabilities?.visitEidoversePeers, capabilities?.callUser, capabilities?.adjustLocalContext, capabilities?.readPortos, capabilities?.writePortos, capabilities?.taskModelAllowlist, capabilities?.taskModelAllowlistInvalid, capabilities?.allowedAppIds?.join('\0'), saving]);

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
      onSaved?.({ ...capabilities, ...next });
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
    const current = allowedAppIds || apps.map((app) => app.id);
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
      toast.success(`${apps.find((app) => app.id === appId)?.name || 'Managed app'} access ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      setDraft(previous);
      toast.error(error.message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  return (
    <div className="space-y-5">
      {GROUPS.map((group) => (
        <div key={group.id} className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">{group.title}</h3>
          {OPTIONS.filter((option) => option.group === group.id).map((option) => {
            const id = `${idPrefix}-${option.key}`;
            return (
              <div key={option.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <label htmlFor={id} className="text-sm text-port-text">{option.label}</label>
                  <p className="mt-0.5 text-xs text-port-text-muted">{option.hint}</p>
                </div>
                <input
                  id={id}
                  type="checkbox"
                  checked={draft[option.key]}
                  disabled={disabled || saving}
                  onChange={(event) => save(option.key, event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-port-accent disabled:opacity-50"
                />
              </div>
            );
          })}
        </div>
      ))}
      {managedApps && (
        <div className="border-t border-port-border pt-4">
          <p className="text-sm text-port-text">Managed app access</p>
          <p className="mt-0.5 text-xs text-port-text-muted">Apps the task and issue grants may use. Existing installs start with every runnable app allowed.</p>
          {apps.length > 0 ? (
            <div className="mt-3 space-y-3">
              {apps.map((app) => {
                const id = `${idPrefix}-app-${app.id}`;
                const checked = allowedAppIds ? allowedAppIds.includes(app.id) : app.granted !== false;
                return (
                  <div key={app.id} className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <label htmlFor={id} className="text-sm text-port-text">{app.name}</label>
                      <p className="mt-0.5 text-xs text-port-text-muted">
                        {managedAppLanes(app)}
                        {' · '}
                        <Link to={`/apps/${encodeURIComponent(app.id)}/automation`} aria-label={`${app.name} automation`} className="text-port-accent hover:underline">Automation</Link>
                      </p>
                    </div>
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || saving || (!draft.createTasks && !draft.fileIssues)}
                      onChange={(event) => saveAllowedAppIds(app.id, event.target.checked)}
                      className="mt-1 h-4 w-4 shrink-0 accent-port-accent disabled:opacity-50"
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 rounded border border-dashed border-port-border p-3 text-xs text-port-text-muted">No runnable managed apps are currently configured.</p>
          )}
          {!draft.createTasks && !draft.fileIssues && <p className="mt-3 text-xs text-port-text-muted">Turn on task queueing or issue filing before changing this list.</p>}
        </div>
      )}
    </div>
  );
}
