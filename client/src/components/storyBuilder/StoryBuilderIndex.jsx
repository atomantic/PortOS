import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, useLocation, Link } from 'react-router';
import {
  Sparkles, Check, ChevronRight, AlertTriangle,
  Plus, Loader2, Lightbulb, FileInput, RefreshCw,
} from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import TabPills from '../ui/TabPills';
import useListResource from '../../hooks/useListResource';
import useDrawerTab from '../../hooks/useDrawerTab';
import useStoryImportIntake from './useStoryImportIntake';
import { useCatalogTypes } from '../../hooks/useCatalogTypes.jsx';
import { getCatalogType, payloadSnippet } from '../../lib/catalogTypes';
import { formatCount } from '../../utils/formatters';
import { listStorySessions, createStorySession } from '../../services/apiStoryBuilder.js';
import { listCatalogIngredientsByIds } from '../../services/apiCatalog.js';
import { IMPORTER_CONTENT_TYPES } from '../../services/apiImporter.js';
import ProviderModelPicker from './ProviderModelPicker';

// Intake tabs on the index view. The active one lives in `?intake=` (via
// useDrawerTab) rather than local state so it's shareable and reload-safe.
const INTAKE_TABS = ['seed', 'import'];
const INTAKE_TAB_ITEMS = [
  { id: 'seed', label: 'Start from an idea', icon: Lightbulb },
  { id: 'import', label: 'Import a finished work', icon: FileInput },
];

const CONTENT_TYPE_LABELS = {
  'short-story': 'Short story', novel: 'Novel', screenplay: 'Screenplay', 'comic-script': 'Comic script',
};

// Compose a starter-idea prefill from a set of catalog ingredients (the Catalog
// "Remix into… → Story Builder" handoff). Ingredients are grouped by type, with
// a header line per group (e.g. `Characters:`) and one bullet per ingredient
// (`- {name}: {summary}`) where the summary comes from payloadSnippet — the
// type's snippetFallbackKeys, so a character's `physicalDescription` is included.
// The whole composed text is capped at 4000 chars to match the seedIdea field.
// Pure — unit-tested in StoryBuilder.test.jsx; mirrors the server composer.
const SEED_MAX_CHARS = 4000;
const SEED_SUMMARY_CHARS = 120;

// "character" → "Characters:" — prefer the catalog registry's canonical label
// (so idea/scene/concept get proper plurals), naive-pluralizing a user-defined
// type's id as a fallback. `resolveType` (the merged useCatalogTypes registry)
// covers user-defined types; falls back to the built-in registry. Mirrors
// `seedGroupHeading` in server storyBuilder.js.
function seedGroupHeading(type, resolveType) {
  const typeDef = (resolveType && resolveType(type)) || getCatalogType(type);
  const base = typeDef?.label || (type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : 'Other');
  return base.endsWith('s') ? base : `${base}s`;
}

