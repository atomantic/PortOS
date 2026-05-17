import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileInput, Loader2, ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { STORY_SHAPES } from '../components/pipeline/StoryShapes';
import {
  analyzeImport,
  commitImport,
  getImporterConfig,
  IMPORTER_CONTENT_TYPES,
  IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
  IMPORTER_ARC_ROLES_FALLBACK,
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

  // Server-canonical config (source-char limit + arc-roles enum). Falls back
  // to the shipped client defaults until the GET resolves. Hydrated on mount
  // so the intake form's char-count warning + the review form's arc-role
  // dropdown stay aligned with the server even when the server bumps the cap
  // or extends the enum without a client redeploy.
  const [config, setConfig] = useState({
    sourceCharLimit: IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
    arcRoles: IMPORTER_ARC_ROLES_FALLBACK,
  });
  // Ref to the AbortController of the in-flight config GET so analyze can
  // cancel it before firing — closes the GET-resolves-after-analyze race
  // window where the GET's setConfig would clobber analyze-supplied values.
  const abortConfigRef = useRef(null);
  useEffect(() => {
    // Silent — the fallback values are correct for the shipped client, so a
    // transient network blip doesn't need to toast.
    //
    // AbortController guards against a late-resolving config GET clobbering
    // a server-side bump that the analyze response already applied. The
    // user can navigate to /importer, fire Analyze faster than the config
    // GET round-trip, and the GET-vs-analyze race would otherwise overwrite
    // analyze's setConfig with the server-default fallback values whenever
    // the GET resolves last. Aborting on unmount + on first analyze closes
    // the window.
    const ac = new AbortController();
    abortConfigRef.current = ac;
    getImporterConfig({ silent: true, signal: ac.signal }).then((cfg) => {
      if (ac.signal.aborted || !cfg) return;
      setConfig({
        sourceCharLimit: Number.isFinite(cfg.sourceCharLimit) ? cfg.sourceCharLimit : IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
        arcRoles: Array.isArray(cfg.arcRoles) && cfg.arcRoles.length > 0 ? cfg.arcRoles : IMPORTER_ARC_ROLES_FALLBACK,
      });
    }).catch((err) => {
      // Aborts (analyze fires first, unmount) are expected — silent.
      // Real network/server errors are NOT expected — surface them so a
      // misconfigured /importer/config doesn't silently fall back to
      // client defaults forever without operator feedback.
      if (ac.signal.aborted) return;
      console.warn(`⚠️ Importer config fetch failed — using client fallbacks: ${err?.message || err}`);
    });
    return () => ac.abort();
  }, []);

  // Review-phase editable state. Held separately from `preview` so the user
  // can experiment without losing the LLM's original suggestions.
  //
  // `canonSelections` holds the clean (no UI flags) LLM-extracted entries.
  // `selectedCanon` tracks which indexes are checked via parallel Sets — one
  // per kind — so no UI flag ever touches the canon entry objects that flow
  // to the commit payload.
  const [canonSelections, setCanonSelections] = useState({ characters: [], places: [], objects: [] });
  const [selectedCanon, setSelectedCanon] = useState({ characters: new Set(), places: new Set(), objects: new Set() });
  const [arcDraft, setArcDraft] = useState(null);
  const [seasonsDraft, setSeasonsDraft] = useState([]);
  const [issuesDraft, setIssuesDraft] = useState([]);

  const sourceLen = intake.source.length;
  const sourceOver = sourceLen > config.sourceCharLimit;

  const intakeValid = useMemo(() =>
    intake.universeName.trim() && intake.seriesName.trim() && intake.source.trim() && !sourceOver,
    [intake, sourceOver],
  );

  const [runAnalyze, analyzing] = useAsyncAction(async () => {
    // Cancel any still-in-flight config GET — its setConfig would
    // otherwise resolve AFTER analyze's setConfig (which uses the
    // server-fresh response.limits/arcRoles) and clobber it with the
    // potentially-stale on-mount fetch values.
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
    // Seed the editable Review-phase state from the preview.
    setPreview(result);
    const chars = result.canonPreview?.characters || [];
    const places = result.canonPreview?.places || [];
    const objects = result.canonPreview?.objects || [];
    setCanonSelections({ characters: chars, places, objects });
    // All entries selected by default — track via index Sets, not object flags.
    setSelectedCanon({
      characters: new Set(chars.map((_, i) => i)),
      places: new Set(places.map((_, i) => i)),
      objects: new Set(objects.map((_, i) => i)),
    });
    // arcDraft is sent verbatim as the commit's `arc` field — strip non-arc
    // keys (e.g. the LLM's top-level `seasons`) at seed time so they can't
    // smuggle into series.arc if the wire schema tightens.
    setArcDraft(pickArcFields(result.arcPreview));
    setSeasonsDraft((result.seasonsPreview || []).map((s) => ({ ...s })));
    setIssuesDraft((result.issueProposals || []).map((i) => ({ ...i })));
    // Server may have surfaced an updated source-char limit or arc-roles
    // list — accept it for the rest of this session if the analyze response
    // carries them, so the review form stays aligned with whatever the
    // server is currently enforcing.
    if (result.limits?.sourceCharLimit) {
      setConfig((c) => ({ ...c, sourceCharLimit: result.limits.sourceCharLimit }));
    }
    if (Array.isArray(result.arcRoles) && result.arcRoles.length > 0) {
      setConfig((c) => ({ ...c, arcRoles: result.arcRoles }));
    }
    setPhase('review');
    return result;
  }, { errorMessage: 'Failed to analyze import' });

  const [runCommit, committing] = useAsyncAction(async () => {
    if (!preview) return null;
    const payload = {
      universeId: preview.universe.id,
      seriesId: preview.series.id,
      canonSelections: {
        characters: canonSelections.characters.filter((_, i) => selectedCanon.characters.has(i)),
        places: canonSelections.places.filter((_, i) => selectedCanon.places.has(i)),
        objects: canonSelections.objects.filter((_, i) => selectedCanon.objects.has(i)),
      },
      arc: pickArcFields(arcDraft),
      seasons: seasonsDraft,
      issues: issuesDraft,
    };
    const result = await commitImport(payload, { silent: true });
    if (!result) return null;
    toast.success(`Imported ${result.createdIssueIds.length} issue${result.createdIssueIds.length === 1 ? '' : 's'} into "${result.series.name}"`);
    // Surface season-remap warnings so the user sees when an issue landed in
    // a different season than they (or the LLM) proposed — silent fallback
    // would otherwise be invisible. Use the server-reported landed season
    // metadata so the toast names the actual season (S2 — Diaspora), not a
    // generic "first season" that can lie when seasons are sparsely numbered.
    if (Array.isArray(result.remappedIssues) && result.remappedIssues.length > 0) {
      const n = result.remappedIssues.length;
      const noun = `${n} issue${n === 1 ? '' : 's'}`;
      const landedSeasonless = result.remappedIssues.every((r) => r.actualSeasonId == null);
      let msg;
      if (landedSeasonless) {
        msg = `${noun} created ungrouped — no seasons exist on this series to land them in.`;
      } else {
        // All remapped issues land in the same fallback season today, so
        // the first entry's metadata describes them all.
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
    <div className="max-w-6xl mx-auto p-4 sm:p-6 text-port-text">
      <header className="mb-6 flex items-start gap-3">
        <FileInput className="w-7 h-7 text-port-accent mt-1" />
        <div>
          <h1 className="text-2xl font-bold">Importer</h1>
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
          intakeValid={intakeValid}
          sourceLen={sourceLen}
          sourceOver={sourceOver}
          sourceCharLimit={config.sourceCharLimit}
          analyzing={analyzing}
          onAnalyze={runAnalyze}
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
          committing={committing}
          onCommit={runCommit}
          onBack={() => setPhase('intake')}
        />
      )}
    </div>
  );
}

function IntakeForm({ intake, setIntake, intakeValid, sourceLen, sourceOver, sourceCharLimit, analyzing, onAnalyze }) {
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
        <legend className="block text-sm font-medium mb-2">Content Type</legend>
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
  arcRoles,
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
            {preview.isExistingSeries ? 'extending series' : 'new series'} <span className="text-port-accent">"{preview.series.name}"</span>
          </div>
          <p className="text-xs text-port-text-muted mt-1">
            Review the canon below, edit any issue titles or synopses, then click Commit to seed
            the pipeline. The verbatim prose excerpt for each issue lands in <code>stages.prose.output</code>.
          </p>
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

      <ArcReviewSection arc={arcDraft} setArc={setArcDraft} seasons={seasonsDraft} setSeasons={setSeasonsDraft} />

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
          className="bg-port-success hover:bg-port-success/80 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded text-sm font-medium flex items-center gap-2"
        >
          {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          {committing ? 'Committing…' : `Commit ${issuesDraft.length} issue${issuesDraft.length === 1 ? '' : 's'}`}
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {entries.map((entry, idx) => (
          <label
            key={`${kind}-${idx}`}
            className={`flex items-start gap-3 border rounded p-3 cursor-pointer text-sm ${
              selectedIdxs.has(idx) ? 'border-port-accent bg-port-accent/5' : 'border-port-border opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={selectedIdxs.has(idx)}
              onChange={() => onToggle(idx)}
              className="mt-1 accent-port-accent"
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{entry.name || '(unnamed)'}</div>
              {renderSubtitle(entry) && (
                <div className="text-xs text-port-text-muted truncate">{renderSubtitle(entry)}</div>
              )}
              {renderBody(entry) && (
                <div className="text-xs text-port-text-muted mt-1 line-clamp-3">{renderBody(entry)}</div>
              )}
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}

// Immutably update the element at `idx` in a state-managed list.
function updateAt(list, setList, idx, patch) {
  setList(list.map((e, i) => i === idx ? { ...e, ...patch } : e));
}

function ArcReviewSection({ arc, setArc, seasons, setSeasons }) {
  if (!arc && seasons.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Arc</h2>
        <p className="text-xs text-port-text-muted">LLM did not produce an arc — series will be created without arc metadata.</p>
      </section>
    );
  }
  const a = arc || {};
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
            {STORY_SHAPES.map((s) => (
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
              <div key={`season-${idx}`} className="border border-port-border rounded p-3">
                <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr] gap-3">
                  <div>
                    <label htmlFor={`season-${idx}-number`} className="block text-xs font-medium mb-1">#</label>
                    <input
                      id={`season-${idx}-number`}
                      type="number"
                      min="1"
                      max="99"
                      value={s.number ?? ''}
                      onChange={(e) => updateAt(seasons, setSeasons, idx, {
                        // Empty input -> undefined so the service's auto-assign
                        // path picks the next free number. Avoids `Number('') = 0`
                        // landing in state and failing the `>= 1` gate at commit.
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
                      value={s.title || ''}
                      onChange={(e) => updateAt(seasons, setSeasons, idx, { title: e.target.value })}
                      className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
                    />
                  </div>
                </div>
                <label htmlFor={`season-${idx}-synopsis`} className="block text-xs font-medium mb-1 mt-2">Synopsis</label>
                <textarea
                  id={`season-${idx}-synopsis`}
                  value={s.synopsis || ''}
                  onChange={(e) => updateAt(seasons, setSeasons, idx, { synopsis: e.target.value })}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm min-h-[60px]"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function IssuesReviewSection({ issues, setIssues, seasons, arcRoles }) {
  if (issues.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Proposed Issues</h2>
        <p className="text-xs text-port-error">No issues proposed — the LLM did not split the source. Re-run analyze.</p>
      </section>
    );
  }
  // Drop seasons with no finite `number` — the season-number input lets
  // the user clear the field (storing `undefined`) and `String(undefined)`
  // would otherwise produce `value: "undefined"`, which onChange would
  // coerce to NaN and Zod would later reject as an opaque commit failure.
  // The dropdown should only offer addressable seasons; user can pick the
  // "(first season)" fallback for an issue while they fix the numberless
  // season's number in the Arc section.
  const numberedSeasons = seasons.filter((s) => Number.isFinite(s.number));
  const seasonOptions = numberedSeasons.length > 1
    ? [
        { value: '', label: '(first season)' },
        ...numberedSeasons.map((s) => ({ value: String(s.number), label: `S${s.number} — ${s.title || ''}` })),
      ]
    : null;
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-lg font-semibold mb-3">Proposed Issues ({issues.length})</h2>
      <div className="space-y-3">
        {issues.map((it, idx) => (
          <div key={`issue-${idx}`} className="border border-port-border rounded p-3">
            <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr_140px_140px] gap-3">
              <div>
                <label htmlFor={`iss-${idx}-pos`} className="block text-xs font-medium mb-1">Pos</label>
                <input
                  id={`iss-${idx}-pos`}
                  type="number"
                  min="1"
                  max="9999"
                  // Display empty when state is undefined so the field
                  // reflects state honestly: a previously-rendered idx+1
                  // would lie to the user about what the commit payload
                  // sends. The "auto" placeholder signals the service
                  // will pick the next free position on commit.
                  value={it.arcPosition ?? ''}
                  placeholder="auto"
                  onChange={(e) => updateAt(issues, setIssues, idx, {
                    // Empty input -> undefined so the service's auto-assign
                    // path picks the next free position. Avoids `Number('') = 0`
                    // landing in state and failing the `>= 1` gate at commit.
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
                  value={it.title || ''}
                  onChange={(e) => updateAt(issues, setIssues, idx, { title: e.target.value })}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label htmlFor={`iss-${idx}-role`} className="block text-xs font-medium mb-1">Arc Role</label>
                <select
                  id={`iss-${idx}-role`}
                  value={it.arcRole || ''}
                  onChange={(e) => updateAt(issues, setIssues, idx, { arcRole: e.target.value || undefined })}
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
                    value={it.seasonNumber == null ? '' : String(it.seasonNumber)}
                    onChange={(e) => updateAt(issues, setIssues, idx, {
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
              value={it.synopsis || ''}
              onChange={(e) => updateAt(issues, setIssues, idx, { synopsis: e.target.value })}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm min-h-[50px]"
            />
            <div className="text-xs text-port-text-muted mt-1">
              Prose excerpt: {(it.proseExcerpt || '').length.toLocaleString()} chars (verbatim from source — kept as-is)
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
