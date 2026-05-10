/**
 * Pipeline — Series detail page.
 *
 * Edit the series bible (name, logline, premise, worldId, styleNotes,
 * targetFormat, characters) and manage child issues/episodes.
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Save, Trash2, Loader2, ChevronRight, Workflow as WorkflowIcon, Globe,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getPipelineSeries, updatePipelineSeries,
  listPipelineIssues, createPipelineIssue, deletePipelineIssue,
  listWorlds,
  PIPELINE_TARGET_FORMATS,
} from '../services/api';

const STATUS_COLORS = {
  draft: 'text-gray-400 bg-gray-700/30',
  running: 'text-port-accent bg-port-accent/10',
  'needs-review': 'text-port-warning bg-port-warning/10',
  shipped: 'text-port-success bg-port-success/10',
};

export default function PipelineSeries() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [worlds, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState('');
  const [armedIssueId, setArmedIssueId] = useState(null);

  useEffect(() => {
    let canceled = false;
    Promise.all([
      getPipelineSeries(seriesId),
      listPipelineIssues(seriesId),
      listWorlds().catch(() => []),
    ])
      .then(([s, is, ws]) => {
        if (canceled) return;
        setSeries(s);
        setIssues(Array.isArray(is) ? is : []);
        setWorlds(Array.isArray(ws) ? ws : []);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load series');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  const patchSeries = (patch) => setSeries((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    if (!series) return;
    setSaving(true);
    const updated = await updatePipelineSeries(series.id, {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      worldId: series.worldId || null,
      styleNotes: series.styleNotes,
      targetFormat: series.targetFormat,
      issueCountTarget: series.issueCountTarget,
      characters: series.characters,
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (updated) {
      setSeries(updated);
      toast.success('Series saved');
    }
  };

  const handleAddCharacter = () => {
    patchSeries({ characters: [...(series.characters || []), { name: '', description: '' }] });
  };
  const handleUpdateCharacter = (i, patch) => {
    const next = [...series.characters];
    next[i] = { ...next[i], ...patch };
    patchSeries({ characters: next });
  };
  const handleRemoveCharacter = (i) => {
    patchSeries({ characters: series.characters.filter((_, j) => j !== i) });
  };

  const handleCreateIssue = async (e) => {
    e?.preventDefault();
    const title = newIssueTitle.trim();
    if (!title) return;
    const created = await createPipelineIssue(seriesId, { title }).catch((err) => {
      toast.error(err.message || 'Failed to create issue');
      return null;
    });
    if (!created) return;
    setIssues((prev) => [...prev, created]);
    setNewIssueTitle('');
    toast.success(`Created "${created.title}"`);
    navigate(`/pipeline/issues/${created.id}/idea`);
  };

  const handleDeleteIssue = async (iss) => {
    if (armedIssueId !== iss.id) {
      setArmedIssueId(iss.id);
      return;
    }
    setArmedIssueId(null);
    const prior = issues;
    setIssues((prev) => prev.filter((i) => i.id !== iss.id));
    await deletePipelineIssue(iss.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setIssues(prior);
    });
  };

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading series…</div>;
  if (!series) return null;

  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/pipeline" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <ArrowLeft size={14} /> All Series
        </Link>
        <WorkflowIcon className="w-5 h-5 text-port-accent ml-2" />
        <h1 className="text-xl font-bold text-white truncate">{series.name || 'Untitled series'}</h1>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save series
        </button>
      </div>

      <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Bible</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Name">
            <input
              value={series.name || ''}
              onChange={(e) => patchSeries({ name: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              maxLength={200}
            />
          </Field>
          <Field label="Target format">
            <select
              value={series.targetFormat || 'comic+tv'}
              onChange={(e) => patchSeries({ targetFormat: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              {PIPELINE_TARGET_FORMATS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </Field>
          <Field label="Logline">
            <input
              value={series.logline || ''}
              onChange={(e) => patchSeries({ logline: e.target.value })}
              placeholder="One-sentence pitch"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              maxLength={500}
            />
          </Field>
          <Field label="Target issue count">
            <input
              type="number"
              min={0}
              max={999}
              value={series.issueCountTarget || 0}
              onChange={(e) => patchSeries({ issueCountTarget: parseInt(e.target.value, 10) || 0 })}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
          </Field>
        </div>

        <Field label="Premise (the bible — fed into every stage's prompt context)">
          <textarea
            value={series.premise || ''}
            onChange={(e) => patchSeries({ premise: e.target.value })}
            rows={5}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            maxLength={8000}
            placeholder="Longer free-form premise. World, tone, central conflict, hooks. Fed verbatim into every issue's stage prompts."
          />
        </Field>

        <Field label="Style notes (tonal / visual)">
          <textarea
            value={series.styleNotes || ''}
            onChange={(e) => patchSeries({ styleNotes: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            maxLength={4000}
            placeholder="moebius linework, washed sepia, slow zooms, ambient drones. Reused as the visual prefix for every image-gen call from this series."
          />
        </Field>

        <Field label="Linked World (from World Builder)">
          <div className="flex items-center gap-2">
            <select
              value={series.worldId || ''}
              onChange={(e) => patchSeries({ worldId: e.target.value || null })}
              className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="">— None —</option>
              {worlds.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <Link
              to={series.worldId ? `/world-builder` : '/world-builder'}
              className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
            >
              <Globe size={12} />
              {series.worldId ? 'Open World Builder' : 'Create a world'}
            </Link>
          </div>
        </Field>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wider text-gray-500">Characters</h3>
            <button
              type="button"
              onClick={handleAddCharacter}
              className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
            >
              <Plus size={12} /> Add character
            </button>
          </div>
          {(series.characters || []).length === 0 ? (
            <p className="text-xs text-gray-600 italic">No characters yet — the bible has more bite once a few are defined.</p>
          ) : (
            <ul className="space-y-2">
              {series.characters.map((c, i) => (
                <li key={i} className="flex gap-2 items-start">
                  <input
                    value={c.name}
                    onChange={(e) => handleUpdateCharacter(i, { name: e.target.value })}
                    placeholder="Name"
                    className="w-44 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                    maxLength={200}
                  />
                  <input
                    value={c.description}
                    onChange={(e) => handleUpdateCharacter(i, { description: e.target.value })}
                    placeholder="Physical description + role (e.g. weathered foundry surveyor, 50s, slate-grey hair)"
                    className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                    maxLength={2000}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveCharacter(i)}
                    className="text-gray-500 hover:text-port-error p-2"
                    aria-label="Remove character"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-white">Issues / Episodes</h2>
          <form onSubmit={handleCreateIssue} className="flex items-center gap-2">
            <input
              value={newIssueTitle}
              onChange={(e) => setNewIssueTitle(e.target.value)}
              placeholder="Issue title…"
              className="w-56 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              maxLength={300}
            />
            <button
              type="submit"
              disabled={!newIssueTitle.trim()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-40"
            >
              <Plus size={14} /> New issue
            </button>
          </form>
        </div>
        {issues.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No issues yet. Create the first one to start the pipeline.</p>
        ) : (
          <ul className="space-y-2">
            {issues.map((iss) => (
              <li key={iss.id} className="flex items-center justify-between gap-3 p-3 bg-port-card border border-port-border rounded-lg hover:border-port-accent/40">
                <Link to={`/pipeline/issues/${iss.id}/idea`} className="flex items-center gap-3 flex-1 min-w-0">
                  <span className="text-xs text-gray-500 w-10 shrink-0">#{iss.number}</span>
                  <span className="text-white truncate">{iss.title}</span>
                  <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${STATUS_COLORS[iss.status] || STATUS_COLORS.draft}`}>
                    {iss.status}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => handleDeleteIssue(iss)}
                  className={`p-2 ${armedIssueId === iss.id ? 'text-port-error' : 'text-gray-500 hover:text-port-error'}`}
                  aria-label={armedIssueId === iss.id ? `Confirm delete issue ${iss.title}` : `Delete issue ${iss.title}`}
                  title={armedIssueId === iss.id ? 'Click again to confirm' : 'Delete issue'}
                >
                  <Trash2 size={14} />
                </button>
                <ChevronRight size={14} className="text-gray-600" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
