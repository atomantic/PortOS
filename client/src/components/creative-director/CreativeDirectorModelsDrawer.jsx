import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Save } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import toast from '../ui/Toast';
import { getAiAssignments, updateAiAssignment } from '../../services/api';
import { updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import useVisionModelIds from '../../hooks/useVisionModelIds.js';
import {
  providerDisplayName,
  assignmentProviderOptions,
  assignmentModelOptions,
  assignmentDefaultModel,
  localBackendForProvider,
} from '../../utils/providers.js';

// Creative Director provider/model pins, at either of two scopes:
//
//   scope="global"  — the CD-wide defaults (`settings.creativeDirector.<stage>`),
//                     which every project inherits. Saved through the same
//                     AI Assignments endpoint the global settings table uses.
//   scope="project" — this project's `modelOverrides.<stage>`, overriding the
//                     CD-wide default. A blank stage inherits (shown as a hint).
//
// The server's `resolveStagePin` resolves project override → CD default →
// system default; the inherit hint mirrors that chain for display only.
const STAGES = [
  { key: 'treatment', label: 'Treatment', help: 'Agent that turns the brief into a treatment + scene plan.' },
  { key: 'plan', label: 'Production plan', help: 'Agent that converts a production directive into an executable plan.' },
  {
    key: 'evaluation',
    label: 'Scene evaluation',
    // Spelled out because the provider list here looks "missing" otherwise: this
    // stage is a direct HTTP vision call (sceneEvaluator's `usableApiProvider`
    // requires `type === 'api'`), so agent CLI/TUI providers are not eligible
    // and pinning one would be silently ignored at run time.
    help: 'Vision model that judges each rendered scene. Runs as a direct vision call, so it needs an API provider (Ollama / LM Studio) — agent CLI/TUI providers such as Claude Ollama TUI can\'t serve it.',
  },
];

const assignmentIdFor = (key) => `settings.creativeDirector.${key}`;

// Every draft source (blank / project record / assignments payload) is the same
// shape — one `{ providerId, model }` per stage, blank-normalized — so they
// share one builder. Stable key order is what makes the JSON dirty-compare
// below sound.
const draftsFrom = (pinFor) => Object.fromEntries(STAGES.map(({ key }) => {
  const pin = pinFor(key) || {};
  return [key, { providerId: pin.providerId || '', model: pin.model || '' }];
}));

const blankDrafts = () => draftsFrom(() => null);
const draftsFromProject = (project) => draftsFrom((key) => project?.modelOverrides?.[key]);
const draftsFromAssignments = (assignments) => {
  const byId = Object.fromEntries((assignments || []).map((e) => [e.id, e]));
  return draftsFrom((key) => byId[assignmentIdFor(key)]);
};

export default function CreativeDirectorModelsDrawer({ open, onClose, project, onSaved, scope = 'project' }) {
  const isGlobal = scope === 'global';
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [drafts, setDrafts] = useState(blankDrafts);
  // The persisted values the drafts were seeded from — the dirty check compares
  // against this rather than a live prop, so the detail page's 5s project poll
  // can't flip `dirty` mid-edit, and the global scope (whose baseline arrives
  // async with the assignments fetch) uses the same code path.
  const [baseline, setBaseline] = useState(blankDrafts);
  const [saving, setSaving] = useState(false);
  // Authoritative vision-capable ids from the backends themselves; `null` until
  // fetched, which `assignmentModelOptions` degrades to its id regex for. Gated
  // on `open` — this drawer stays mounted on a closed page. `visionLoaded` gates
  // the "no VLM installed" claim below: the capability scan is slower than the
  // assignments fetch, so `loading===false` with the scan still in flight is the
  // normal first render, and asserting "none found" there would flash the exact
  // empty-picker bug this drawer was fixed for.
  const { idsByProvider: visionIdsByProvider, loaded: visionLoaded } = useVisionModelIds(open);

  const seed = useCallback((next) => { setDrafts(next); setBaseline(next); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await getAiAssignments({ silent: true }).catch((err) => {
      toast.error(`Failed to load providers: ${err.message}`);
      return null;
    });
    if (next) {
      setProviders(next.providers || []);
      setAssignments(next.assignments || []);
      // Global drafts live in the assignments payload, so they can only be
      // seeded once it lands.
      if (isGlobal) seed(draftsFromAssignments(next.assignments));
    }
    setLoading(false);
  }, [isGlobal, seed]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Project drafts come off the record, so re-seed on the open transition or a
  // project swap — NOT on `project` object identity, which the parent's 5s poll
  // mints fresh every tick and would otherwise wipe in-progress edits.
  useEffect(() => {
    if (open && !isGlobal) seed(draftsFromProject(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isGlobal, project?.id]);

  const entryById = useMemo(
    () => Object.fromEntries((assignments || []).map((e) => [e.id, e])),
    [assignments],
  );

  // Both seeds normalize every stage to a stable key order, so a plain JSON
  // compare is a sound dirty check.
  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify(baseline),
    [drafts, baseline],
  );

  const setStage = (key, patch) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  // The inherit-hint text: what a blank project stage resolves to. Reads the
  // CD-wide default off the assignment entry, falling back to the system default.
  const inheritLabel = (entry) => {
    if (!entry?.providerId) return 'system default';
    const name = providerDisplayName(providers, entry.providerId);
    return entry.model ? `${name} · ${entry.model}` : name;
  };

  const saveGlobal = async () => {
    // Only PUT stages that actually changed — each call re-derives the whole
    // assignments payload server-side. There is no multi-stage transaction, so
    // each stage's baseline is advanced the moment ITS PUT lands: if a later
    // stage then fails we bail with the earlier one already recorded as
    // persisted. Otherwise the user could revert that control to its original
    // displayed value, the retry would see it as clean and skip it, and the
    // server would keep the value they just backed out of.
    let latest = null;
    for (const { key, label } of STAGES) {
      const d = drafts[key];
      if (JSON.stringify(d) === JSON.stringify(baseline[key])) continue;
      const next = await updateAiAssignment(
        assignmentIdFor(key),
        { providerId: d.providerId || null, model: d.model || null },
        { silent: true },
      ).catch((err) => {
        toast.error(`Failed to save ${label}: ${err.message}`);
        return null;
      });
      if (!next) return null;
      setBaseline((prev) => ({ ...prev, [key]: d }));
      latest = next;
    }
    return latest;
  };

  const saveProject = async () => {
    // Only send stages that name a provider; a blank provider means "inherit".
    const modelOverrides = {};
    for (const { key } of STAGES) {
      const d = drafts[key];
      if (d?.providerId) modelOverrides[key] = { providerId: d.providerId, ...(d.model ? { model: d.model } : {}) };
    }
    return updateCreativeDirectorProject(project.id, { modelOverrides }, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to save model overrides');
        return null;
      });
  };

  const handleSave = async () => {
    setSaving(true);
    const result = isGlobal ? await saveGlobal() : await saveProject();
    setSaving(false);
    if (!result) return;
    if (isGlobal) {
      setAssignments(result.assignments || []);
      setProviders(result.providers || []);
      setBaseline(drafts);
      onSaved?.(drafts);
      toast.success('Creative Director model defaults saved');
    } else {
      onSaved?.(result.modelOverrides || {});
      toast.success('Project model overrides saved');
    }
    onClose?.();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isGlobal ? 'Creative Director model defaults' : 'AI models for this project'}
      subtitle={isGlobal ? 'Applies to every Creative Director project' : project?.name}
      size="md"
    >
      {loading ? (
        <div className="text-sm text-gray-400">Loading providers…</div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-gray-400">
            {isGlobal ? (
              <>
                Pin the provider + model every Creative Director project uses by default. Leave a
                stage blank to use the <span className="text-gray-300">system default provider</span>.
                An individual project can still override these from its own Models drawer. Also
                editable from{' '}
                <Link to="/settings/ai-assignments" className="text-port-accent hover:underline">AI Assignments</Link>.
              </>
            ) : (
              <>
                Pin the provider + model for each Creative Director stage on this project. Leave a
                stage on <span className="text-gray-300">Inherit</span> to use the{' '}
                <Link to="/creative-director" className="text-port-accent hover:underline">Creative Director default</Link>.
              </>
            )}
          </p>

          {STAGES.map((stage) => {
            const entry = entryById[assignmentIdFor(stage.key)];
            const draft = drafts[stage.key] || { providerId: '', model: '' };
            const providerOptions = assignmentProviderOptions(entry, providers);
            const modelOptions = assignmentModelOptions(entry, providers, draft.providerId, visionIdsByProvider);
            const pinned = !!draft.providerId;
            // Both hints below are about the LOCAL capability scan, so they only
            // apply when the pinned provider is an Ollama / LM Studio backend. A
            // cloud API provider's list is never vision-filtered, so an empty one
            // just means no models are configured on it — "install a VLM" would
            // be the wrong remediation, and the free-text input still works.
            const visionLocal = entry?.modelFilter === 'vision'
              && !!localBackendForProvider(providers.find((p) => p.id === draft.providerId));
            // A vision stage's options are only trustworthy once the capability
            // scan has settled — until then `modelOptions` is regex-only, which
            // is exactly the stale answer that hid the user's VLMs.
            const visionPending = visionLocal && !visionLoaded;
            // Picking a provider seeds its default model, and for a vision stage
            // that seed is only correct once we know what's installed — pick
            // during the scan and the stage is left on a blank pin, which the
            // evaluator resolves to the provider's own (possibly text-only)
            // default. Hold the control rather than seeding from a stale answer.
            const visionUnknown = entry?.modelFilter === 'vision' && !visionLoaded;
            // A local backend with nothing left to offer means no VLM is
            // installed — say so instead of showing a bare text box that reads
            // as a broken dropdown.
            const noVisionModels = pinned && visionLocal && !visionPending && modelOptions.length === 0;
            return (
              <section key={stage.key} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Bot size={15} className="text-port-accent shrink-0" />
                  <h3 className="text-sm font-medium text-white">{stage.label}</h3>
                  {!pinned && !isGlobal && (
                    <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-port-card border border-port-border text-gray-400">
                      Inherit: {inheritLabel(entry)}
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
                      disabled={visionUnknown}
                      onChange={(e) => {
                        const providerId = e.target.value;
                        // Vision-filtered stages (scene evaluation) seed the first
                        // eligible VLM when the provider's default is text-only.
                        const nextDefault = providerId
                          ? assignmentDefaultModel(entry, providers, providerId, visionIdsByProvider)
                          : '';
                        // Seed the provider's default model on switch; clearing the
                        // provider clears the model too.
                        setStage(stage.key, { providerId, model: nextDefault });
                      }}
                      className="bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                    >
                      <option value="">{isGlobal ? 'System default' : 'Inherit default'}</option>
                      {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">Model</span>
                    {!pinned ? (
                      <div className="text-sm text-gray-600 py-2">—</div>
                    ) : visionPending ? (
                      // Hold the slot rather than rendering the free-text
                      // fallback: the scan is about to widen the list, and
                      // swapping an <input> the user may have typed into for a
                      // <select> would drop their text from view.
                      <div className="text-sm text-gray-500 py-2">Checking installed models…</div>
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

                {noVisionModels && (
                  <p className="text-xs text-port-warning">
                    No vision-capable models found on this provider.{' '}
                    <Link to="/settings/local-llm" className="underline hover:text-port-warning/80">Install a VLM</Link>
                    {' '}(e.g. qwen3-vl, gemma4) or type a model id above.
                  </p>
                )}
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
