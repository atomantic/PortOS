/**
 * Pipeline page — series index.
 *
 * Lists existing production series and lets the user create new ones. Each
 * series is the long-lived parent for a set of issues/episodes that share a
 * bible (logline, premise, characters, world ref, style). Clicking a series
 * drills into its detail page where issues are created and managed.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Workflow as WorkflowIcon, Trash2, Loader2, Globe2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import ShareToButton from '../components/sharing/ShareToButton';
import OriginBadge from '../components/sharing/OriginBadge';
import {
  listPipelineSeries,
  createPipelineSeries,
  deletePipelineSeries,
  generateSeriesTitleLogo,
  listUniverses,
  SERIES_AUTHOR_MAX,
  WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX,
  WORLD_STYLE_NOTES_MAX,
} from '../services/api';
import { ArcShapePicker, ArcShapeSparkline, getStoryShape } from '../components/pipeline/StoryShapes';

const emptyForm = () => ({
  name: '',
  universeId: '',
  logline: '',
  premise: '',
  styleNotes: '',
  author: '',
  shape: null,
  issueCountTarget: '',
});

export default function Pipeline() {
  const [series, setSeries] = useState([]);
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    Promise.all([
      listPipelineSeries().catch(() => []),
      // Universes are optional — failing the fetch should still let the user
      // create a series without one. Surface the error as a quiet toast.
      listUniverses().catch((err) => {
        toast.error(err.message || 'Failed to load universes');
        return [];
      }),
    ]).then(([s, w]) => {
      setSeries(Array.isArray(s) ? s : []);
      setWorlds(Array.isArray(w) ? w : []);
      setLoading(false);
    });
  }, []);

  // Pull logline/premise/styleNotes from the selected world. Only overwrites
  // form fields that are currently empty so a user who's already typed a
  // logline doesn't lose it when they pick a world afterwards.
  const BIBLE_FIELDS = ['logline', 'premise', 'styleNotes'];
  const handleWorldChange = (universeId) => {
    if (!universeId) {
      setForm((f) => ({ ...f, universeId: '' }));
      return;
    }
    const w = universes.find((x) => x.id === universeId);
    if (!w) {
      setForm((f) => ({ ...f, universeId }));
      return;
    }
    setForm((f) => {
      const next = { ...f, universeId };
      for (const k of BIBLE_FIELDS) {
        if (!f[k].trim()) next[k] = w[k] || '';
      }
      return next;
    });
  };

  const handleCreate = async (e) => {
    e?.preventDefault();
    const name = form.name.trim();
    if (!name) {
      toast.error('Series name is required');
      return;
    }
    if (!form.universeId) {
      toast.error('Pick a universe — series must be linked to one');
      return;
    }
    setCreating(true);
    const target = parseInt(form.issueCountTarget, 10);
    const created = await createPipelineSeries({
      name,
      logline: form.logline.trim(),
      premise: form.premise.trim(),
      styleNotes: form.styleNotes.trim(),
      author: form.author.trim(),
      universeId: form.universeId,
      issueCountTarget: Number.isFinite(target) && target > 0 ? target : undefined,
      arc: form.shape ? { shape: form.shape } : undefined,
    }).catch((err) => {
      toast.error(err.message || 'Failed to create series');
      return null;
    });
    setCreating(false);
    if (!created) return;
    // Reactive insert — no full refetch (CLAUDE.md convention).
    setSeries((prev) => [created, ...prev]);
    setForm(emptyForm());
    setShowForm(false);
    toast.success(`Created "${created.name}"`);
    // Fire-and-forget logo design when a universe is linked — the LLM brief
    // needs universe influences + style notes, and gating creation on a multi-
    // second call would feel slow. User can retry from the bible sidebar.
    if (created.universeId && !created.titleLogo) {
      generateSeriesTitleLogo(created.id, {}, { silent: true })
        .then(({ series: updated }) => {
          setSeries((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        })
        .catch(() => {});
    }
  };

  // Two-click delete: first click "arms" the row, second click fires. Avoids
  // window.confirm (banned per CLAUDE.md) without pulling in a modal for the
  // skeleton. armedId resets on any other click.
  const [armedId, setArmedId] = useState(null);
  const handleDelete = async (s) => {
    if (armedId !== s.id) {
      setArmedId(s.id);
      return;
    }
    setArmedId(null);
    const prior = series;
    setSeries((prev) => prev.filter((x) => x.id !== s.id));
    await deletePipelineSeries(s.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setSeries(prior);
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <WorkflowIcon className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Series Pipeline</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
        >
          <Plus size={16} aria-hidden="true" />
          New Series
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Each series carries a shared bible — logline, premise, characters, style, optional World — that
        every issue/episode below inherits into its stage prompts. Pipeline runs an idea seed through prose →
        comic script + teleplay (text), and hands off to image gen / Creative Director for the visual stages.
      </p>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_240px] gap-3">
            <div>
              <label htmlFor="series-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Name
              </label>
              <input
                id="series-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Salt Run"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                maxLength={200}
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="series-world" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                <span className="inline-flex items-center gap-1"><Globe2 size={12} /> Universe (required)</span>
              </label>
              <select
                id="series-world"
                value={form.universeId}
                onChange={(e) => handleWorldChange(e.target.value)}
                required
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                <option value="">— Pick a universe —</option>
                {universes.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-500 mt-1">
                {form.universeId
                  ? 'Logline / premise / style notes pulled from the universe — edit below.'
                  : universes.length === 0
                    ? 'No universes yet. Build one in Media Gen → Universe Builder before creating a series.'
                    : 'Series carry style + canon from their universe — pick one to continue.'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_240px] gap-3">
            <div>
              <label htmlFor="series-logline" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Logline
              </label>
              <input
                id="series-logline"
                type="text"
                value={form.logline}
                onChange={(e) => setForm((f) => ({ ...f, logline: e.target.value }))}
                placeholder="A foundry city goes silent — and the only survivor is a child."
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                maxLength={WORLD_LOGLINE_MAX}
              />
            </div>
            <div>
              <label htmlFor="series-author" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Author (cover byline)
              </label>
              <input
                id="series-author"
                type="text"
                value={form.author}
                onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
                placeholder="Jane Doe"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                maxLength={SERIES_AUTHOR_MAX}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3 items-start">
            <ArcShapePicker
              value={form.shape}
              onChange={(shape) => setForm((f) => ({ ...f, shape }))}
            />
            <div>
              <label htmlFor="series-issue-count" className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
                Story size (issues / episodes)
              </label>
              <input
                id="series-issue-count"
                type="number"
                value={form.issueCountTarget}
                onChange={(e) => setForm((f) => ({ ...f, issueCountTarget: e.target.value }))}
                placeholder="e.g. 12"
                min={0}
                max={999}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Target count across the whole arc — guides issue/episode planning.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="series-premise" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Premise
              </label>
              <textarea
                id="series-premise"
                value={form.premise}
                onChange={(e) => setForm((f) => ({ ...f, premise: e.target.value }))}
                placeholder="Elevator pitch — setting, central conflict, stakes, tone."
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                rows={5}
                maxLength={WORLD_PREMISE_MAX}
              />
            </div>
            <div>
              <label htmlFor="series-style-notes" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Style notes
              </label>
              <textarea
                id="series-style-notes"
                value={form.styleNotes}
                onChange={(e) => setForm((f) => ({ ...f, styleNotes: e.target.value }))}
                placeholder="Visual / tonal references, mood, pacing, voice."
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                rows={5}
                maxLength={WORLD_STYLE_NOTES_MAX}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating || !form.universeId || !form.name.trim()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
              title={!form.universeId ? 'Pick a universe to create the series' : undefined}
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-3 py-2 rounded-lg text-gray-400 hover:text-white text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading series…</div>
      ) : series.length === 0 ? (
        <div className="text-gray-500 text-sm">No series yet. Click <span className="text-port-accent">New Series</span> to start.</div>
      ) : (
        <ul className="space-y-2">
          {series.map((s) => {
            const shapeDef = s.arc?.shape ? getStoryShape(s.arc.shape) : null;
            return (
            <li key={s.id} className="flex items-start justify-between gap-3 p-3 bg-port-card border border-port-border rounded-lg hover:border-port-accent/40 transition-colors">
              <Link to={`/pipeline/series/${s.id}`} className="flex-1 min-w-0">
                <div className="text-white font-medium flex items-center gap-2 flex-wrap">
                  <span>{s.name}</span>
                  {s.origin ? <OriginBadge origin={s.origin} compact /> : null}
                  {shapeDef ? (
                    <span
                      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent/40 text-port-accent"
                      title={shapeDef.description}
                    >
                      <ArcShapeSparkline shape={shapeDef} width={40} height={14} />
                      {shapeDef.label}
                    </span>
                  ) : null}
                </div>
                {s.logline ? (
                  <div className="text-xs text-gray-500 mt-1 whitespace-pre-wrap break-words">{s.logline}</div>
                ) : (
                  <div className="text-xs text-gray-600 italic mt-1">No logline yet</div>
                )}
                {s.issueCountTarget ? (
                  <div className="text-xs text-gray-600 mt-1">
                    Target {s.issueCountTarget} issues / episodes
                  </div>
                ) : null}
              </Link>
              <ShareToButton kind="series" ids={[s.id]} compact />
              <button
                type="button"
                onClick={() => handleDelete(s)}
                className={`p-2 ${armedId === s.id ? 'text-port-error' : 'text-gray-500 hover:text-port-error'}`}
                aria-label={armedId === s.id ? `Confirm delete series ${s.name}` : `Delete series ${s.name}`}
                title={armedId === s.id ? 'Click again to confirm delete' : 'Delete series'}
              >
                <Trash2 size={16} />
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
