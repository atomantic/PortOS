import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileInput, Loader2, ArrowLeft, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { STORY_SHAPES } from '../components/pipeline/StoryShapes';
import EntryCard from '../components/universe/EntryCard';
import {
  analyzeImport,
  classifyImport,
  commitImport,
  getImporterConfig,
  IMPORTER_CONTENT_TYPES,
  IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
  CLASSIFY_SOURCE_HEAD_CHARS,
} from '../services/apiImporter';

const CONTENT_TYPE_LABELS = {
  'short-story': 'Short Story',
  'novel': 'Novel',
  'screenplay': 'Screenplay',
  'comic-script': 'Comic Script',
};

// Whitelist of arc fields forwarded to the commit endpoint. The wire schema
// (`importerArcShape`) is `.passthrough()` today and `sanitizeArc` ignores
// unknowns, but `arcDraft` starts as a shallow clone of the LLM's arc
// output — which still has the LLM-returned `seasons` field at the top
// level. Without this strip the seasons would smuggle through to
// `series.arc` if the schema ever tightens to `.strict()`.
const ARC_FIELDS_TO_COMMIT = ['logline', 'summary', 'protagonistArc', 'themes', 'shape'];
const pickArcFields = (arc) => {
  if (!arc) return null;
  const out = {};
  for (const k of ARC_FIELDS_TO_COMMIT) {
    if (arc[k] !== undefined) out[k] = arc[k];
  }
  return out;
};

const emptyIntake = () => ({
  universeName: '',
  seriesName: '',
  contentType: 'short-story',
  source: '',
  targetIssueCount: '',
});

