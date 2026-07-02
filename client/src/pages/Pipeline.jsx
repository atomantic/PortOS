/**
 * Pipeline page — series index.
 *
 * Lists existing production series and lets the user create new ones. Each
 * series is the long-lived parent for a set of issues/episodes that share a
 * bible (logline, premise, characters, world ref, style). Clicking a series
 * drills into its detail page where issues are created and managed.
 */

import { useEffect, useMemo, useState } from 'react';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Workflow as WorkflowIcon, Trash2, Loader2, Globe2, FileInput, Sparkles, BookOpen } from 'lucide-react';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import ImageThumb from '../components/ui/ImageThumb';
import ShareToButton from '../components/sharing/ShareToButton';
import SyncToPeerButton from '../components/sharing/SyncToPeerButton';
import OriginBadge from '../components/sharing/OriginBadge';
import SyncBadge from '../components/sync/SyncBadge';
import { useSyncIntegrity, syncBadgeStatus } from '../hooks/useSyncIntegrity';
import {
  listPipelineSeries,
  createPipelineSeries,
  deletePipelineSeries,
  generateSeriesTitleLogo,
  generateSeriesConcept,
  listUniverses,
  WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX,
  WORLD_STYLE_NOTES_MAX,
} from '../services/api';
import { ArcShapePicker, ArcShapeSparkline, getStoryShape } from '../components/pipeline/StoryShapes';
import AuthorPicker from '../components/pipeline/AuthorPicker';
import MoodBoardReferenceStrip from '../components/moodBoard/MoodBoardReferenceStrip';
import { buildImporterLink } from '../lib/importerDeepLink';

const emptyForm = () => ({
  name: '',
  universeId: '',
  logline: '',
  premise: '',
  styleNotes: '',
  author: '',
  authorId: '',
  shape: null,
  issueCountTarget: '',
});