// `resolveType` is the merged catalog-type registry (useCatalogTypes().getType)
// so a user-defined type's label + snippetFallbackKeys are honored; without it
// the built-in six are used.
export function composeSeedFromIngredients(ingredients, resolveType = null) {
  const list = Array.isArray(ingredients) ? ingredients : [];
  if (list.length === 0) return '';
  // Preserve first-seen group order so the prefill reads in selection order.
  const groups = new Map();
  for (const ing of list) {
    if (!ing) continue;
    const type = (ing.type || 'other').trim() || 'other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(ing);
  }
  const lines = [];
  for (const [type, members] of groups) {
    lines.push(`${seedGroupHeading(type, resolveType)}:`);
    for (const ing of members) {
      const name = (ing.name || '').trim() || '(untitled)';
      const summary = payloadSnippet(ing.payload, ing.type, SEED_SUMMARY_CHARS, resolveType);
      lines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim().slice(0, SEED_MAX_CHARS);
}

// ── Import intake (reuses the Importer's analyze → commit) ──────────────────

// Presentational half of the import intake. Every field and the whole
// analyze → commit → create-session workflow live in `useStoryImportIntake`,
// called by the always-mounted StoryBuilderIndex and handed down as `intake` —
// this component unmounts on every intake tab flip, so state held here would be
// destroyed by a single click on "Start from an idea" (#3904).
function ImportPanel({ intake }) {
  const {
    universeName, seriesName, contentType, source, llm,
    analyzing, preview, retrying, committing, arcAlreadyPersisted, committed,
    patch, analyze, retryIssues, importAndBuild,
  } = intake;

  const types = IMPORTER_CONTENT_TYPES || ['short-story', 'novel', 'screenplay', 'comic-script'];

  const canon = preview?.canonPreview || {};
  const issueCount = preview?.issueProposals?.length || 0;

  return (
    <div className="p-4 space-y-3">
      <p className="text-sm text-gray-400">
        Paste a finished story (comic script, screenplay, novel, or short story). It's reverse-engineered into a
        universe, plot arc, characters, and issues — then you review and lock each stage in the builder.
      </p>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-gray-500">Provider/model used for this import and every later step:</span>
        <ProviderModelPicker value={llm} onChange={(next) => patch({ llm: next })} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="imp-uni" className="block text-sm text-gray-400 mb-1">Universe name</label>
          <input id="imp-uni" type="text" value={universeName} onChange={(e) => patch({ universeName: e.target.value })}
            placeholder="e.g. Giant" className="w-full bg-port-bg border border-port-border rounded px-3 py-2" />
        </div>
        <div>
          <label htmlFor="imp-ser" className="block text-sm text-gray-400 mb-1">Series name</label>
          <input id="imp-ser" type="text" value={seriesName} onChange={(e) => patch({ seriesName: e.target.value })}
            placeholder="e.g. Giant" className="w-full bg-port-bg border border-port-border rounded px-3 py-2" />
        </div>
      </div>
      <div>
        <label htmlFor="imp-type" className="block text-sm text-gray-400 mb-1">Content type</label>
        <select id="imp-type" value={contentType} onChange={(e) => patch({ contentType: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2">
          {types.map((t) => <option key={t} value={t}>{CONTENT_TYPE_LABELS[t] || t}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="imp-src" className="block text-sm text-gray-400 mb-1">
          Source text <span className="text-gray-600">({formatCount(source.length)} chars)</span>
        </label>
        <textarea id="imp-src" value={source} onChange={(e) => patch({ source: e.target.value })} rows={8}
          placeholder="Paste the full script / manuscript here…"
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 font-mono text-xs" />
      </div>

      {!preview ? (
        <button onClick={analyze} disabled={analyzing}
          className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 rounded">
          {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {analyzing ? 'Analyzing… (this can take a minute)' : 'Analyze'}
        </button>
      ) : (
        <div className="border border-port-border rounded p-3 space-y-2 bg-port-bg">
          <div className="text-sm font-medium">
            Extracted “{preview.universe?.name}”
            {preview.isExistingUniverse && <span className="text-xs text-port-warning ml-2">(existing universe — will merge)</span>}
          </div>
          <div className="text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
            <span>{(canon.characters || []).length} characters</span>
            <span>{(canon.places || []).length} places</span>
            <span>{(canon.objects || []).length} objects</span>
            <span>{(preview.seasonsPreview || []).length} volumes</span>
            <span className={issueCount === 0 ? 'text-port-error' : ''}>{issueCount} issues</span>
          </div>
          {preview.arcPreview?.logline && <div className="text-xs text-gray-300 italic">“{preview.arcPreview.logline}”</div>}
          {(preview.issueSplitFailed || issueCount === 0) && (
            <div className="text-xs text-port-warning flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" /> Issue split didn’t produce issues.
              <button onClick={retryIssues} disabled={retrying} className="underline hover:text-port-accent disabled:opacity-50">
                {retrying ? 'Retrying…' : 'Retry issue split'}
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={importAndBuild} disabled={committing || issueCount === 0}
              className="inline-flex items-center gap-2 bg-port-success hover:bg-port-success/80 disabled:opacity-50 text-white px-4 py-2 rounded text-sm">
              {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {committed ? 'Retry starting the builder' : arcAlreadyPersisted ? 'Retry issues & start building' : 'Import & start building'}
            </button>
            <button onClick={() => patch({ preview: null })} disabled={committing}
              className="text-sm text-gray-400 hover:text-white px-2">Re-analyze</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Index view: list existing sessions + create a new one ──────────────────

export default function StoryBuilderIndex() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Merged catalog-type registry (system + user-defined) so the remix seed
  // prefill honors a user-defined type's snippetFallbackKeys, not just the six.
  // `loading` gates the prefill until the merged registry resolves (below).
  const { getType, loading: typesLoading } = useCatalogTypes();
  // The "Start a Story" onramp can deep-link here with a pre-chosen universe
  // (?universeId=…); pass it through so the new session attaches to it instead
  // of auto-creating a fresh universe. The create schema already accepts it.
  const onrampUniverseId = searchParams.get('universeId') || undefined;
  const fetchSessions = useCallback(() => listStorySessions({ silent: true }), []);
  // `sessionsState` keeps "still fetching" and "the fetch failed" distinct from
  // "you genuinely have no saved stories" (#3906).
  const {
    items: sessions,
    state: sessionsState,
    error: sessionsError,
    retry: retrySessions,
  } = useListResource(fetchSessions);
  const sessionsLoading = sessionsState === 'loading';
  const [mode, setMode] = useDrawerTab('intake', 'seed', INTAKE_TABS);
  const [title, setTitle] = useState('');
  const [seedIdea, setSeedIdea] = useState('');
  const [creating, setCreating] = useState(false);
  // Catalog "Remix into… → Story Builder" handoff. The ingredient ids arrive in
  // the generic `location.state.remix.ingredientIds`; we hydrate them via the
  // batch endpoint for the chip list + the seed prefill, and forward the ids on
  // create so the server can attach them to the new session.
  const [remixIds, setRemixIds] = useState([]);
  const [remixIngredients, setRemixIngredients] = useState([]);

  // Consume the remix handoff once at mount, then clear the history state so a
  // refresh doesn't re-seed (mirrors CatalogIngest's prefill-consume pattern).
  useEffect(() => {
    const ids = location.state?.remix?.ingredientIds;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const cleanIds = ids.filter(Boolean).slice(0, 50);
    if (cleanIds.length === 0) return;
    setRemixIds(cleanIds);
    listCatalogIngredientsByIds(cleanIds, { silent: true })
      .then((res) => setRemixIngredients(Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : [])))
      .catch(() => {});
    // Clear the handoff state so a refresh doesn't re-seed (ids already captured).
    navigate('.', { replace: true, state: {} });
  }, []);

  // Compose the seed prefill once the ingredients are hydrated AND the catalog
  // type registry has loaded — so a user-defined type's custom summary field is
  // honored rather than dropped while useCatalogTypes() still has only its
  // built-in fallback. Kept separate from the one-shot fetch above so it can
  // re-run when the registry resolves. Prefill only if the user hasn't typed a
  // seed — don't clobber (and the guard makes a second run idempotent).
  useEffect(() => {
    if (typesLoading || remixIngredients.length === 0) return;
    setSeedIdea((prev) => (prev.trim() ? prev : composeSeedFromIngredients(remixIngredients, getType)));
  }, [typesLoading, remixIngredients, getType]);

  const create = async () => {
    if (!title.trim()) { toast.error('Give your story a working title'); return; }
    setCreating(true);
    const created = await createStorySession(
      {
        title: title.trim(),
        seedIdea: seedIdea.trim(),
        universeId: onrampUniverseId,
        ...(remixIds.length ? { catalogIngredientIds: remixIds } : {}),
      },
      { silent: true },
    )
      .catch((err) => { toast.error(err?.message || 'Failed to create'); return null; });
    setCreating(false);
    if (created) navigate(`/story-builder/${created.id}/idea`);
  };

  const onCreated = useCallback((session) => navigate(`/story-builder/${session.id}/idea`), [navigate]);

  // Import intake state lives HERE, not inside <ImportPanel> — the panel unmounts
  // whenever the user flips to the "Start from an idea" tab, which used to throw
  // away the pasted manuscript and the minute-long analysis preview (#3904).
  const intake = useStoryImportIntake(onCreated);

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4">
        {/* Wide two-column shell when the container fits: create form left, "Continue a story" list
            right (mirrors the POST launcher redesign, #1986). In narrow containers the grid
            collapses to a single stacked column so mobile is unchanged. The 22rem
            sidebar track is reserved even with no sessions so the form keeps a
            comfortable ~48rem width instead of stretching the full shell. */}
        <div className="@container/page min-w-0 max-w-6xl mx-auto">
      <div className="grid grid-cols-1 @5xl/page:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
      <section className="bg-port-card border border-port-border rounded-lg">
        <TabPills
          tabs={INTAKE_TAB_ITEMS}
          activeTab={mode}
          onChange={setMode}
          mobileCompact
          ariaLabel="How to start"
          className="px-2 pt-2"
        />

        {mode === 'seed' ? (
          <div className="p-4 space-y-3">
            {remixIngredients.length > 0 && (
              <div className="rounded border border-port-accent/40 bg-port-accent/10 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-port-accent mb-1.5">
                  Seeding from {remixIngredients.length} ingredient{remixIngredients.length === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {remixIngredients.map((ing) => (
                    <span
                      key={ing.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-200"
                    >
                      <Sparkles className="w-3 h-3 text-port-accent" aria-hidden="true" />
                      {ing.name || '(untitled)'}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label htmlFor="stb-title" className="block text-sm text-gray-400 mb-1">Universe / story name</label>
              <input
                id="stb-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. The Salt Run"
                className="w-full bg-port-bg border border-port-border rounded px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="stb-seed" className="block text-sm text-gray-400 mb-1">Starter idea</label>
              <textarea
                id="stb-seed" value={seedIdea} onChange={(e) => setSeedIdea(e.target.value)} rows={3}
                placeholder="A one-line or one-paragraph seed. You'll expand it with AI in the first step."
                className="w-full bg-port-bg border border-port-border rounded px-3 py-2"
              />
            </div>
            <button
              onClick={create} disabled={creating}
              className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 rounded"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create &amp; begin
            </button>
          </div>
        ) : (
          <ImportPanel intake={intake} />
        )}
      </section>

      {/* Rendered while loading and on failure too — an empty sidebar during a
          failed fetch reads as "my saved stories were deleted" (#3906). Only a
          successful, genuinely-empty list hides the section. */}
      {(sessionsLoading || sessionsError || sessions.length > 0) && (
        <section className="space-y-2">
          <h2 className="font-semibold text-gray-300">Continue a story</h2>
          {sessionsLoading ? (
            <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading your stories">
              {['w-2/3', 'w-1/2', 'w-1/3'].map((w) => (
                <div key={w} className="bg-port-card border border-port-border rounded-lg px-4 py-3 animate-pulse">
                  <div className={`h-4 rounded bg-port-border ${w}`} />
                </div>
              ))}
            </div>
          ) : sessionsError ? (
            <Banner
              tone="error"
              icon={AlertTriangle}
              size="md"
              title="Couldn’t load your saved stories"
              actions={(
                <button
                  type="button"
                  onClick={retrySessions}
                  className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" /> Retry
                </button>
              )}
            >
              {sessionsError.message || 'Failed to load your saved stories'}
            </Banner>
          ) : sessions.map((s) => (
            <Link
              key={s.id} to={`/story-builder/${s.id}/${s.currentStep || 'idea'}`}
              className="flex items-center justify-between gap-2 bg-port-card border border-port-border rounded-lg px-4 py-3 hover:border-port-accent"
            >
              <span className="font-medium truncate min-w-0">{s.title}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">at “{s.currentStep}” <ChevronRight className="w-4 h-4 inline" /></span>
            </Link>
          ))}
        </section>
      )}
      </div>
        </div>
      </div>
  );
}