export default function Importer() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState('intake'); // 'intake' | 'review'
  const [intake, setIntake] = useState(emptyIntake);
  const [preview, setPreview] = useState(null);

  // Server is the source of truth for the enums — a prior client-side copy
  // (`IMPORTER_ARC_ROLES_FALLBACK`) silently drifted, so we wait on the GET
  // rather than shadow it. `arcShapeIds: null` means "config not loaded
  // yet; render all STORY_SHAPES" — distinguishes from "server shipped []".
  const [config, setConfig] = useState({
    sourceCharLimit: IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
    arcRoles: [],
    arcShapeIds: null,
  });
  // Analyze aborts the in-flight config GET so its late-resolving setConfig
  // can't clobber analyze's server-fresh values.
  const abortConfigRef = useRef(null);
  useEffect(() => {
    const ac = new AbortController();
    abortConfigRef.current = ac;
    getImporterConfig({ silent: true, signal: ac.signal }).then((cfg) => {
      if (ac.signal.aborted || !cfg) return;
      setConfig({
        sourceCharLimit: Number.isFinite(cfg.sourceCharLimit) ? cfg.sourceCharLimit : IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
        arcRoles: Array.isArray(cfg.arcRoles) ? cfg.arcRoles : [],
        arcShapeIds: Array.isArray(cfg.arcShapeIds) && cfg.arcShapeIds.length > 0 ? cfg.arcShapeIds : null,
      });
    }).catch((err) => {
      if (ac.signal.aborted) return;
      console.warn(`⚠️ Importer config fetch failed — using client fallbacks: ${err?.message || err}`);
    });
    return () => ac.abort();
  }, []);

  const [canonSelections, setCanonSelections] = useState({ characters: [], places: [], objects: [] });
  const [selectedCanon, setSelectedCanon] = useState({ characters: new Set(), places: new Set(), objects: new Set() });
  const [arcDraft, setArcDraft] = useState(null);
  const [seasonsDraft, setSeasonsDraft] = useState([]);
  const [issuesDraft, setIssuesDraft] = useState([]);
  // Server already persisted universe+series+arc but the issue-loop rolled
  // back. The next commit drops arc/seasons/canon so a retry can't overwrite
  // server-side edits made between attempts.
  const [arcAlreadyPersisted, setArcAlreadyPersisted] = useState(false);
  // Destructive opt-in for existing series — wipes issues + overwrites arc.
  const [replaceMode, setReplaceMode] = useState(false);
  const [classifyHint, setClassifyHint] = useState(null);

  // Stale hint after the source changes would mislead the user.
  useEffect(() => { setClassifyHint(null); }, [intake.source]);

  const [runClassify, classifying] = useAsyncAction(async () => {
    if (!intake.source.trim()) return null;
    const result = await classifyImport({ source: intake.source.slice(0, CLASSIFY_SOURCE_HEAD_CHARS) }, { silent: true });
    if (!result) return null;
    if (result.contentType && IMPORTER_CONTENT_TYPES.includes(result.contentType)) {
      setIntake((prev) => ({ ...prev, contentType: result.contentType }));
    }
    setClassifyHint({
      contentType: result.contentType,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
    return result;
  }, { errorMessage: 'Auto-detect failed' });

  const [runAnalyze, analyzing] = useAsyncAction(async () => {
    // A late-resolving config GET would clobber the server-fresh values in
    // `result.limits` / `arcRoles` / `arcShapeIds` below.
    abortConfigRef.current?.abort();
    const payload = {
      universeName: intake.universeName.trim(),
      seriesName: intake.seriesName.trim(),
      contentType: intake.contentType,
      source: intake.source,
    };
    const tic = intake.targetIssueCount === '' ? null : Number(intake.targetIssueCount);
    if (Number.isFinite(tic) && tic > 0) payload.targetIssueCount = tic;
    const result = await analyzeImport(payload, { silent: true });
    if (!result) return null;
    setPreview(result);
    const chars = result.canonPreview?.characters || [];
    const places = result.canonPreview?.places || [];
    const objects = result.canonPreview?.objects || [];
    setCanonSelections({ characters: chars, places, objects });
    setSelectedCanon({
      characters: new Set(chars.map((_, i) => i)),
      places: new Set(places.map((_, i) => i)),
      objects: new Set(objects.map((_, i) => i)),
    });
    // Strip non-arc keys (e.g. the LLM's top-level `seasons`) at seed time
    // — guards against the wire schema tightening to `.strict()`.
    setArcDraft(pickArcFields(result.arcPreview));
    setSeasonsDraft((result.seasonsPreview || []).map((s) => ({ ...s })));
    setIssuesDraft((result.issueProposals || []).map((i) => ({ ...i })));
    setArcAlreadyPersisted(false);
    setReplaceMode(false);
    setConfig((c) => ({
      ...c,
      ...(Number.isFinite(result.limits?.sourceCharLimit) ? { sourceCharLimit: result.limits.sourceCharLimit } : {}),
      ...(Array.isArray(result.arcRoles) && result.arcRoles.length > 0 ? { arcRoles: result.arcRoles } : {}),
      ...(Array.isArray(result.arcShapeIds) && result.arcShapeIds.length > 0 ? { arcShapeIds: result.arcShapeIds } : {}),
    }));
    setPhase('review');
    return result;
  }, { errorMessage: 'Failed to analyze import' });

  const [runCommit, committing] = useAsyncAction(async () => {
    if (!preview) return null;
    // arcAlreadyPersisted retry: server kept arc/seasons/canon from the
    // failed commit, so resending them would clobber any subsequent edits.
    const base = {
      universeId: preview.universe.id,
      seriesId: preview.series.id,
      issues: issuesDraft,
    };
    const payload = arcAlreadyPersisted
      ? { ...base, canonSelections: { characters: [], places: [], objects: [] }, arc: null, seasons: [] }
      : {
          ...base,
          canonSelections: {
            characters: canonSelections.characters.filter((_, i) => selectedCanon.characters.has(i)),
            places: canonSelections.places.filter((_, i) => selectedCanon.places.has(i)),
            objects: canonSelections.objects.filter((_, i) => selectedCanon.objects.has(i)),
          },
          arc: pickArcFields(arcDraft),
          seasons: seasonsDraft,
          ...(replaceMode && preview.isExistingSeries ? { replaceMode: true } : {}),
        };
    const result = await commitImport(payload, { silent: true }).catch((err) => {
      if (err?.code === 'IMPORTER_PARTIAL_COMMIT_ISSUES' && err?.context?.arcAlreadyPersisted) {
        setArcAlreadyPersisted(true);
        toast.warning('Arc + seasons saved; issues failed and were rolled back. Retry to re-create the issues only — the arc won\'t be re-sent.');
      }
      throw err;
    });
    if (!result) return null;
    toast.success(`Imported ${result.createdIssueIds.length} issue${result.createdIssueIds.length === 1 ? '' : 's'} into "${result.series.name}"`);
    if (Array.isArray(result.remappedIssues) && result.remappedIssues.length > 0) {
      const n = result.remappedIssues.length;
      const noun = `${n} issue${n === 1 ? '' : 's'}`;
      const landedSeasonless = result.remappedIssues.every((r) => r.actualSeasonId == null);
      let msg;
      if (landedSeasonless) {
        msg = `${noun} created ungrouped — no seasons exist on this series to land them in.`;
      } else {
        const sample = result.remappedIssues[0];
        const seasonLabel = sample.actualSeasonNumber != null
          ? `S${sample.actualSeasonNumber}${sample.actualSeasonTitle ? ` — ${sample.actualSeasonTitle}` : ''}`
          : 'the available season';
        msg = `${noun} landed in ${seasonLabel} — the requested season number didn't exist.`;
      }
      toast.warning(msg);
    }
    navigate(`/pipeline/series/${result.series.id}`);
    return result;
  }, { errorMessage: 'Failed to commit import' });

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-3">
        <FileInput className="w-7 h-7 text-port-accent mt-1" />
        <div>
          <h1 className="text-2xl font-bold text-white">Importer</h1>
          <p className="text-sm text-port-text-muted mt-1">
            Reverse-engineer a finished story, novel, screenplay, or comic script into the pipeline.
            The LLM extracts universe canon, the story arc, and a proposed issue split; you review,
            edit, and commit.
          </p>
        </div>
      </header>

      {phase === 'intake' && (
        <IntakeForm
          intake={intake}
          setIntake={setIntake}
          sourceCharLimit={config.sourceCharLimit}
          analyzing={analyzing}
          onAnalyze={runAnalyze}
          classifying={classifying}
          onClassify={runClassify}
          classifyHint={classifyHint}
        />
      )}

      {phase === 'review' && preview && (
        <ReviewPanel
          preview={preview}
          canonSelections={canonSelections}
          selectedCanon={selectedCanon}
          setSelectedCanon={setSelectedCanon}
          arcDraft={arcDraft}
          setArcDraft={setArcDraft}
          seasonsDraft={seasonsDraft}
          setSeasonsDraft={setSeasonsDraft}
          issuesDraft={issuesDraft}
          setIssuesDraft={setIssuesDraft}
          arcRoles={config.arcRoles}
          arcShapeIds={config.arcShapeIds}
          replaceMode={replaceMode}
          setReplaceMode={setReplaceMode}
          committing={committing}
          onCommit={runCommit}
          onBack={() => setPhase('intake')}
        />
      )}
    </div>
  );
}