export default function Pipeline() {
  const navigate = useNavigate();
  const [series, setSeries] = useState([]);
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);

  const sync = useSyncIntegrity('series');
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
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

  // Generate a fresh series concept from the selected universe and overwrite
  // the form's story fields (name / logline / premise / shape) so the user can
  // edit before creating. The user clicked "Generate" explicitly, so this
  // replaces whatever's there — but an empty field from the LLM keeps the prior
  // value as a fallback. styleNotes is left to the universe-pull (it's a
  // world-level aesthetic, not a per-series story choice).
  const handleGenerate = async () => {
    if (!form.universeId) {
      toast.error('Pick a universe first — the generator uses it as seed material');
      return;
    }
    const requestedUniverseId = form.universeId;
    setGenerating(true);
    const concept = await generateSeriesConcept(requestedUniverseId, {}, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to generate a series concept');
      return null;
    });
    setGenerating(false);
    if (!concept) return;
    // The request can outlive the selection: if the user switched universes
    // while it was in flight, applying a concept seeded from the old universe
    // would pair the new universeId with a mismatched story. Gate the merge on
    // the LIVE state inside the functional updater (race-free — `f` is the
    // committed value, unlike a passively-synced ref), and gate the toast on
    // whether the merge actually applied.
    let applied = false;
    setForm((f) => {
      if (f.universeId !== requestedUniverseId) return f;
      applied = true;
      return {
        ...f,
        name: concept.name || f.name,
        logline: concept.logline || f.logline,
        premise: concept.premise || f.premise,
        // The generated concept owns the story shape — apply it verbatim,
        // including null (LLM picked none), so a stale earlier pick can't
        // misrepresent the freshly generated concept.
        shape: concept.shape,
      };
    });
    if (!applied) return;
    toast.success(
      concept.rationale
        ? `Generated "${concept.name}" — ${concept.rationale}`
        : `Generated "${concept.name}"`,
    );
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
      authorId: form.authorId || null,
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

  // Carry the in-progress create-form selection into the Importer deep-link:
  // the universe by id (an existing record) and the typed series name (no id
  // yet — it's being created). The importer resolves these into its match-or-
  // create autocomplete so the user doesn't have to retype them.
  const importerHref = useMemo(
    () => buildImporterLink({ universeId: form.universeId, seriesName: form.name }),
    [form.universeId, form.name],
  );

  // Inline delete confirm: the trash button arms the row (one at a time) and an
  // explicit Delete?/Cancel row fires it. Avoids window.confirm (banned per
  // CLAUDE.md) and the non-discoverable two-click-arm pattern.
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const handleDelete = (s) => confirmDelete(() => {
    const prior = series;
    setSeries((prev) => prev.filter((x) => x.id !== s.id));
    return deletePipelineSeries(s.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setSeries(prior);
    });
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <WorkflowIcon className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Series Pipeline</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/importer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-border text-gray-300 hover:text-white hover:border-port-accent/50 text-sm font-medium"
            title="Reverse-engineer an existing manuscript, novel, screenplay, or comic script into a series"
          >
            <FileInput size={16} aria-hidden="true" />
            Import
          </Link>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
          >
            <Plus size={16} aria-hidden="true" />
            New Series
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Each series carries a shared bible — logline, premise, characters, style, optional World — that
        every issue/episode below inherits into its stage prompts. Pipeline runs an idea seed through prose →
        comic script + teleplay (text), and hands off to image gen / Creative Director for the visual stages.
      </p>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="flex items-start gap-2 text-xs text-gray-400 bg-port-bg border border-port-border rounded p-2.5">
            <FileInput size={14} className="mt-0.5 flex-shrink-0 text-port-accent" aria-hidden="true" />
            <span>
              Already have a manuscript, novel, screenplay, or comic script?{' '}
              <Link to={importerHref} className="text-port-accent hover:underline">
                Import it instead
              </Link>{' '}
              — the importer extracts canon, the arc, and an issue split for you.
              {(form.universeId || form.name.trim())
                ? ' Your current universe / series selection carries over.'
                : ''}
            </span>
          </div>
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
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !form.universeId}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-accent/50 bg-port-accent/10 text-port-accent hover:bg-port-accent/20 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              title={!form.universeId
                ? 'Pick a universe first — the generator uses it as seed material'
                : 'Invent a fresh series (name, logline, premise, story shape) from this universe'}
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} aria-hidden="true" />}
              {generating ? 'Generating…' : 'Generate with AI'}
            </button>
            <span className="text-[11px] text-gray-500">
              Invents a different story set in the chosen universe — name, logline, premise & story shape. Edit anything before creating.
            </span>
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
              <AuthorPicker
                id="series-author"
                value={form.authorId}
                byline={form.author}
                onChange={(authorId, name) => setForm((f) => ({ ...f, authorId: authorId || '', author: name }))}
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
          <MoodBoardReferenceStrip storageKey="pipeline-series" />
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
              <Link to={`/pipeline/series/${s.id}`} className="flex-1 min-w-0 flex items-start gap-3">
                <ImageThumb imageRef={s.coverImage} FallbackIcon={BookOpen} sizeClass="w-12 h-[4.5rem]" />
                <div className="min-w-0 flex-1">
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
                </div>
              </Link>
              <SyncBadge
                status={syncBadgeStatus(sync, s.id)}
                onClick={() => navigate(`/pipeline/series/${encodeURIComponent(s.id)}/sync`)}
              />
              <ShareToButton kind="series" ids={[s.id]} compact />
              <SyncToPeerButton recordKind="series" recordId={s.id} compact />
              {isConfirming(s.id) ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  ariaLabel={`Confirm delete series ${s.name}`}
                  onConfirm={() => handleDelete(s)}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => requestDelete(s.id)}
                  className="p-2 text-gray-500 hover:text-port-error"
                  aria-label={`Delete series ${s.name}`}
                  title="Delete series"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
