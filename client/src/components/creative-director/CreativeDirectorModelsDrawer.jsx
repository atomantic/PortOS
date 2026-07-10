import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Save } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import toast from '../ui/Toast';
import { getAiAssignments } from '../../services/api';
import { updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import { providerDisplayName, assignmentProviderOptions, assignmentModelOptions } from '../../utils/providers.js';

// Per-project AI model override drawer (per-project CD provider/model pins).
// Lets the user pin the treatment / plan / evaluation stage to a specific
// provider + model ON THIS PROJECT, overriding the global AI Assignment. A
// blank stage inherits the global pin (shown as the "Inherit" hint). The same
// resolution the server does (`resolveStagePin`) is mirrored here only for the
// inherit-hint label — the authoritative resolve happens server-side.

// Each CD cognitive stage maps 1:1 to a global AI Assignment entry keyed
// `settings.creativeDirector.<key>`, so the drawer reads that entry's
// `providerTypes` (which providers are eligible: CLI/TUI for treatment+plan,
// API for evaluation) and its current global provider/model (the inherit hint).
const STAGES = [
  { key: 'treatment', label: 'Treatment', help: 'Agent that turns the brief into a treatment + scene plan.' },
  { key: 'plan', label: 'Production plan', help: 'Agent that converts a production directive into an executable plan.' },
  { key: 'evaluation', label: 'Scene evaluation', help: 'Vision model that judges each rendered scene.' },
];

const assignmentIdFor = (key) => `settings.creativeDirector.${key}`;

// The inherit-hint text: what this stage resolves to when left blank.
const inheritLabel = (entry, providers) => {
  if (!entry?.providerId) return 'system default';
  const name = providerDisplayName(providers, entry.providerId);
  return entry.model ? `${name} · ${entry.model}` : name;
};

const draftsFromProject = (project) => {
  const overrides = project?.modelOverrides || {};
  return Object.fromEntries(STAGES.map(({ key }) => {
    const o = overrides[key] || {};
    return [key, { providerId: o.providerId || '', model: o.model || '' }];
  }));
};

export default function CreativeDirectorModelsDrawer({ open, onClose, project, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [drafts, setDrafts] = useState(() => draftsFromProject(project));
  const [saving, setSaving] = useState(false);

  // Re-seed drafts from the persisted project only on the open transition or a
  // project swap — NOT on `project` object identity, which the parent's 5s poll
  // mints fresh every tick and would otherwise wipe in-progress edits.
  useEffect(() => {
    if (open) setDrafts(draftsFromProject(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await getAiAssignments({ silent: true }).catch((err) => {
      toast.error(`Failed to load providers: ${err.message}`);
      return null;
    });
    if (next) {
      setProviders(next.providers || []);
      setAssignments(next.assignments || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const entryById = useMemo(
    () => Object.fromEntries((assignments || []).map((e) => [e.id, e])),
    [assignments],
  );

  // draftsFromProject normalizes every stage to a stable key order, so a plain
  // JSON compare against the persisted project is a sound dirty check.
  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify(draftsFromProject(project)),
    [drafts, project],
  );

  const setStage = (key, patch) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const handleSave = async () => {
    setSaving(true);
    // Only send stages that name a provider; a blank provider means "inherit".
    const modelOverrides = {};
    for (const { key } of STAGES) {
      const d = drafts[key];
      if (d?.providerId) modelOverrides[key] = { providerId: d.providerId, ...(d.model ? { model: d.model } : {}) };
    }
    const updated = await updateCreativeDirectorProject(project.id, { modelOverrides }, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to save model overrides');
        return null;
      });
    setSaving(false);
    if (!updated) return;
    onSaved?.(updated.modelOverrides || {});
    toast.success('Project model overrides saved');
    onClose?.();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="AI models for this project"
      subtitle={project?.name}
      size="md"
    >
      {loading ? (
        <div className="text-sm text-gray-400">Loading providers…</div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-gray-400">
            Pin the provider + model for each Creative Director stage on this project. Leave a
            stage on <span className="text-gray-300">Inherit</span> to use the global{' '}
            <Link to="/settings/ai-assignments" className="text-port-accent hover:underline">AI Assignment</Link>.
          </p>

          {STAGES.map((stage) => {
            const entry = entryById[assignmentIdFor(stage.key)];
            const draft = drafts[stage.key] || { providerId: '', model: '' };
            const providerOptions = assignmentProviderOptions(entry, providers);
            const modelOptions = assignmentModelOptions(entry, providers, draft.providerId);
            const overriding = !!draft.providerId;
            return (
              <section key={stage.key} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Bot size={15} className="text-port-accent shrink-0" />
                  <h3 className="text-sm font-medium text-white">{stage.label}</h3>
                  {!overriding && (
                    <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-port-card border border-port-border text-gray-400">
                      Inherit: {inheritLabel(entry, providers)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">{stage.help}</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">Provider</span>
                    <select
                      value={draft.providerId}
                      aria-label={`${stage.label} provider`}
                      onChange={(e) => {
                        const providerId = e.target.value;
                        const nextDefault = providers.find((p) => p.id === providerId)?.defaultModel || '';
                        // Seed the provider's default model on switch; clearing the
                        // provider (Inherit) clears the model too.
                        setStage(stage.key, { providerId, model: providerId ? nextDefault : '' });
                      }}
                      className="bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                    >
                      <option value="">Inherit global</option>
                      {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">Model</span>
                    {!overriding ? (
                      <div className="text-sm text-gray-600 py-2">—</div>
                    ) : modelOptions.length > 0 ? (
                      <select
                        value={draft.model}
                        aria-label={`${stage.label} model`}
                        onChange={(e) => setStage(stage.key, { model: e.target.value })}
                        className="bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                      >
                        <option value="">Provider default / auto</option>
                        {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input
                        value={draft.model}
                        aria-label={`${stage.label} model`}
                        onChange={(e) => setStage(stage.key, { model: e.target.value })}
                        placeholder="Provider default / auto"
                        className="bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white placeholder-gray-600"
                      />
                    )}
                  </label>
                </div>
              </section>
            );
          })}

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded text-sm"
            >
              <Save size={14} />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
