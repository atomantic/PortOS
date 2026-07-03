import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { filterSelectableModels } from '../utils/providers';
import { composeCanonStyledPrompt } from '../lib/composeStyledPrompt';
import { descriptorForCanonEntry } from '../lib/canonPrompt';
import { pipelineImageCfgToRenderOpts } from '../lib/pipelineImageDefaults';
import { buildUniverseSectionRenderTag } from '../lib/universeRunTag';
import { capImageRefs } from '../lib/bibleLimits';
import useImageRenderSettings from '../hooks/useImageRenderSettings';
import useSingleImageRender from '../hooks/useSingleImageRender';
import EntryThumbSlot from '../components/universe/EntryThumbSlot';
import StyleProbeImage from '../components/universe/StyleProbeImage';
import ProviderModelSelector from '../components/ProviderModelSelector';
import {
  Sparkles, Lock, Unlock, Check, ChevronRight, ChevronLeft, AlertTriangle,
  Plus, RefreshCw, Loader2, ExternalLink, Wand2, Cloud, CloudOff,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Banner from '../components/ui/Banner';
import { useLockToggle } from '../hooks/useLockToggle';
import { usePipelineProgress } from '../hooks/usePipelineProgress';
import {
  getStoryBuilderSteps, listStorySessions, getStorySession, createStorySession,
  updateStorySession, setStoryCurrentStep, lockStoryStep, unlockStoryStep,
  generateStoryStep, refineStoryStep, setStoryIssueLock, generateStoryIssues,
  setStorySessionSync, reconcileStorySession, storyStepProgressSseUrl,
  getUniverse, getPipelineSeries, listPipelineIssues,
  analyzeImport, commitImport, retryImporterIssues, IMPORTER_CONTENT_TYPES,
  getProviders, listCatalogIngredientsByIds,
} from '../services/api';
import ArcCanvas from '../components/pipeline/ArcCanvas';
import { useArcCanvasSync } from '../hooks/useArcCanvasSync';
import { BEAT_KIND_COLORS, getBeatKindColor } from '../lib/beatColors';
import { getCatalogType, payloadSnippet } from '../lib/catalogTypes';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';

// Mirror Importer.jsx's commit picker — only these arc fields are sent on commit.
const ARC_FIELDS_TO_COMMIT = ['logline', 'summary', 'protagonistArc', 'themes', 'shape'];

// Bible fields the embedded arc step flushes before an ArcCanvas generate/verify.
// The Story Builder edits these on their own steps (not inside the arc step), so
// the flush is usually a no-op — kept for API-shape parity with ArcCanvas's
// contract. Module-level so the `useArcCanvasSync` callbacks keep a stable identity.
const ARC_FLUSH_FIELDS = ['name', 'logline', 'premise', 'styleNotes', 'issueCountTarget', 'universeId'];
const pickArcFields = (arc) => {
  if (!arc) return null;
  const out = {};
  for (const k of ARC_FIELDS_TO_COMMIT) if (arc[k] !== undefined) out[k] = arc[k];
  return out;
};

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

// Shared AI provider + model picker. The selection applies to EVERY Story
// Builder operation (idea expand, aesthetic, arc, reader map, character refine,
// and the importer's analyze) — see the session.llm fallback in the conductor.
// `value` is `{ provider, model }`; empty strings mean "use the stage default".
//
// The two selects are rendered by the shared `ProviderModelSelector` so the
// markup matches every other provider/model picker. The value is parent-
// controlled (session.llm / the import-panel state), so this stays controlled
// rather than using the self-owning `useProviderModels` hook — it just fetches
// the enabled provider list to feed the selector's options.
function ProviderModelPicker({ value, onChange }) {
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    getProviders({ silent: true })
      .then((data) => { if (!cancelled) setProviders((data?.providers || []).filter((p) => p.enabled)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const availableModels = useMemo(() => {
    const p = providers.find((x) => x.id === value?.provider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, value?.provider]);

  return (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={value?.provider || ''}
      selectedModel={value?.model || ''}
      availableModels={availableModels}
      onProviderChange={(provider) => onChange({ provider, model: '' })}
      onModelChange={(model) => onChange({ provider: value?.provider || '', model })}
      label="AI"
      compact
      emptyProviderOption="Default provider"
      emptyModelOption="Default model"
    />
  );
}

// ── Index view: list existing sessions + create a new one ──────────────────

function StoryBuilderIndex() {
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
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState('seed');
  const [title, setTitle] = useState('');
  const [seedIdea, setSeedIdea] = useState('');
  const [creating, setCreating] = useState(false);
  // Catalog "Remix into… → Story Builder" handoff. The ingredient ids arrive in
  // the generic `location.state.remix.ingredientIds`; we hydrate them via the
  // batch endpoint for the chip list + the seed prefill, and forward the ids on
  // create so the server can attach them to the new session.
  const [remixIds, setRemixIds] = useState([]);
  const [remixIngredients, setRemixIngredients] = useState([]);

  useEffect(() => {
    listStorySessions({ silent: true }).then(setSessions).catch(() => setSessions([]));
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const onCreated = (session) => navigate(`/story-builder/${session.id}/idea`);

  const tabClass = (id) => `px-4 py-2 text-sm rounded-t border-b-2 ${
    mode === id ? 'border-port-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'
  }`;

  return (
    // Wide two-column shell above lg: create form left, "Continue a story" list
    // right (mirrors the POST launcher redesign, #1986). Below lg the grid
    // collapses to a single stacked column so mobile is unchanged. The 22rem
    // sidebar track is reserved even with no sessions so the form keeps a
    // comfortable ~48rem width instead of stretching the full shell.
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-port-accent" /> Story Builder
        </h1>
        <p className="text-gray-400 mt-1">
          One guided path from idea to video — start from a seed idea or import a finished work, then review and
          lock each stage (aesthetic → plot arc → reader map → characters → issues) before moving on.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
      <section className="bg-port-card border border-port-border rounded-lg">
        <div className="flex gap-1 border-b border-port-border px-2 pt-2">
          <button onClick={() => setMode('seed')} className={tabClass('seed')}>Start from an idea</button>
          <button onClick={() => setMode('import')} className={tabClass('import')}>Import a finished work</button>
        </div>

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
          <ImportPanel onCreated={onCreated} />
        )}
      </section>

      {sessions.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold text-gray-300">Continue a story</h2>
          {sessions.map((s) => (
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
  );
}

// ── Import intake (reuses the Importer's analyze → commit) ──────────────────

function ImportPanel({ onCreated }) {
  const [universeName, setUniverseName] = useState('');
  const [seriesName, setSeriesName] = useState('');
  const [contentType, setContentType] = useState('comic-script');
  const [source, setSource] = useState('');
  const [llm, setLlm] = useState({ provider: '', model: '' });
  const [analyzing, setAnalyzing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [committing, setCommitting] = useState(false);
  // Set after a partial commit (universe/series/arc/canon persisted, issues
  // rolled back). The retry then drops arc + seasons + canon so it only
  // re-creates the issues — re-sending the full payload would clobber the
  // persisted state and risk duplicate issues. Mirrors Importer.jsx.
  const [arcAlreadyPersisted, setArcAlreadyPersisted] = useState(false);
  // Set once commitImport fully succeeds (issues created) but createStorySession
  // then failed — a re-click must skip commitImport entirely and resume at
  // session creation, otherwise it re-creates the already-created issues and
  // overwrites the arc.
  const [committed, setCommitted] = useState(false);
  // Any path that clears the preview (analyze, Re-analyze) is a fresh attempt,
  // so the retry/committed state can't survive it — centralize the reset here.
  useEffect(() => { if (!preview) { setArcAlreadyPersisted(false); setCommitted(false); } }, [preview]);

  const types = IMPORTER_CONTENT_TYPES || ['short-story', 'novel', 'screenplay', 'comic-script'];

  const analyze = async () => {
    if (!universeName.trim() || !seriesName.trim() || !source.trim()) {
      toast.error('Universe name, series name, and source text are required'); return;
    }
    setAnalyzing(true); setPreview(null);
    const res = await analyzeImport(
      {
        universeName: universeName.trim(), seriesName: seriesName.trim(), contentType, source,
        providerOverride: llm.provider || undefined, modelOverride: llm.model || undefined,
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Analyze failed'); return null; });
    setAnalyzing(false);
    if (res) setPreview(res);
  };

  const retryIssues = async () => {
    setRetrying(true);
    const res = await retryImporterIssues(
      {
        contentType, source, seriesName: seriesName.trim(), arcSummary: preview?.arcPreview?.summary || '',
        providerOverride: llm.provider || undefined, modelOverride: llm.model || undefined,
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Retry failed'); return null; });
    setRetrying(false);
    if (res) setPreview((p) => ({ ...p, issueProposals: res.issueProposals || [], issueSplitFailed: false }));
  };

  const importAndBuild = async () => {
    if (!preview) return;
    const issues = preview.issueProposals || [];
    if (issues.length === 0) { toast.error('No issues were extracted — retry the issue split or adjust the source'); return; }
    setCommitting(true);
    // Skip commitImport when a prior click already committed (only the later
    // createStorySession failed) — re-running it would duplicate the
    // already-created issues and overwrite the arc. Resume at session creation.
    if (!committed) {
      // On an arcAlreadyPersisted retry the server kept arc/seasons/canon from
      // the failed commit, so resend issues only — re-sending the full payload
      // would clobber the persisted state and risk duplicate issues.
      const base = { universeId: preview.universe.id, seriesId: preview.series.id, issues, contentType };
      const payload = arcAlreadyPersisted
        ? { ...base, canonSelections: { characters: [], places: [], objects: [] }, arc: null, seasons: [] }
        : {
            ...base,
            canonSelections: {
              characters: preview.canonPreview?.characters || [],
              places: preview.canonPreview?.places || [],
              objects: preview.canonPreview?.objects || [],
            },
            arc: pickArcFields(preview.arcPreview),
            seasons: preview.seasonsPreview || [],
          };
      const result = await commitImport(payload, { silent: true }).catch((err) => {
        if (err?.code === 'IMPORTER_PARTIAL_COMMIT_ISSUES' && err?.context?.arcAlreadyPersisted) {
          setArcAlreadyPersisted(true);
          toast.warning('Arc + seasons saved; issues failed and were rolled back. Click again to re-create the issues only — the arc won\'t be re-sent.');
          return null;
        }
        toast.error(err?.message || 'Import failed');
        return null;
      });
      if (!result) { setCommitting(false); return; }
      setArcAlreadyPersisted(false);
      setCommitted(true);
    }
    const session = await createStorySession({
      intakeMode: 'import',
      title: seriesName.trim() || universeName.trim(),
      // Seed from the extracted arc so the idea step has context and the
      // universe-aesthetic expand has a real starter (the imported universe
      // otherwise only has a name).
      seedIdea: (preview.arcPreview?.summary || preview.arcPreview?.logline || '').slice(0, 4000),
      universeId: preview.universe.id,
      seriesId: preview.series.id,
      // Persist the picker choice so every in-wizard operation uses it too.
      llm: { provider: llm.provider || null, model: llm.model || null },
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Failed to start the builder'); return null; });
    setCommitting(false);
    if (session) onCreated(session);
  };

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
        <ProviderModelPicker value={llm} onChange={setLlm} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="imp-uni" className="block text-sm text-gray-400 mb-1">Universe name</label>
          <input id="imp-uni" type="text" value={universeName} onChange={(e) => setUniverseName(e.target.value)}
            placeholder="e.g. Giant" className="w-full bg-port-bg border border-port-border rounded px-3 py-2" />
        </div>
        <div>
          <label htmlFor="imp-ser" className="block text-sm text-gray-400 mb-1">Series name</label>
          <input id="imp-ser" type="text" value={seriesName} onChange={(e) => setSeriesName(e.target.value)}
            placeholder="e.g. Giant" className="w-full bg-port-bg border border-port-border rounded px-3 py-2" />
        </div>
      </div>
      <div>
        <label htmlFor="imp-type" className="block text-sm text-gray-400 mb-1">Content type</label>
        <select id="imp-type" value={contentType} onChange={(e) => setContentType(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2">
          {types.map((t) => <option key={t} value={t}>{CONTENT_TYPE_LABELS[t] || t}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="imp-src" className="block text-sm text-gray-400 mb-1">
          Source text <span className="text-gray-600">({source.length.toLocaleString()} chars)</span>
        </label>
        <textarea id="imp-src" value={source} onChange={(e) => setSource(e.target.value)} rows={8}
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
            <button onClick={() => setPreview(null)} disabled={committing}
              className="text-sm text-gray-400 hover:text-white px-2">Re-analyze</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stale / status helpers ─────────────────────────────────────────────────

const STATUS_BADGE = {
  pending: { label: 'Not started', cls: 'text-gray-500' },
  'in-progress': { label: 'In progress', cls: 'text-port-warning' },
  ready: { label: 'Ready', cls: 'text-port-accent' },
  locked: { label: 'Locked', cls: 'text-port-success' },
};

// ── Per-step content panels ────────────────────────────────────────────────

function FieldBlock({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">{label}</div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap">{value || <span className="text-gray-600 italic">— empty —</span>}</div>
    </div>
  );
}

// A compact timeline of the reader map's emotional beats: each beat is a bar
// positioned along the arc (normalized from `atArcPosition`) with its height
// set by `intensity` and its color by `kind`. Gives the reader-map step the
// at-a-glance escalation/pacing view the plain list can't. Beats without a
// position fall back to even spacing so they still render.
function ReaderMapBeatTimeline({ readerMap }) {
  const beats = Array.isArray(readerMap?.beats) ? readerMap.beats : [];
  if (beats.length === 0) return null;

  const W = 320;
  const H = 64;
  const PAD = 4;
  // Normalize positions: beats use an arbitrary `atArcPosition` scale (0..9999),
  // so map the observed [min,max] span onto the plot width. When every beat
  // shares a position (or none have one), fall back to even spacing by index.
  const positioned = beats.filter((b) => Number.isFinite(b.atArcPosition));
  const minPos = positioned.length ? Math.min(...positioned.map((b) => b.atArcPosition)) : 0;
  const maxPos = positioned.length ? Math.max(...positioned.map((b) => b.atArcPosition)) : 0;
  const span = maxPos - minPos;
  const xFor = (b, i) => {
    const usable = W - PAD * 2;
    if (span > 0 && Number.isFinite(b.atArcPosition)) {
      return PAD + ((b.atArcPosition - minPos) / span) * usable;
    }
    return beats.length === 1 ? W / 2 : PAD + (i / (beats.length - 1)) * usable;
  };

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Beat timeline</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-16 bg-port-bg border border-port-border rounded"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Reader-map beat timeline — ${beats.length} beats`}
      >
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#2a2a2a" strokeWidth="1" />
        {beats.map((b, i) => {
          const x = xFor(b, i);
          const intensity = Number.isFinite(b.intensity) ? Math.max(0, Math.min(1, b.intensity)) : 0.5;
          // Floor the drawn height so a real beat with intensity 0 still shows a
          // visible marker instead of a zero-height (invisible) bar.
          const barH = Math.max(2, (H - PAD * 2) * intensity);
          const color = getBeatKindColor(b.kind);
          return (
            <g key={b.id || i}>
              <rect x={x - 1.5} y={H - PAD - barH} width="3" height={barH} fill={color} rx="1" />
              <title>{`${b.kind}${b.intensity != null ? ` ${Math.round(intensity * 100)}%` : ''}${b.note ? ` — ${b.note}` : ''}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
        {Object.entries(BEAT_KIND_COLORS).map(([kind, color]) => (
          <span key={kind} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} /> {kind}
          </span>
        ))}
      </div>
    </div>
  );
}

// Compact read-only summary of the arc's ticking clock — shown above the reader
// map so the countdown the reader anticipates sits alongside the hooks/payoffs
// it threads through. Authored in the Arc Canvas; null/disabled clocks hide.
function TickingClockSummary({ clock }) {
  if (!clock || clock.enabled !== true) return null;
  const span = clock.plantedAtArcPosition != null || clock.dueAtArcPosition != null
    ? ` · arc ${clock.plantedAtArcPosition ?? '?'} → ${clock.dueAtArcPosition ?? '?'}` : '';
  const reminderCount = Array.isArray(clock.reminders) ? clock.reminders.length : 0;
  return (
    <div className="rounded border border-port-warning/40 bg-port-bg/50 px-2 py-1.5">
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">Ticking clock</div>
      <div className="text-sm text-gray-300">
        ⏱ {clock.label || '(unnamed countdown)'} <span className="text-gray-500">({clock.kind || 'custom'}{span})</span>
      </div>
      {clock.stakes ? <div className="text-xs text-gray-400 mt-0.5">{clock.stakes}</div> : null}
      {reminderCount ? <div className="text-[11px] text-gray-500 mt-0.5">{reminderCount} reminder beat(s)</div> : null}
    </div>
  );
}

function ReaderMapView({ readerMap, tickingClock }) {
  if (!readerMap && !(tickingClock && tickingClock.enabled === true)) {
    return <p className="text-gray-600 italic text-sm">No reader map yet. Generate one to plan the audience experience.</p>;
  }
  const Section = ({ title, items, render }) => (
    items?.length ? (
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">{title} ({items.length})</div>
        <ul className="space-y-1">{items.map((it) => <li key={it.id} className="text-sm text-gray-300">{render(it)}</li>)}</ul>
      </div>
    ) : null
  );
  return (
    <div className="space-y-3">
      <TickingClockSummary clock={tickingClock} />
      <Section title="Hooks" items={readerMap?.hooks} render={(h) => `${h.atArcPosition != null ? `@${h.atArcPosition} · ` : ''}${h.label}${h.note ? ` — ${h.note}` : ''}`} />
      <Section title="Payoffs" items={readerMap?.payoffs} render={(p) => `${p.atArcPosition != null ? `@${p.atArcPosition} · ` : ''}${p.label}`} />
      <Section title="Beats" items={readerMap?.beats} render={(b) => `[${b.kind}${b.intensity != null ? ` ${Math.round(b.intensity * 100)}%` : ''}] ${b.note || ''}`} />
      <Section title="Cliffhangers" items={readerMap?.cliffhangers} render={(c) => `after #${c.atIssueBoundary ?? '?'} — ${c.note || ''}`} />
    </div>
  );
}

// Kick off a step generate/refine and drive its SSE progress stream. The POST
// returns immediately; we enable the stream only after it resolves so the run
// is registered server-side before the EventSource connects (matches the
// pipeline auto-run). The result content lives in the universe/series records,
// so callers refetch via `onComplete` rather than reading a payload off the
// frame. `op` lets a panel show the live phase on the button that triggered the
// run while leaving sibling buttons merely disabled.
function useStepStream(sessionId, stepId) {
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState('');
  const [op, setOp] = useState(null);
  const handlersRef = useRef(null);
  // The runId we're waiting on. useSseProgress only resets its `latest` a render
  // AFTER `enabled` flips true, so on the subscribe render `latest` still holds
  // the PREVIOUS run's terminal frame. Gating the terminal branches on a frame's
  // runId stops that stale frame from firing the new run's onComplete instantly.
  const runIdRef = useRef(null);
  // Enable only after the kickoff POST resolves (so the run is registered
  // server-side before the EventSource connects) — see the step runner below.
  const { latest, closed } = usePipelineProgress(storyStepProgressSseUrl, [sessionId, stepId], { enabled: active });

  const settle = useCallback(() => {
    setActive(false); setPhase(''); setOp(null);
    runIdRef.current = null;
    const h = handlersRef.current; handlersRef.current = null;
    return h;
  }, []);

  // One effect handles every end-of-run path. A terminal frame and the stream's
  // `closed` flag arrive together on completion, so the ordered branches (and
  // settle() flipping `active` false) ensure exactly one of onComplete/onError
  // fires — a separate `closed` effect would double-fire on the same render. The
  // bare-`closed` branch covers a stream that died before any terminal frame
  // (server pruned a fast run, or the connection dropped) so the button unsticks.
  useEffect(() => {
    if (!active) return;
    // Ignore frames belonging to a previous run (stale `latest` not yet reset by
    // the SSE hook). closed is reset on every (re)subscribe, so it never lingers.
    const mine = latest && latest.runId === runIdRef.current;
    if (mine && typeof latest.label === 'string' && latest.label) setPhase(latest.label);
    if (mine && latest.type === 'complete') settle()?.onComplete?.(latest);
    else if (mine && latest.type === 'error') settle()?.onError?.(new Error(latest.error || 'Generation failed'));
    else if (closed) settle()?.onError?.(new Error('Lost connection to the generation stream'));
  }, [latest, closed, active, settle]);

  const start = useCallback(async (nextOp, kickoff, handlers = {}) => {
    if (starting || active) return;
    setStarting(true); setPhase('Starting…'); setOp(nextOp);
    const res = await kickoff().catch((err) => { handlers.onError?.(err); return null; });
    setStarting(false);
    if (!res) { setPhase(''); setOp(null); return; }
    // The kickoff collided with a DIFFERENT in-flight request for this step (a
    // different op, or a refine of a different target/note). That run persists to
    // the same records, so binding THIS button's success handler to its terminal
    // frame would misreport. Don't subscribe — report it and leave the run alone.
    // (A same-work re-click returns alreadyRunning without conflict and re-attaches.)
    if (res.conflict) {
      setPhase(''); setOp(null);
      handlers.onError?.(new Error('Another operation is already running for this step — try again once it finishes.'));
      return;
    }
    handlersRef.current = handlers;
    runIdRef.current = res.runId; // only frames from this run drive our handlers
    setActive(true); // enable the SSE subscription now that the run is registered
  }, [starting, active]);

  return { start, busy: starting || active, phase, op };
}

function RefineBox({ onRefine, disabled, busy, running, phase }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="border-t border-port-border pt-3 mt-3">
      <label className="block text-xs text-gray-500 mb-1">AI refinement feedback</label>
      <div className="flex gap-2">
        <input
          type="text" value={feedback} onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. make the midpoint reveal land harder"
          disabled={disabled || busy}
          className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm disabled:opacity-50"
        />
        <button
          onClick={() => onRefine(feedback)} disabled={busy || disabled}
          className="inline-flex items-center gap-1 bg-port-card border border-port-border hover:border-port-accent px-3 py-1.5 rounded text-sm disabled:opacity-50 whitespace-nowrap"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          {running ? (phase || 'Refining…') : 'Refine'}
        </button>
      </div>
    </div>
  );
}

function StepPanel({ session, universe, series, issues, stepId, locked, onChanged, onSeriesUpdate, onIssuesUpdate, onFlushPending, onUniverseCharRef }) {
  const { start, busy, phase, op } = useStepStream(session.id, stepId);
  const arc = series?.arc || {};
  const isRunning = (which) => busy && op === which;

  // True when at least one issue already carries text content — the prerequisite
  // for backfilling an upstream step (idea / arc) FROM the downstream work.
  const issuesHaveContent = useMemo(() => (issues || []).some((iss) => {
    const st = iss.stages || {};
    return ['comicScript', 'teleplay', 'prose', 'idea']
      .some((sid) => (st[sid]?.input?.trim() || st[sid]?.output?.trim()));
  }), [issues]);

  const runGenerate = () => start('generate',
    () => generateStoryStep(session.id, stepId, {}, { silent: true }),
    { onComplete: () => { toast.success('Generated'); onChanged(); },
      onError: (err) => toast.error(err?.message || 'Generation failed') });

  // Backfill: synthesize this upstream step from the series' existing issue
  // content instead of from its conventional upstream (start-from-anywhere).
  const runBackfill = () => start('backfill',
    () => generateStoryStep(session.id, stepId, { fromDownstream: true }, { silent: true }),
    { onComplete: () => { toast.success('Backfilled from existing issues'); onChanged(); },
      onError: (err) => toast.error(err?.message || 'Backfill failed') });

  const backfillButton = () => (
    <button
      onClick={runBackfill} disabled={busy || locked}
      title="Reverse-engineer this step from the scripts / prose your issues already have"
      className="inline-flex items-center gap-2 bg-port-card border border-port-border hover:border-port-accent disabled:opacity-50 px-3 py-1.5 rounded text-sm"
    >
      {isRunning('backfill') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
      {isRunning('backfill') ? (phase || 'Working…') : 'Backfill from existing issues'}
    </button>
  );
  const runRefine = (feedback, entryId) => start('refine',
    () => refineStoryStep(session.id, stepId, { feedback, entryId }, { silent: true }),
    { onComplete: (frame) => {
        toast.success(frame.changes?.length ? `Refined — ${frame.changes.length} change(s)` : 'Refined');
        onChanged();
      },
      onError: (err) => toast.error(err?.message || 'Refine failed') });

  // Once a step has generated content, the button becomes "Re-generate" (with a
  // refresh icon) so it's clear it has already been run. While running, the
  // button surfaces the live SSE phase ("Planning the plot arc…").
  const genButton = (label = 'Generate with AI', hasContent = false) => (
    <button
      onClick={runGenerate} disabled={busy || locked}
      className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
    >
      {isRunning('generate') ? <Loader2 className="w-4 h-4 animate-spin" /> : (hasContent ? <RefreshCw className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />)}
      {isRunning('generate') ? (phase || 'Working…') : (hasContent ? 'Re-generate' : label)}
    </button>
  );

  if (stepId === 'idea') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Working title" value={session.title} />
        <FieldBlock label="Starter idea" value={session.seedIdea} />
        <div className="flex items-center gap-2 flex-wrap">
          {!locked && genButton('Expand idea with AI', Boolean((universe?.logline || '').trim()))}
          {!locked && issuesHaveContent && backfillButton()}
        </div>
        <p className="text-xs text-gray-500">
          Expanding seeds the universe starter prompt and series premise for the next steps.
          {issuesHaveContent && ' Already drafted issues? Backfill reverse-engineers the idea from their content.'}
        </p>
      </div>
    );
  }
  if (stepId === 'universeAesthetic') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Logline" value={universe?.logline} />
        <FieldBlock label="Premise" value={universe?.premise} />
        <FieldBlock label="Style notes" value={universe?.styleNotes} />
        <FieldBlock label="Influences — embrace" value={(universe?.influences?.embrace || []).join(', ')} />
        <FieldBlock label="Influences — avoid" value={(universe?.influences?.avoid || []).join(', ')} />
        <div className="border-t border-port-border pt-3">
          {/* Keyed by universe id so an in-flight base-style render's spinner +
              completion stay scoped to one universe across a selection change. */}
          {/* No `key` remount — `useSingleImageRender` scopes the probe per
              universe via `scopeId`, so the in-flight render/completion follows
              the displayed universe without a settings refetch on each switch. */}
          <StyleProbeImage universe={universe} onUniverseChange={() => onChanged()} canRender={!locked} />
        </div>
        <div className="flex items-center gap-2">
          {!locked && genButton('Expand aesthetic', Boolean((universe?.premise || universe?.styleNotes || '').trim()))}
          {universe?.id && (
            <Link to={`/universes/${universe.id}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-port-accent">
              <ExternalLink className="w-4 h-4" /> Deep-edit in Universe Builder
            </Link>
          )}
        </div>
        {!locked && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />}
      </div>
    );
  }
  if (stepId === 'plotArc') {
    const hasArc = Boolean((arc.logline || arc.summary || '').trim());
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {!locked && genButton('Generate plot arc', hasArc)}
          {!locked && issuesHaveContent && backfillButton()}
          {series?.id && (
            <Link to={`/pipeline/series/${series.id}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-port-accent">
              <ExternalLink className="w-4 h-4" /> Open the full Arc Canvas page
            </Link>
          )}
        </div>
        {issuesHaveContent && !hasArc && (
          <p className="text-xs text-gray-500">Started from drafted issues? Backfill extracts the arc from their scripts / prose.</p>
        )}
        {/* Embed the Arc Canvas inline once an arc exists AND the step is
            unlocked, so the logline / summary / protagonist arc / themes /
            Vonnegut shape AND the season roadmap are editable in-builder instead
            of read-only field blocks + a deep-link. The arc step is the right
            home for the whole-roadmap editor: it owns series.arc. We show the
            read-only field summary when there's no arc yet (ArcCanvas has
            nothing to render) OR when the step is LOCKED — ArcCanvas has no
            read-only mode and could otherwise edit (or internally unlock) a
            locked arc, bypassing the builder's "Unlock to revise" lock workflow.
            The deep-link below covers intentional editing of a locked arc. The
            `@container` wrapper activates ArcCanvas's `@5xl:` two-column layout. */}
        {hasArc && !locked ? (
          <div className="@container">
            <ArcCanvas
              series={series}
              issues={issues}
              onSeriesUpdate={onSeriesUpdate}
              onIssuesUpdate={onIssuesUpdate}
              onFlushPending={onFlushPending}
            />
          </div>
        ) : (
          <>
            <FieldBlock label="Arc logline" value={arc.logline} />
            <FieldBlock label="Arc summary" value={arc.summary} />
            <FieldBlock label="Protagonist arc" value={arc.protagonistArc} />
            <FieldBlock label="Themes" value={(arc.themes || []).join(', ')} />
            <FieldBlock label="Emotional shape (Vonnegut)" value={arc.shape} />
          </>
        )}
        {!locked && hasArc && (
          <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />
        )}
      </div>
    );
  }
  if (stepId === 'readerMap') {
    return (
      <div className="space-y-3">
        <ReaderMapBeatTimeline readerMap={arc.readerMap} />
        <ReaderMapView readerMap={arc.readerMap} tickingClock={arc.tickingClock} />
        {!locked && genButton('Generate reader map', Boolean(arc.readerMap))}
        {!locked && arc.readerMap && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />}
      </div>
    );
  }
  if (stepId === 'characters') {
    return <StepCharacters session={session} universe={universe} locked={locked} onChanged={onChanged} onUniverseCharRef={onUniverseCharRef} />;
  }
  if (stepId === 'issues') {
    return <IssuesPanel session={session} series={series} issues={issues} onChanged={onChanged} />;
  }
  if (stepId === 'production') {
    const locks = session.steps?.issues?.issueLocks || {};
    const done = (issues || []).filter((i) => locks[i.id]?.locked);
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">Render each completed issue. Production happens on the Pipeline issue page.</p>
        {done.length === 0 && <p className="text-gray-600 italic text-sm">Lock at least one issue on the previous step first.</p>}
        {done.map((i) => (
          <div key={i.id} className="flex items-center justify-between bg-port-bg border border-port-border rounded px-3 py-2">
            <span className="text-sm">#{i.number} {i.title}</span>
            <Link to={`/pipeline/issues/${i.id}/storyboards`} className="text-sm text-port-accent inline-flex items-center gap-1">
              Open production <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

// Characters step — review the cast and generate a styled preview image per
// character so the world style + character style can be eyeballed together.
// Reuses the Universe Builder's exact render path via the shared
// `composeCanonStyledPrompt` helper + `useSingleImageRender` jobId lifecycle →
// EntryThumbSlot (spinner → image), and persists the resulting filename onto
// the universe canon entry's imageRefs.
function StepCharacters({ session, universe, locked, onChanged, onUniverseCharRef }) {
  const cast = universe?.characters || [];
  const { imageCfg } = useImageRenderSettings();
  const [refiningId, setRefiningId] = useState(null);
  const { start: startRefine, busy: refineBusy, phase: refinePhase } = useStepStream(session.id, 'characters');

  // Section-local renders now carry a durable `universeRun.entryRef` tag (#1362),
  // so the server-side `appendEntryImageRef` hook persists the filename onto the
  // character's `imageRefs[]` — the client no longer refetches + PATCHes (a
  // full-array `updateUniverse` could clobber a sibling's just-persisted ref
  // with a stale list). Just mirror the ref into the loaded universe draft
  // optimistically for an instant thumbnail.
  const onCharRendered = (filename, charId) => {
    if (!universe?.id || !filename) return;
    onUniverseCharRef?.(charId, filename);
  };

  // One render per character, keyed by char id. `buildPrompt(charId)` composes
  // the universe-styled prompt for that character; a blank description aborts
  // the render (the hook returns null) after toasting why. Reuses the canon
  // styled-render routine the Universe Builder's canon section renders through.
  const { renderingJobs, render: queueCharRender, handleComplete: onCharComplete } = useSingleImageRender({
    buildPrompt: (charId) => {
      const c = cast.find((x) => x.id === charId);
      if (!c) return null;
      const description = descriptorForCanonEntry('characters', c);
      if (!description.trim()) { toast.error(`Add a description for ${c.name} before generating a preview`); return null; }
      const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
      return composeCanonStyledPrompt({ name: c.name, description, universe, baseNegative: baseOpts.negativePrompt });
    },
    onComplete: onCharRendered,
    onError: (err) => toast.error(err?.message || 'Render failed'),
  });

  const renderChar = (c) => {
    // Tag the render so the server auto-files it onto the character's
    // `imageRefs[]` (#1362). `useSingleImageRender.render` merges the third arg
    // into the generate payload.
    const tag = buildUniverseSectionRenderTag(universe, 'characters', c);
    queueCharRender(imageCfg, c.id, tag ? { universeRun: tag } : undefined);
  };

  const refineChar = (entryId) => {
    if (refineBusy) return;
    setRefiningId(entryId);
    startRefine('refine',
      () => refineStoryStep(session.id, 'characters', { entryId }, { silent: true }),
      { onComplete: (frame) => {
          setRefiningId(null);
          toast.success(frame.changes?.length ? `Refined — ${frame.changes.length} change(s)` : 'Refined');
          onChanged();
        },
        onError: (err) => { setRefiningId(null); toast.error(err?.message || 'Refine failed'); } });
  };

  return (
    <div className="space-y-3">
      {cast.length === 0 && (
        <p className="text-gray-600 italic text-sm">
          No characters yet. Add them in the <Link to={universe?.id ? `/universes/${universe.id}` : '/universes'} className="text-port-accent">Universe Builder</Link> or after generating the arc.
        </p>
      )}
      {cast.length > 0 && (
        <p className="text-xs text-gray-500">Generate a preview for each character to check the world style and character read correctly together.</p>
      )}
      {cast.map((c) => (
        <div key={c.id} className="bg-port-bg border border-port-border rounded p-2 flex items-start gap-3">
          <EntryThumbSlot
            imageRefs={c.imageRefs}
            inFlightJobId={renderingJobs[c.id] || null}
            onRender={() => renderChar(c)}
            onComplete={(fn) => onCharComplete(fn, c.id)}
            canRender={!locked && Boolean(universe?.id)}
            alt={c.name}
          />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{c.name} {c.locked && <Lock className="w-3 h-3 inline text-port-success" />}</div>
            <div className="text-xs text-gray-400">{c.physicalDescription || (Array.isArray(c.descriptor) ? c.descriptor.map((d) => d.value).join(', ') : '')}</div>
          </div>
          {!locked && (
            <button
              onClick={() => refineChar(c.id)} disabled={refineBusy}
              className="text-xs inline-flex items-center gap-1 border border-port-border rounded px-2 py-1 hover:border-port-accent disabled:opacity-50 shrink-0 whitespace-nowrap"
            >
              {refiningId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              {refiningId === c.id ? (refinePhase || 'Refining…') : 'Refine'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function IssuesPanel({ session, series, issues, onChanged }) {
  const locks = session.steps?.issues?.issueLocks || {};
  const [busyId, setBusyId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const hasSeasons = Array.isArray(series?.seasons) && series.seasons.length > 0;

  const toggleIssue = async (issueId, next) => {
    setBusyId(issueId);
    const res = await setStoryIssueLock(session.id, issueId, next, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed'); return null; });
    setBusyId(null);
    if (res) { toast.success(next ? 'Issue marked done' : 'Issue reopened'); onChanged(); }
  };

  // Seed issues from the arc — generates a per-episode breakdown for every
  // season and persists one issue per episode, so the user never leaves the
  // builder. Provider/model is resolved server-side from the session picker.
  const generateIssues = async () => {
    setGenerating(true);
    const res = await generateStoryIssues(session.id, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to generate issues'); return null; });
    setGenerating(false);
    if (!res) return;
    const created = res.createdIssues?.length || 0;
    const seasons = res.seasons || [];
    // Skipped = genuinely ineligible (locked / no synopsis); failed = a
    // transient provider/LLM error. Surface them separately so an infra
    // failure never reads as a config skip. Distinct reasons are deduped so a
    // multi-season batch shows every cause, not just the first.
    const skipped = seasons.filter((s) => s.skipped);
    const failed = seasons.filter((s) => s.failed);
    const reasons = (list) => [...new Set(list.map((s) => s.reason).filter(Boolean))].join('; ');
    const noun = (n) => (n === 1 ? 'season' : 'seasons');
    if (created > 0) {
      toast.success(`Created ${created} issue${created === 1 ? '' : 's'} from the arc`);
      // A skipped season is an expected config state (locked / no synopsis) —
      // warn (yellow), don't error (red). A failed season is a real error.
      if (skipped.length) toast.warning(`Skipped ${skipped.length} ${noun(skipped.length)}: ${reasons(skipped)}`);
      if (failed.length) toast.error(`Couldn't generate ${failed.length} ${noun(failed.length)}: ${reasons(failed)}`);
    } else if (failed.length) {
      toast.error(`Couldn't generate issues — ${reasons(failed) || 'a provider error occurred'}`);
    } else if (skipped.length) {
      toast.warning(`No issues created — ${reasons(skipped)}`);
    } else {
      toast.error('No issues were generated');
    }
    onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-gray-400">Complete issues one at a time. Lock issue #1 before moving to #2.</p>
        <div className="flex items-center gap-3">
          {hasSeasons && (
            <button
              onClick={generateIssues} disabled={generating}
              title="Generate a per-episode breakdown for every season and create the issues here"
              className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Generate issues from arc
            </button>
          )}
          {series?.id && (
            <Link to={`/pipeline/series/${series.id}`} className="text-sm text-port-accent inline-flex items-center gap-1">
              Plan issues in Pipeline <ExternalLink className="w-4 h-4" />
            </Link>
          )}
        </div>
      </div>
      {(!issues || issues.length === 0) && (
        <p className="text-gray-600 italic text-sm">
          {hasSeasons
            ? 'No issues yet — “Generate issues from arc” seeds one issue per episode for each season, or plan them in the Pipeline.'
            : 'No issues yet — generate seasons on the plot-arc step first, then seed issues from the arc.'}
        </p>
      )}
      {(issues || []).map((i) => {
        const isLocked = locks[i.id]?.locked;
        return (
          <div key={i.id} className="flex items-center justify-between bg-port-bg border border-port-border rounded px-3 py-2">
            <div className="flex items-center gap-2">
              {isLocked ? <Check className="w-4 h-4 text-port-success" /> : <span className="w-4 h-4" />}
              <span className="text-sm">#{i.number} {i.title}</span>
              <span className="text-xs text-gray-500">{i.status}</span>
            </div>
            <div className="flex items-center gap-2">
              <Link to={`/pipeline/issues/${i.id}/idea`} className="text-xs text-gray-400 hover:text-port-accent inline-flex items-center gap-1">
                Open <ExternalLink className="w-3 h-3" />
              </Link>
              <button
                onClick={() => toggleIssue(i.id, !isLocked)} disabled={busyId === i.id}
                className={`text-xs inline-flex items-center gap-1 border rounded px-2 py-1 disabled:opacity-50 ${isLocked ? 'border-port-success text-port-success' : 'border-port-border hover:border-port-accent'}`}
              >
                {busyId === i.id ? <Loader2 className="w-3 h-3 animate-spin" /> : (isLocked ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />)}
                {isLocked ? 'Reopen' : 'Mark done'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detail view: stepper + active panel ─────────────────────────────────────

function StoryBuilderDetail({ storyId, stepParam }) {
  const navigate = useNavigate();
  const [steps, setSteps] = useState([]);
  const [session, setSession] = useState(null);
  const [staleSteps, setStaleSteps] = useState([]);
  const [syncDrift, setSyncDrift] = useState(false);
  const [universe, setUniverse] = useState(null);
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);

  const reload = useCallback(async () => {
    const s = await getStorySession(storyId, { silent: true }).catch(() => null);
    if (!s) { setSession(null); setLoading(false); return; }
    setSession(s);
    setStaleSteps(s.staleSteps || []);
    setSyncDrift(s.syncDrift === true);
    // These GETs own their fallback (.catch → null/[]), so silence the helper's
    // default error toast — otherwise a transient failure double-toasts.
    const [u, ser] = await Promise.all([
      s.universeId ? getUniverse(s.universeId, { silent: true }).catch(() => null) : Promise.resolve(null),
      s.seriesId ? getPipelineSeries(s.seriesId, { silent: true }).catch(() => null) : Promise.resolve(null),
    ]);
    setUniverse(u);
    setSeries(ser);
    if (s.seriesId) {
      const iss = await listPipelineIssues(s.seriesId, { silent: true }).catch(() => []);
      setIssues(Array.isArray(iss) ? iss : (iss?.items || []));
    }
    setLoading(false);
  }, [storyId]);

  // Optimistically mirror a completed character render onto the loaded
  // universe's `imageRefs[]`. The Story Builder characters step now tags its
  // render with a durable `universeRun.entryRef` (#1362), so the server-side
  // `appendEntryImageRef` hook persists the ref — this stamp just drives an
  // instant thumbnail without a refetch (which could race the durable write).
  // Dedup-guarded + last-N capped to mirror the server append.
  const applyUniverseCharRef = useCallback((charId, filename) => {
    if (!charId || !filename) return;
    setUniverse((cur) => {
      if (!cur) return cur;
      const chars = Array.isArray(cur.characters) ? cur.characters : [];
      const nextChars = chars.map((c) => {
        if (c?.id !== charId) return c;
        const refs = Array.isArray(c.imageRefs) ? c.imageRefs : [];
        if (refs.includes(filename)) return c;
        return { ...c, imageRefs: capImageRefs([...refs, filename]) };
      });
      return { ...cur, characters: nextChars };
    });
  }, []);

  // ── Embedded ArcCanvas wiring (plotArc step) ──────────────────────────────
  // The Arc Canvas edits series.arc + the issue roadmap in place, so it needs
  // server-confirmed setters. The flush is usually a no-op here (the bible
  // fields are edited on their own steps, not inside the arc step), so a
  // pre-flush save failure is swallowed (silent) rather than toasted.
  const { updateSeriesFromServer, handleIssuesUpdate, flushPending } = useArcCanvasSync({
    series,
    setSeries,
    setIssues,
    flushFields: ARC_FLUSH_FIELDS,
    silent: true,
  });

  // Load the step manifest first; gate the loading spinner on BOTH it and the
  // session so the detail view never renders with an empty step rail.
  useEffect(() => {
    setLoading(true);
    getStoryBuilderSteps({ silent: true })
      .then((r) => setSteps(r.steps || []))
      .catch(() => {})
      .finally(reload);
  }, [reload]);

  const stepIds = steps.map((s) => s.id);
  const activeStepId = stepIds.includes(stepParam) ? stepParam : (session?.currentStep || 'idea');
  const activeIdx = stepIds.indexOf(activeStepId);
  const activeStep = steps[activeIdx];
  const stepState = session?.steps?.[activeStepId] || { status: 'pending', locked: false };
  const isStale = staleSteps.includes(activeStepId);

  // Navigation is advisory, not gated: the user may start from any point and
  // work the steps out of order (e.g. start from a drafted comic script and
  // backfill the idea / arc afterward). `firstUnmetUpstream` reports the first
  // earlier step that is unlocked or stale purely so the rail can show a hint —
  // it never blocks navigation.
  const firstUnmetUpstream = useCallback((idx) => {
    for (let i = 0; i < idx; i++) {
      const id = stepIds[i];
      if (session?.steps?.[id]?.locked !== true) return 'unlocked';
      if (staleSteps.includes(id)) return 'stale';
    }
    return null;
  }, [stepIds, session, staleSteps]);

  const lock = useLockToggle({
    patchFn: (next) => (next ? lockStoryStep(storyId, activeStepId, { silent: true }) : unlockStoryStep(storyId, activeStepId, { silent: true })),
    onSuccess: (_updated, next) => {
      reload();
      // "Lock & continue" should actually continue — on a successful LOCK,
      // auto-advance to the next step. Skip if the current step is stale (the
      // user must re-review, not advance) and only navigate AFTER the server
      // accepts the pointer move, so a rejected gate doesn't strand the URL
      // ahead of the persisted currentStep. Unlocking stays put.
      if (next && !isStale && activeIdx >= 0 && activeIdx < stepIds.length - 1) {
        const nextId = stepIds[activeIdx + 1];
        setStoryCurrentStep(storyId, nextId, { silent: true })
          .then(() => navigate(`/story-builder/${storyId}/${nextId}`))
          // The lock succeeded, but the pointer move was re-gated/rejected. Stay
          // put (don't strand the URL ahead of the persisted currentStep) and
          // resync so the rail reflects the server's actual pointer.
          .catch(() => { toast.error('Locked, but could not advance'); reload(); });
      }
    },
    lockedMessage: `${activeStep?.label || 'Step'} locked`,
    unlockedMessage: `${activeStep?.label || 'Step'} unlocked`,
    errorMessage: 'Failed to update lock',
  });

  const goToStep = async (id) => {
    // Free navigation — any step is reachable. Upstream lock/stale state is
    // surfaced as a warning on the step (not a block), so a user can jump to a
    // later step and backfill the earlier ones. Navigate only AFTER the server
    // accepts the pointer move — otherwise a rejected re-gate (deleted session,
    // invalid step) strands the URL on a step the persisted currentStep never
    // advanced to. On rejection, resync so the rail reflects the real pointer.
    const ok = await setStoryCurrentStep(storyId, id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Could not switch step'); reload(); return; }
    navigate(`/story-builder/${storyId}/${id}`);
  };

  // Persist the picker choice to session.llm — the conductor reads it as the
  // default provider/model for every generate/refine, so one selection drives
  // the whole wizard.
  const saveLlm = async (next) => {
    const updated = await updateStorySession(storyId, {
      llm: { provider: next.provider || null, model: next.model || null },
    }, { silent: true }).catch(() => null);
    // An llm-only change touches nothing else — merge it locally instead of a
    // full reload() (which would refetch session + universe + series + issues
    // and briefly flicker the view).
    if (updated) setSession((prev) => (prev ? { ...prev, llm: updated.llm } : prev));
  };

  // Cross-machine resume (#730). The sync/reconcile routes return the full
  // recomputed session view (staleSteps + syncDrift), not just the record —
  // because toggling sync or reconciling shifts the staleness baseline, which
  // can change which steps read as stale. Merge the whole view so the step rail
  // and the drift indicator both update reactively, no full refetch.
  const applySessionView = (view) => {
    setSession((prev) => (prev ? { ...prev, ...view } : view));
    setStaleSteps(view.staleSteps || []);
    setSyncDrift(view.syncDrift === true);
  };

  const toggleSync = async () => {
    if (!session || syncBusy) return;
    const next = session.sync !== true;
    setSyncBusy(true);
    const view = await setStorySessionSync(storyId, next, { silent: true })
      .catch(() => null)
      .finally(() => setSyncBusy(false));
    if (!view) { toast.error('Failed to update cross-machine resume'); return; }
    applySessionView(view);
    toast.success(next ? 'Cross-machine resume enabled' : 'Cross-machine resume disabled');
  };

  const reconcile = async () => {
    if (!session || session.sync !== true || syncBusy) return;
    setSyncBusy(true);
    const view = await reconcileStorySession(storyId, { silent: true })
      .catch(() => null)
      .finally(() => setSyncBusy(false));
    if (!view) { toast.error('Failed to reconcile'); return; }
    applySessionView(view);
    toast.success('Re-baselined to this machine');
  };

  if (loading) return <div className="p-6 text-gray-400 flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>;
  if (!session) return <div className="p-6 text-gray-400">Session not found. <Link to="/story-builder" className="text-port-accent">Back to Story Builder</Link></div>;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-4 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <Link to="/story-builder" className="text-xs text-gray-500 hover:text-port-accent">← All stories</Link>
            <h1 className="text-2xl font-bold flex items-center gap-2 mt-1">
              <Sparkles className="w-6 h-6 text-port-accent" /> {session.title}
            </h1>
          </div>
          {/* Applies to every operation in this story (idea expand, aesthetic,
              arc, reader map, character refine). */}
          <ProviderModelPicker
            value={{ provider: session.llm?.provider || '', model: session.llm?.model || '' }}
            onChange={saveLlm}
          />
        </header>

        {/* Cross-machine resume (#730): opt this session into peer sync so it can
            resume on another federated machine, and re-baseline its staleness
            against the current machine's live records. Local-only is the default. */}
        <div className="mb-4 flex items-center flex-wrap gap-x-3 gap-y-2 text-sm bg-port-card border border-port-border rounded-lg px-3 py-2">
          <button
            type="button"
            onClick={toggleSync}
            disabled={syncBusy}
            aria-pressed={session.sync === true}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border disabled:opacity-50 ${
              session.sync === true
                ? 'border-port-accent text-port-accent bg-port-bg'
                : 'border-port-border text-gray-400 hover:text-white'
            }`}
            title="Toggle whether this session resumes across your federated machines"
          >
            {syncBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : (session.sync === true ? <Cloud className="w-4 h-4" /> : <CloudOff className="w-4 h-4" />)}
            {session.sync === true ? 'Cross-machine resume on' : 'Cross-machine resume off'}
          </button>

          {session.sync === true && (
            <>
              <span className="text-xs text-gray-500">
                {syncDrift
                  ? 'This machine’s records have drifted from the synced baseline.'
                  : 'Baseline matches this machine.'}
              </span>
              <button
                type="button"
                onClick={reconcile}
                disabled={syncBusy || !syncDrift}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border disabled:opacity-40 ${
                  syncDrift
                    ? 'border-port-warning text-port-warning hover:bg-port-bg'
                    : 'border-port-border text-gray-500'
                }`}
                title={syncDrift
                  ? 'Adopt this machine’s current records as the new staleness baseline'
                  : 'Nothing to reconcile — the baseline already matches this machine'}
              >
                {syncBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Reconcile
              </button>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
          {/* Step rail */}
          <nav className="space-y-1">
            {steps.map((s, idx) => {
              const st = session.steps?.[s.id] || { status: 'pending', locked: false };
              const stale = staleSteps.includes(s.id);
              const isActive = s.id === activeStepId;
              // Navigation is never blocked (start-from-anywhere). The warning
              // icon flags a step whose upstream is unlocked or stale so the
              // user knows the order isn't conventional — but they may proceed.
              const unmet = firstUnmetUpstream(idx);
              return (
                <button
                  key={s.id} onClick={() => goToStep(s.id)}
                  className={`w-full text-left px-3 py-2 rounded border flex items-center justify-between gap-2 ${
                    isActive ? 'border-port-accent bg-port-card' : 'border-transparent hover:bg-port-card'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm">
                    {st.locked ? <Lock className="w-3.5 h-3.5 text-port-success" /> : <span className="w-3.5 h-3.5 rounded-full border border-gray-600 inline-block" />}
                    {s.label}
                  </span>
                  {(stale || unmet) && (
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-port-warning"
                      title={stale ? 'Stale — re-review' : 'Earlier step not locked yet'}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Active step */}
          <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">{activeStep?.label}</h2>
                <p className="text-sm text-gray-400">{activeStep?.description}</p>
              </div>
              <span className={`text-xs ${STATUS_BADGE[stepState.status]?.cls}`}>{STATUS_BADGE[stepState.status]?.label}</span>
            </div>

            {isStale && (
              <Banner tone="warning" size="md" icon={AlertTriangle} align="center">
                An earlier step changed after you locked this — re-review and re-lock to continue.
              </Banner>
            )}

            <StepPanel
              key={activeStepId}
              session={session} universe={universe} series={series} issues={issues}
              stepId={activeStepId} locked={stepState.locked} onChanged={reload}
              onSeriesUpdate={updateSeriesFromServer}
              onIssuesUpdate={handleIssuesUpdate}
              onFlushPending={flushPending}
              onUniverseCharRef={applyUniverseCharRef}
            />

            {/* Footer: lock + navigation */}
            <div className="flex items-center justify-between border-t border-port-border pt-3 mt-3">
              <button
                onClick={() => lock.toggle(stepState.locked)} disabled={lock.busy}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm disabled:opacity-50 ${
                  stepState.locked ? 'bg-port-card border border-port-success text-port-success' : 'bg-port-success hover:bg-port-success/80 text-white'
                }`}
              >
                {lock.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (stepState.locked ? <Unlock className="w-4 h-4" /> : <Check className="w-4 h-4" />)}
                {stepState.locked ? 'Unlock to revise' : 'Lock & continue'}
              </button>

              <div className="flex items-center gap-2">
                {activeIdx > 0 && (
                  <button onClick={() => goToStep(stepIds[activeIdx - 1])} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
                    <ChevronLeft className="w-4 h-4" /> Back
                  </button>
                )}
                {activeIdx < steps.length - 1 && (
                  <button
                    onClick={() => goToStep(stepIds[activeIdx + 1])}
                    disabled={!stepState.locked || isStale}
                    className="inline-flex items-center gap-1 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 text-white px-3 py-1.5 rounded"
                  >
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function StoryBuilder() {
  const { storyId, step } = useParams();
  if (!storyId) return <StoryBuilderIndex />;
  return <StoryBuilderDetail storyId={storyId} stepParam={step} />;
}