function IntakeForm({ intake, setIntake, sourceCharLimit, analyzing, onAnalyze, classifying, onClassify, classifyHint }) {
  const sourceLen = intake.source.length;
  const sourceOver = sourceLen > sourceCharLimit;
  const intakeValid = intake.universeName.trim() && intake.seriesName.trim() && intake.source.trim() && !sourceOver;
  const canClassify = intake.source.trim().length > 0 && !sourceOver && !classifying && !analyzing;
  return (
    <form
      className="space-y-4 bg-port-card border border-port-border rounded-lg p-4 sm:p-6"
      // Swallow default form submission so an accidental Enter in any input
      // doesn't trigger Analyze — Analyze fires three heavy-tier LLM calls
      // and accidental triggering costs real money. Tab to the button + Space
      // is the keyboard path; the round-4 Enter-submits flow was reverted in
      // round 6 after this cost trade-off was surfaced.
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="importer-universe-name" className="block text-sm font-medium mb-1">
            Universe Name
          </label>
          <input
            id="importer-universe-name"
            type="text"
            value={intake.universeName}
            onChange={(e) => setIntake({ ...intake, universeName: e.target.value })}
            placeholder="e.g. Cyberpunk 2099"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent"
            maxLength={200}
          />
          <p className="text-xs text-port-text-muted mt-1">Existing universe is matched by name (case-insensitive); otherwise created fresh.</p>
        </div>
        <div>
          <label htmlFor="importer-series-name" className="block text-sm font-medium mb-1">
            Series Name
          </label>
          <input
            id="importer-series-name"
            type="text"
            value={intake.seriesName}
            onChange={(e) => setIntake({ ...intake, seriesName: e.target.value })}
            placeholder="e.g. The Choir Awakens"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent"
            maxLength={200}
          />
          <p className="text-xs text-port-text-muted mt-1">Series match is scoped to the universe — same name in a different universe creates a fresh series.</p>
        </div>
      </div>

      <fieldset>
        <div className="flex items-center justify-between mb-2">
          <legend className="block text-sm font-medium">Content Type</legend>
          <button
            type="button"
            onClick={onClassify}
            disabled={!canClassify}
            title={canClassify
              ? 'Run a light-tier LLM pass on the source head to auto-detect the content type. The radio stays editable.'
              : 'Paste source text first to enable auto-detect.'}
            className="text-xs text-port-text-muted hover:text-port-text disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {classifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            {classifying ? 'Detecting…' : 'Auto-detect'}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {IMPORTER_CONTENT_TYPES.map((ct) => (
            <label
              key={ct}
              className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer text-sm ${
                intake.contentType === ct
                  ? 'border-port-accent bg-port-accent/10'
                  : 'border-port-border hover:border-port-text-muted'
              }`}
            >
              <input
                type="radio"
                name="contentType"
                value={ct}
                checked={intake.contentType === ct}
                onChange={() => setIntake({ ...intake, contentType: ct })}
                className="accent-port-accent"
              />
              {CONTENT_TYPE_LABELS[ct]}
            </label>
          ))}
        </div>
        {classifyHint && classifyHint.contentType && (
          <p className="text-xs text-port-text-muted mt-2 flex items-start gap-1">
            <Wand2 className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span>
              Auto-detected <strong>{CONTENT_TYPE_LABELS[classifyHint.contentType] || classifyHint.contentType}</strong>
              {classifyHint.confidence && <> ({classifyHint.confidence} confidence)</>}
              {classifyHint.reasoning && <> — {classifyHint.reasoning}</>}
            </span>
          </p>
        )}
      </fieldset>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="importer-source" className="block text-sm font-medium">
            Source Text
          </label>
          <span className={`text-xs ${sourceOver ? 'text-port-error' : 'text-port-text-muted'}`}>
            {sourceLen.toLocaleString()} / {sourceCharLimit.toLocaleString()} chars
          </span>
        </div>
        <textarea
          id="importer-source"
          value={intake.source}
          onChange={(e) => setIntake({ ...intake, source: e.target.value })}
          placeholder="Paste the full text here…"
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-port-accent min-h-[280px]"
        />
        {sourceOver && (
          <p className="text-xs text-port-error mt-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Source exceeds the v1 limit. Trim it or wait for chunked-extraction support.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="importer-target-issue-count" className="block text-sm font-medium mb-1">
            Target Issue Count (optional)
          </label>
          <input
            id="importer-target-issue-count"
            type="number"
            min="1"
            max="50"
            value={intake.targetIssueCount}
            onChange={(e) => setIntake({ ...intake, targetIssueCount: e.target.value })}
            placeholder="LLM decides"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent"
          />
          <p className="text-xs text-port-text-muted mt-1">Leave blank to let the LLM split based on natural chapter/issue/act boundaries.</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!intakeValid || analyzing}
          className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded text-sm font-medium flex items-center gap-2"
        >
          {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileInput className="w-4 h-4" />}
          {analyzing ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
    </form>
  );
}

function ReviewPanel({
  preview, canonSelections,
  selectedCanon, setSelectedCanon,
  arcDraft, setArcDraft, seasonsDraft, setSeasonsDraft,
  issuesDraft, setIssuesDraft,
  arcRoles, arcShapeIds,
  replaceMode, setReplaceMode,
  committing, onCommit, onBack,
}) {
  const toggleSelected = (kind, idx) => {
    setSelectedCanon((sc) => {
      const next = new Set(sc[kind]);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return { ...sc, [kind]: next };
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 flex items-start gap-3 text-sm">
        <CheckCircle2 className="w-5 h-5 text-port-success mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="font-medium">
            {preview.isExistingUniverse ? 'Adding to' : 'Creating new universe'} <span className="text-port-accent">"{preview.universe.name}"</span>
            {' / '}
            {preview.isExistingSeries
              ? (replaceMode ? 'REPLACING series' : 'extending series')
              : 'new series'} <span className="text-port-accent">"{preview.series.name}"</span>
          </div>
          <p className="text-xs text-port-text-muted mt-1">
            Review the canon below, edit any issue titles or synopses, then click Commit to seed
            the pipeline. The verbatim prose excerpt for each issue lands in <code>stages.prose.output</code>.
          </p>
          {preview.isExistingSeries && (
            <label className={`text-xs mt-2 flex items-center gap-2 cursor-pointer ${replaceMode ? 'text-port-error' : 'text-port-text-muted'}`}>
              <input
                type="checkbox"
                checked={replaceMode}
                onChange={(e) => setReplaceMode(e.target.checked)}
                className="accent-port-error"
              />
              <AlertTriangle className="w-3 h-3" />
              <span>
                <strong>Replace all</strong> — wipe every existing issue on this series and overwrite arc + seasons with this import. <em>Cannot be undone.</em>
              </span>
            </label>
          )}
        </div>
        <button onClick={onBack} className="text-xs text-port-text-muted hover:text-port-text flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Back
        </button>
      </div>

      <CanonReviewSection
        title="Characters"
        kind="characters"
        entries={canonSelections.characters}
        selectedIdxs={selectedCanon.characters}
        onToggle={(idx) => toggleSelected('characters', idx)}
        renderSubtitle={(e) => e.role || ''}
        renderBody={(e) => [e.physicalDescription, e.personality, e.background].filter(Boolean).join(' • ')}
      />

      <CanonReviewSection
        title="Places"
        kind="places"
        entries={canonSelections.places}
        selectedIdxs={selectedCanon.places}
        onToggle={(idx) => toggleSelected('places', idx)}
        renderSubtitle={(e) => e.slugline || ''}
        renderBody={(e) => e.description || ''}
      />

      <CanonReviewSection
        title="Objects"
        kind="objects"
        entries={canonSelections.objects}
        selectedIdxs={selectedCanon.objects}
        onToggle={(idx) => toggleSelected('objects', idx)}
        renderSubtitle={() => ''}
        renderBody={(e) => [e.description, e.significance].filter(Boolean).join(' • ')}
      />

      <ArcReviewSection arc={arcDraft} setArc={setArcDraft} seasons={seasonsDraft} setSeasons={setSeasonsDraft} arcShapeIds={arcShapeIds} />

      <IssuesReviewSection issues={issuesDraft} setIssues={setIssuesDraft} seasons={seasonsDraft} arcRoles={arcRoles} />

      <div className="sticky bottom-4 flex items-center justify-end gap-2 bg-port-card border border-port-border rounded-lg p-3 shadow-lg">
        <button
          onClick={onBack}
          disabled={committing}
          className="text-port-text-muted hover:text-port-text px-3 py-2 text-sm"
        >
          Back to Intake
        </button>
        <button
          onClick={onCommit}
          disabled={committing || issuesDraft.length === 0}
          className={`disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded text-sm font-medium flex items-center gap-2 ${
            replaceMode
              ? 'bg-port-error hover:bg-port-error/80'
              : 'bg-port-success hover:bg-port-success/80'
          }`}
        >
          {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : (replaceMode ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />)}
          {committing
            ? 'Committing…'
            : (replaceMode
                ? `Replace with ${issuesDraft.length} issue${issuesDraft.length === 1 ? '' : 's'}`
                : `Commit ${issuesDraft.length} issue${issuesDraft.length === 1 ? '' : 's'}`)}
        </button>
      </div>
    </div>
  );
}

function CanonReviewSection({ title, kind, entries, selectedIdxs, onToggle, renderSubtitle, renderBody }) {
  if (entries.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-xs text-port-text-muted">None extracted from the source.</p>
      </section>
    );
  }
  const selectedCount = selectedIdxs.size;
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          {title} <span className="text-sm font-normal text-port-text-muted">({selectedCount} / {entries.length} selected)</span>
        </h2>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {entries.map((entry, idx) => {
          const subtitle = renderSubtitle(entry);
          const bodyText = renderBody(entry);
          const name = entry.name || '(unnamed)';
          return (
            <EntryCard
              key={`${kind}-${idx}`}
              selectable={{
                selected: selectedIdxs.has(idx),
                onToggle: () => onToggle(idx),
                label: `Include ${name}`,
              }}
              title={<div className="font-medium truncate text-sm">{name}</div>}
              body={(
                <>
                  {subtitle ? <div className="text-xs text-port-text-muted truncate">{subtitle}</div> : null}
                  {bodyText ? <div className="text-xs text-port-text-muted mt-1 line-clamp-3">{bodyText}</div> : null}
                </>
              )}
            />
          );
        })}
      </ul>
    </section>
  );
}

// Functional updater keeps unchanged map entries referentially identical,
// so React.memo on the per-item card lets siblings bail out of render when
// one card is edited. ~50 issues with 500K-char prose previews were laggy
// without this.
const makePatcher = (setList) => (idx, patch) => {
  setList((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
};

function ArcReviewSection({ arc, setArc, seasons, setSeasons, arcShapeIds }) {
  const patchSeasonAt = useMemo(() => makePatcher(setSeasons), [setSeasons]);
  if (!arc && seasons.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Arc</h2>
        <p className="text-xs text-port-text-muted">LLM did not produce an arc — series will be created without arc metadata.</p>
      </section>
    );
  }
  const a = arc || {};
  // Filter so the dropdown can never offer a shape the commit-side
  // `z.enum(ARC_SHAPE_IDS)` would reject. `null` sentinel = config not yet
  // loaded; show all client shapes meanwhile.
  const allowedShapes = Array.isArray(arcShapeIds) && arcShapeIds.length > 0
    ? STORY_SHAPES.filter((s) => arcShapeIds.includes(s.id))
    : STORY_SHAPES;
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <h2 className="text-lg font-semibold">Arc</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="arc-logline" className="block text-sm font-medium mb-1">Logline</label>
          <input
            id="arc-logline"
            type="text"
            value={a.logline || ''}
            onChange={(e) => setArc({ ...a, logline: e.target.value })}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent"
          />
        </div>
        <div>
          <label htmlFor="arc-shape" className="block text-sm font-medium mb-1">Shape (Vonnegut)</label>
          <select
            id="arc-shape"
            value={a.shape || ''}
            onChange={(e) => setArc({ ...a, shape: e.target.value || undefined })}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent"
          >
            <option value="">— pick one —</option>
            {allowedShapes.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="arc-summary" className="block text-sm font-medium mb-1">Summary</label>
        <textarea
          id="arc-summary"
          value={a.summary || ''}
          onChange={(e) => setArc({ ...a, summary: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent min-h-[120px]"
        />
      </div>
      <div>
        <label htmlFor="arc-protagonist" className="block text-sm font-medium mb-1">Protagonist Arc</label>
        <textarea
          id="arc-protagonist"
          value={a.protagonistArc || ''}
          onChange={(e) => setArc({ ...a, protagonistArc: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm focus:outline-none focus:border-port-accent min-h-[80px]"
        />
      </div>
      {seasons.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Seasons ({seasons.length})</h3>
          <div className="space-y-2">
            {seasons.map((s, idx) => (
              <SeasonCard key={`season-${idx}`} idx={idx} season={s} onPatch={patchSeasonAt} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const SeasonCard = memo(function SeasonCard({ idx, season, onPatch }) {
  return (
    <div className="border border-port-border rounded p-3">
      <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr] gap-3">
        <div>
          <label htmlFor={`season-${idx}-number`} className="block text-xs font-medium mb-1">#</label>
          <input
            id={`season-${idx}-number`}
            type="number"
            min="1"
            max="99"
            value={season.number ?? ''}
            onChange={(e) => onPatch(idx, {
              number: e.target.value === '' ? undefined : Number(e.target.value),
            })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label htmlFor={`season-${idx}-title`} className="block text-xs font-medium mb-1">Title</label>
          <input
            id={`season-${idx}-title`}
            type="text"
            value={season.title || ''}
            onChange={(e) => onPatch(idx, { title: e.target.value })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
          />
        </div>
      </div>
      <label htmlFor={`season-${idx}-synopsis`} className="block text-xs font-medium mb-1 mt-2">Synopsis</label>
      <textarea
        id={`season-${idx}-synopsis`}
        value={season.synopsis || ''}
        onChange={(e) => onPatch(idx, { synopsis: e.target.value })}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm min-h-[60px]"
      />
    </div>
  );
});

const IssueCard = memo(function IssueCard({ idx, issue, onPatch, arcRoles, seasonOptions }) {
  // Local state, not lifted — keeps the collapse toggle off the issues array
  // so a card-internal click doesn't broadcast to every memoized sibling.
  const [proseExpanded, setProseExpanded] = useState(false);
  const proseLen = (issue.proseExcerpt || '').length;
  return (
    <div className="border border-port-border rounded p-3">
      <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr_140px_140px] gap-3">
        <div>
          <label htmlFor={`iss-${idx}-pos`} className="block text-xs font-medium mb-1">Pos</label>
          <input
            id={`iss-${idx}-pos`}
            type="number"
            min="1"
            max="9999"
            // Display empty when state is undefined so the "auto" placeholder
            // honestly signals the service will pick the next free position
            // on commit (a rendered idx+1 would lie about the payload).
            value={issue.arcPosition ?? ''}
            placeholder="auto"
            onChange={(e) => onPatch(idx, {
              // `Number('') === 0` would land 0 in state and fail the `>= 1`
              // gate at commit — undefined triggers server auto-assign instead.
              arcPosition: e.target.value === '' ? undefined : Number(e.target.value),
            })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label htmlFor={`iss-${idx}-title`} className="block text-xs font-medium mb-1">Title</label>
          <input
            id={`iss-${idx}-title`}
            type="text"
            value={issue.title || ''}
            onChange={(e) => onPatch(idx, { title: e.target.value })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label htmlFor={`iss-${idx}-role`} className="block text-xs font-medium mb-1">Arc Role</label>
          <select
            id={`iss-${idx}-role`}
            value={issue.arcRole || ''}
            onChange={(e) => onPatch(idx, { arcRole: e.target.value || undefined })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
          >
            <option value="">—</option>
            {arcRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {seasonOptions ? (
          <div>
            <label htmlFor={`iss-${idx}-season`} className="block text-xs font-medium mb-1">Season</label>
            <select
              id={`iss-${idx}-season`}
              value={issue.seasonNumber == null ? '' : String(issue.seasonNumber)}
              onChange={(e) => onPatch(idx, {
                seasonNumber: e.target.value === '' ? undefined : Number(e.target.value),
              })}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
            >
              {seasonOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        ) : <div />}
      </div>
      <label htmlFor={`iss-${idx}-syn`} className="block text-xs font-medium mb-1 mt-2">Synopsis</label>
      <textarea
        id={`iss-${idx}-syn`}
        value={issue.synopsis || ''}
        onChange={(e) => onPatch(idx, { synopsis: e.target.value })}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm min-h-[50px]"
      />
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setProseExpanded((v) => !v)}
          className="text-xs text-port-text-muted hover:text-port-text flex items-center gap-1"
          aria-expanded={proseExpanded}
          aria-controls={`iss-${idx}-prose`}
        >
          {proseExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Prose excerpt: {proseLen.toLocaleString()} chars
          <span className="text-port-text-muted/70">— {proseExpanded ? 'click to collapse' : 'click to edit (verbatim from source)'}</span>
        </button>
        {proseExpanded && (
          <textarea
            id={`iss-${idx}-prose`}
            value={issue.proseExcerpt || ''}
            onChange={(e) => onPatch(idx, { proseExcerpt: e.target.value })}
            // Monospace + tall default so the user sees enough lines to
            // trim/correct a boundary without re-running Analyze (which
            // burns 3 heavy-tier LLM calls). The textarea grows to fit
            // browser-native scrolling when proseExcerpt is large.
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs font-mono mt-2 min-h-[200px]"
            // Allow tab character entry rather than focus-traversal — the
            // user is editing prose, not navigating a form.
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
});

function IssuesReviewSection({ issues, setIssues, seasons, arcRoles }) {
  const patchIssueAt = useMemo(() => makePatcher(setIssues), [setIssues]);
  // Memo'd so `seasonOptions`'s identity is stable across issue-only edits
  // — otherwise every keystroke would break React.memo on every IssueCard.
  // Drops numberless seasons because the dropdown can only offer
  // addressable ones; user can pick the lowest-numbered fallback while
  // they fix the numberless season's number in the Arc section.
  const seasonOptions = useMemo(() => {
    const numberedSeasons = seasons.filter((s) => Number.isFinite(s.number));
    if (numberedSeasons.length <= 1) return null;
    // Server's fallback is the lowest-numbered season — not array[0]
    // (sparsely-numbered seasons like [S2, S5, S99] make "first" lie).
    const fallbackSeason = [...numberedSeasons].sort((a, b) => a.number - b.number)[0];
    const fallbackLabel = `(lowest-numbered: S${fallbackSeason.number}${fallbackSeason.title ? ` — ${fallbackSeason.title}` : ''})`;
    return [
      { value: '', label: fallbackLabel },
      ...numberedSeasons.map((s) => ({ value: String(s.number), label: `S${s.number} — ${s.title || ''}` })),
    ];
  }, [seasons]);
  if (issues.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Proposed Issues</h2>
        <p className="text-xs text-port-error">No issues proposed — the LLM did not split the source. Re-run analyze.</p>
      </section>
    );
  }
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-lg font-semibold mb-3">Proposed Issues ({issues.length})</h2>
      <div className="space-y-3">
        {issues.map((it, idx) => (
          <IssueCard
            key={`issue-${idx}`}
            idx={idx}
            issue={it}
            onPatch={patchIssueAt}
            arcRoles={arcRoles}
            seasonOptions={seasonOptions}
          />
        ))}
      </div>
    </section>
  );
}
