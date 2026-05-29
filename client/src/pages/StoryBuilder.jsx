import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { filterSelectableModels } from '../utils/providers';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import { universeStylePreset } from '../lib/universeStylePreset';
import { descriptorForCanonEntry } from '../lib/canonPrompt';
import { pipelineImageCfgToRenderOpts, readPipelineImageSettings, PIPELINE_IMAGE_DEFAULTS } from '../lib/pipelineImageDefaults';
import EntryThumbSlot from '../components/universe/EntryThumbSlot';
import StyleProbeImage from '../components/universe/StyleProbeImage';
import {
  Sparkles, Lock, Unlock, Check, ChevronRight, ChevronLeft, AlertTriangle,
  Plus, RefreshCw, Loader2, ExternalLink, Wand2,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Banner from '../components/ui/Banner';
import { useLockToggle } from '../hooks/useLockToggle';
import {
  getStoryBuilderSteps, listStorySessions, getStorySession, createStorySession,
  updateStorySession, setStoryCurrentStep, lockStoryStep, unlockStoryStep,
  generateStoryStep, refineStoryStep, setStoryIssueLock,
  getUniverse, getPipelineSeries, listPipelineIssues,
  analyzeImport, commitImport, retryImporterIssues, IMPORTER_CONTENT_TYPES,
  getProviders, getSettings, generateImage, updateUniverse,
} from '../services/api';

// Mirror Importer.jsx's commit picker — only these arc fields are sent on commit.
const ARC_FIELDS_TO_COMMIT = ['logline', 'summary', 'protagonistArc', 'themes', 'shape'];
const pickArcFields = (arc) => {
  if (!arc) return null;
  const out = {};
  for (const k of ARC_FIELDS_TO_COMMIT) if (arc[k] !== undefined) out[k] = arc[k];
  return out;
};

const CONTENT_TYPE_LABELS = {
  'short-story': 'Short story', novel: 'Novel', screenplay: 'Screenplay', 'comic-script': 'Comic script',
};

// Shared AI provider + model picker. The selection applies to EVERY Story
// Builder operation (idea expand, aesthetic, arc, reader map, character refine,
// and the importer's analyze) — see the session.llm fallback in the conductor.
// `value` is `{ provider, model }`; empty strings mean "use the stage default".
function ProviderModelPicker({ value, onChange, id = 'stb' }) {
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    getProviders({ silent: true })
      .then((data) => { if (!cancelled) setProviders((data?.providers || []).filter((p) => p.enabled)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const models = useMemo(() => {
    const p = providers.find((x) => x.id === value?.provider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, value?.provider]);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={`${id}-provider`} className="text-xs text-gray-500 whitespace-nowrap">AI</label>
      <select
        id={`${id}-provider`} value={value?.provider || ''}
        onChange={(e) => onChange({ provider: e.target.value, model: '' })}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs max-w-[10rem]"
      >
        <option value="">Default provider</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {models.length > 0 && (
        <select
          id={`${id}-model`} aria-label="Model" value={value?.model || ''}
          onChange={(e) => onChange({ provider: value?.provider || '', model: e.target.value })}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs max-w-[12rem]"
        >
          <option value="">Default model</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Index view: list existing sessions + create a new one ──────────────────

function StoryBuilderIndex() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState('seed');
  const [title, setTitle] = useState('');
  const [seedIdea, setSeedIdea] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listStorySessions({ silent: true }).then(setSessions).catch(() => setSessions([]));
  }, []);

  const create = async () => {
    if (!title.trim()) { toast.error('Give your story a working title'); return; }
    setCreating(true);
    const created = await createStorySession({ title: title.trim(), seedIdea: seedIdea.trim() }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to create'); return null; });
    setCreating(false);
    if (created) navigate(`/story-builder/${created.id}/idea`);
  };

  const onCreated = (session) => navigate(`/story-builder/${session.id}/idea`);

  const tabClass = (id) => `px-4 py-2 text-sm rounded-t border-b-2 ${
    mode === id ? 'border-port-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'
  }`;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-port-accent" /> Story Builder
        </h1>
        <p className="text-gray-400 mt-1">
          One guided path from idea to video — start from a seed idea or import a finished work, then review and
          lock each stage (aesthetic → plot arc → reader map → characters → issues) before moving on.
        </p>
      </header>

      <section className="bg-port-card border border-port-border rounded-lg">
        <div className="flex gap-1 border-b border-port-border px-2 pt-2">
          <button onClick={() => setMode('seed')} className={tabClass('seed')}>Start from an idea</button>
          <button onClick={() => setMode('import')} className={tabClass('import')}>Import a finished work</button>
        </div>

        {mode === 'seed' ? (
          <div className="p-4 space-y-3">
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
              className="inline-flex items-center gap-2 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded"
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
              className="flex items-center justify-between bg-port-card border border-port-border rounded-lg px-4 py-3 hover:border-port-accent"
            >
              <span className="font-medium">{s.title}</span>
              <span className="text-xs text-gray-500">at “{s.currentStep}” <ChevronRight className="w-4 h-4 inline" /></span>
            </Link>
          ))}
        </section>
      )}
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
    const committed = await commitImport({
      universeId: preview.universe.id,
      seriesId: preview.series.id,
      issues,
      contentType,
      canonSelections: {
        characters: preview.canonPreview?.characters || [],
        places: preview.canonPreview?.places || [],
        objects: preview.canonPreview?.objects || [],
      },
      arc: pickArcFields(preview.arcPreview),
      seasons: preview.seasonsPreview || [],
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Import failed'); return null; });
    if (!committed) { setCommitting(false); return; }
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
        <ProviderModelPicker value={llm} onChange={setLlm} id="imp" />
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
          className="inline-flex items-center gap-2 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded">
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
              className="inline-flex items-center gap-2 bg-port-success hover:bg-green-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm">
              {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Import &amp; start building
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

function ReaderMapView({ readerMap }) {
  if (!readerMap) return <p className="text-gray-600 italic text-sm">No reader map yet. Generate one to plan the audience experience.</p>;
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
      <Section title="Hooks" items={readerMap.hooks} render={(h) => `${h.atArcPosition != null ? `@${h.atArcPosition} · ` : ''}${h.label}${h.note ? ` — ${h.note}` : ''}`} />
      <Section title="Payoffs" items={readerMap.payoffs} render={(p) => `${p.atArcPosition != null ? `@${p.atArcPosition} · ` : ''}${p.label}`} />
      <Section title="Beats" items={readerMap.beats} render={(b) => `[${b.kind}${b.intensity != null ? ` ${Math.round(b.intensity * 100)}%` : ''}] ${b.note || ''}`} />
      <Section title="Cliffhangers" items={readerMap.cliffhangers} render={(c) => `after #${c.atIssueBoundary ?? '?'} — ${c.note || ''}`} />
    </div>
  );
}

function RefineBox({ onRefine, busy, disabled }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="border-t border-port-border pt-3 mt-3">
      <label className="block text-xs text-gray-500 mb-1">AI refinement feedback</label>
      <div className="flex gap-2">
        <input
          type="text" value={feedback} onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. make the midpoint reveal land harder"
          disabled={disabled}
          className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm disabled:opacity-50"
        />
        <button
          onClick={() => onRefine(feedback)} disabled={busy || disabled}
          className="inline-flex items-center gap-1 bg-port-card border border-port-border hover:border-port-accent px-3 py-1.5 rounded text-sm disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Refine
        </button>
      </div>
    </div>
  );
}

function StepPanel({ session, universe, series, issues, stepId, locked, onChanged }) {
  const [busy, setBusy] = useState(false);
  const arc = series?.arc || {};

  const runGenerate = async () => {
    setBusy(true);
    const res = await generateStoryStep(session.id, stepId, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Generation failed'); return null; });
    setBusy(false);
    if (res) { toast.success('Generated'); onChanged(); }
  };
  const runRefine = async (feedback, entryId) => {
    setBusy(true);
    const res = await refineStoryStep(session.id, stepId, { feedback, entryId }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Refine failed'); return null; });
    setBusy(false);
    if (res) {
      toast.success(res.changes?.length ? `Refined — ${res.changes.length} change(s)` : 'Refined');
      onChanged();
    }
  };

  // Once a step has generated content, the button becomes "Re-generate" (with a
  // refresh icon) so it's clear it has already been run.
  const genButton = (label = 'Generate with AI', hasContent = false) => (
    <button
      onClick={runGenerate} disabled={busy || locked}
      className="inline-flex items-center gap-2 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (hasContent ? <RefreshCw className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />)}
      {hasContent ? 'Re-generate' : label}
    </button>
  );

  if (stepId === 'idea') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Working title" value={session.title} />
        <FieldBlock label="Starter idea" value={session.seedIdea} />
        {!locked && genButton('Expand idea with AI', Boolean((universe?.logline || '').trim()))}
        <p className="text-xs text-gray-500">Expanding seeds the universe starter prompt and series premise for the next steps.</p>
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
        {!locked && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} />}
      </div>
    );
  }
  if (stepId === 'plotArc') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Arc logline" value={arc.logline} />
        <FieldBlock label="Arc summary" value={arc.summary} />
        <FieldBlock label="Protagonist arc" value={arc.protagonistArc} />
        <FieldBlock label="Themes" value={(arc.themes || []).join(', ')} />
        <FieldBlock label="Emotional shape (Vonnegut)" value={arc.shape} />
        <div className="flex items-center gap-2">
          {!locked && genButton('Generate plot arc', Boolean((arc.logline || arc.summary || '').trim()))}
          {series?.id && (
            <Link to={`/pipeline/series/${series.id}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-port-accent">
              <ExternalLink className="w-4 h-4" /> Deep-edit on the Arc Canvas
            </Link>
          )}
        </div>
      </div>
    );
  }
  if (stepId === 'readerMap') {
    return (
      <div className="space-y-3">
        <ReaderMapView readerMap={arc.readerMap} />
        {!locked && genButton('Generate reader map', Boolean(arc.readerMap))}
        {!locked && arc.readerMap && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} />}
      </div>
    );
  }
  if (stepId === 'characters') {
    return <StepCharacters session={session} universe={universe} locked={locked} onChanged={onChanged} />;
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
// Reuses the Universe Builder's exact render path: composeStyledPrompt +
// universeStylePreset → generateImage → EntryThumbSlot (spinner → image), and
// persists the resulting filename onto the universe canon entry's imageRefs.
function StepCharacters({ session, universe, locked, onChanged }) {
  const cast = universe?.characters || [];
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [renderingJobs, setRenderingJobs] = useState({});
  const [refiningId, setRefiningId] = useState(null);
  // MediaJobThumb's onFilename effect can fire more than once (StrictMode +
  // the unstable per-render onComplete arrow); guard so each (char, filename)
  // append runs exactly once.
  const processedRef = useRef(new Set());

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => setImageCfg(readPipelineImageSettings(s)))
      .catch(() => {});
  }, []);

  const renderChar = async (c) => {
    const description = descriptorForCanonEntry('characters', c);
    if (!description.trim()) { toast.error(`Add a description for ${c.name} before generating a preview`); return; }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const styled = composeStyledPrompt(
      `${c.name}: ${description}`,
      baseOpts.negativePrompt || '',
      universe ? universeStylePreset(universe) : null,
    );
    const queued = await generateImage(
      { ...baseOpts, prompt: styled.prompt, negativePrompt: styled.negativePrompt || undefined },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Render failed'); return null; });
    if (!queued?.jobId) return;
    setRenderingJobs((p) => ({ ...p, [c.id]: queued.jobId }));
  };

  // Section-local renders don't carry a universeRun tag, so the server's
  // imageRef append hook never fires — persist the filename ourselves. Refetch
  // the freshest universe before appending so a sibling character's just-
  // persisted imageRef isn't clobbered by a stale full-array PATCH.
  const onCharRendered = async (charId, filename) => {
    setRenderingJobs((p) => { if (!p[charId]) return p; const n = { ...p }; delete n[charId]; return n; });
    if (!filename || !universe?.id) return;
    const key = `${charId}:${filename}`;
    if (processedRef.current.has(key)) return; // multi-fire guard
    processedRef.current.add(key);
    const fresh = await getUniverse(universe.id, { silent: true }).catch(() => null);
    const chars = (fresh?.characters) || universe.characters || [];
    const list = chars.map((e) => (
      e.id === charId
        ? { ...e, imageRefs: (e.imageRefs || []).includes(filename) ? e.imageRefs : [...(e.imageRefs || []), filename] }
        : e
    ));
    await updateUniverse(universe.id, { characters: list }, { silent: true }).catch(() => {});
    onChanged();
  };

  const refineChar = async (entryId) => {
    setRefiningId(entryId);
    const res = await refineStoryStep(session.id, 'characters', { entryId }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Refine failed'); return null; });
    setRefiningId(null);
    if (res) { toast.success(res.changes?.length ? `Refined — ${res.changes.length} change(s)` : 'Refined'); onChanged(); }
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
            onComplete={(fn) => onCharRendered(c.id, fn)}
            canRender={!locked && Boolean(universe?.id)}
            alt={c.name}
          />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{c.name} {c.locked && <Lock className="w-3 h-3 inline text-port-success" />}</div>
            <div className="text-xs text-gray-400">{c.physicalDescription || (Array.isArray(c.descriptor) ? c.descriptor.map((d) => d.value).join(', ') : '')}</div>
          </div>
          {!locked && (
            <button
              onClick={() => refineChar(c.id)} disabled={refiningId === c.id}
              className="text-xs inline-flex items-center gap-1 border border-port-border rounded px-2 py-1 hover:border-port-accent disabled:opacity-50 shrink-0"
            >
              {refiningId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Refine
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

  const toggleIssue = async (issueId, next) => {
    setBusyId(issueId);
    const res = await setStoryIssueLock(session.id, issueId, next, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed'); return null; });
    setBusyId(null);
    if (res) { toast.success(next ? 'Issue marked done' : 'Issue reopened'); onChanged(); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">Complete issues one at a time. Lock issue #1 before moving to #2.</p>
        {series?.id && (
          <Link to={`/pipeline/series/${series.id}`} className="text-sm text-port-accent inline-flex items-center gap-1">
            Plan issues in Pipeline <ExternalLink className="w-4 h-4" />
          </Link>
        )}
      </div>
      {(!issues || issues.length === 0) && (
        <p className="text-gray-600 italic text-sm">No issues yet — generate seasons on the plot-arc step, then plan issues in the Pipeline.</p>
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
  const [universe, setUniverse] = useState(null);
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const s = await getStorySession(storyId, { silent: true }).catch(() => null);
    if (!s) { setSession(null); setLoading(false); return; }
    setSession(s);
    setStaleSteps(s.staleSteps || []);
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

  // A step is reachable when every earlier step is locked AND not stale.
  // Returns `true` (reachable) or a discriminator string identifying the
  // first blocking earlier step's reason, so the caller can render the
  // matching toast ("Lock the earlier steps first" vs "Re-review the
  // stale earlier step first" — same boolean truthiness, different copy).
  const reachable = useCallback((idx) => {
    if (idx <= 0) return true;
    for (let i = 0; i < idx; i++) {
      const id = stepIds[i];
      if (session?.steps?.[id]?.locked !== true) return 'unlocked';
      if (staleSteps.includes(id)) return 'stale';
    }
    return true;
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
          .catch(() => {});
      }
    },
    lockedMessage: `${activeStep?.label || 'Step'} locked`,
    unlockedMessage: `${activeStep?.label || 'Step'} unlocked`,
    errorMessage: 'Failed to update lock',
  });

  const goToStep = async (id, idx) => {
    const why = reachable(idx);
    if (why !== true) {
      toast.error(why === 'stale'
        ? 'Re-review the stale earlier step first'
        : 'Lock the earlier steps first');
      return;
    }
    // Persist the current-step pointer (server re-gates); navigate optimistically.
    await setStoryCurrentStep(storyId, id, { silent: true }).catch(() => {});
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
            id="stb-detail"
          />
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
          {/* Step rail */}
          <nav className="space-y-1">
            {steps.map((s, idx) => {
              const st = session.steps?.[s.id] || { status: 'pending', locked: false };
              const stale = staleSteps.includes(s.id);
              const isActive = s.id === activeStepId;
              // `reachable` returns `true` or a string discriminator ('unlocked' / 'stale');
              // canGo must be strictly boolean — `disabled={!canGo}` would otherwise
              // treat the truthy string as "reachable" and re-enable a blocked button.
              const canGo = reachable(idx) === true;
              return (
                <button
                  key={s.id} onClick={() => goToStep(s.id, idx)} disabled={!canGo}
                  className={`w-full text-left px-3 py-2 rounded border flex items-center justify-between gap-2 ${
                    isActive ? 'border-port-accent bg-port-card' : 'border-transparent hover:bg-port-card'
                  } ${!canGo ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <span className="flex items-center gap-2 text-sm">
                    {st.locked ? <Lock className="w-3.5 h-3.5 text-port-success" /> : <span className="w-3.5 h-3.5 rounded-full border border-gray-600 inline-block" />}
                    {s.label}
                  </span>
                  {stale && <AlertTriangle className="w-3.5 h-3.5 text-port-warning" title="Stale — re-review" />}
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
            />

            {/* Footer: lock + navigation */}
            <div className="flex items-center justify-between border-t border-port-border pt-3 mt-3">
              <button
                onClick={() => lock.toggle(stepState.locked)} disabled={lock.busy}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm disabled:opacity-50 ${
                  stepState.locked ? 'bg-port-card border border-port-success text-port-success' : 'bg-port-success hover:bg-green-600 text-white'
                }`}
              >
                {lock.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (stepState.locked ? <Unlock className="w-4 h-4" /> : <Check className="w-4 h-4" />)}
                {stepState.locked ? 'Unlock to revise' : 'Lock & continue'}
              </button>

              <div className="flex items-center gap-2">
                {activeIdx > 0 && (
                  <button onClick={() => goToStep(stepIds[activeIdx - 1], activeIdx - 1)} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
                    <ChevronLeft className="w-4 h-4" /> Back
                  </button>
                )}
                {activeIdx < steps.length - 1 && (
                  <button
                    onClick={() => goToStep(stepIds[activeIdx + 1], activeIdx + 1)}
                    disabled={!stepState.locked || isStale}
                    className="inline-flex items-center gap-1 text-sm bg-port-accent hover:bg-blue-600 disabled:opacity-40 text-white px-3 py-1.5 rounded"
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
