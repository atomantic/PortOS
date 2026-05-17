import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileInput, Loader2, ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { STORY_SHAPES } from '../components/pipeline/StoryShapes';
import {
  analyzeImport,
  commitImport,
  IMPORTER_CONTENT_TYPES,
  IMPORTER_SOURCE_CHAR_LIMIT,
} from '../services/apiImporter';

const CONTENT_TYPE_LABELS = {
  'short-story': 'Short Story',
  'novel': 'Novel',
  'screenplay': 'Screenplay',
  'comic-script': 'Comic Script',
};

// Mirror of server `ARC_ROLES` in server/lib/storyArc.js. Server validates
// against the same list; a drift here means the dropdown can't propose a
// role the server would accept.
const ARC_ROLES = ['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale'];

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

  // Review-phase editable state. Held separately from `preview` so the user
  // can experiment without losing the LLM's original suggestions.
  const [canonSelections, setCanonSelections] = useState({ characters: [], places: [], objects: [] });
  const [arcDraft, setArcDraft] = useState(null);
  const [seasonsDraft, setSeasonsDraft] = useState([]);
  const [issuesDraft, setIssuesDraft] = useState([]);

  const sourceLen = intake.source.length;
  const sourceOver = sourceLen > IMPORTER_SOURCE_CHAR_LIMIT;

  const intakeValid = useMemo(() =>
    intake.universeName.trim() && intake.seriesName.trim() && intake.source.trim() && !sourceOver,
    [intake, sourceOver],
  );

  const [runAnalyze, analyzing] = useAsyncAction(async () => {
    const payload = {
      universeName: intake.universeName.trim(),
      seriesName: intake.seriesName.trim(),
      contentType: intake.contentType,
      source: intake.source,
    };
    const tic = intake.targetIssueCount === '' ? null : Number(intake.targetIssueCount);
    if (Number.isFinite(tic) && tic > 0) payload.targetIssueCount = tic;
    const result = await analyzeImport(payload);
    if (!result) return null;
    // Seed the editable Review-phase state from the preview.
    setPreview(result);
    setCanonSelections({
      characters: (result.canonPreview?.characters || []).map((e) => ({ ...e, _selected: true })),
      places: (result.canonPreview?.places || []).map((e) => ({ ...e, _selected: true })),
      objects: (result.canonPreview?.objects || []).map((e) => ({ ...e, _selected: true })),
    });
    setArcDraft(result.arcPreview ? { ...result.arcPreview } : null);
    setSeasonsDraft((result.seasonsPreview || []).map((s) => ({ ...s })));
    setIssuesDraft((result.issueProposals || []).map((i) => ({ ...i })));
    setPhase('review');
    return result;
  }, { errorMessage: 'Failed to analyze import' });

  const [runCommit, committing] = useAsyncAction(async () => {
    if (!preview) return null;
    const payload = {
      universeId: preview.universe.id,
      seriesId: preview.series.id,
      canonSelections: {
        characters: canonSelections.characters.filter((e) => e._selected).map(stripPrivate),
        places: canonSelections.places.filter((e) => e._selected).map(stripPrivate),
        objects: canonSelections.objects.filter((e) => e._selected).map(stripPrivate),
      },
      arc: arcDraft,
      seasons: seasonsDraft,
      issues: issuesDraft.map(stripPrivate),
    };
    const result = await commitImport(payload);
    if (!result) return null;
    toast.success(`Imported ${result.createdIssueIds.length} issue${result.createdIssueIds.length === 1 ? '' : 's'} into "${result.series.name}"`);
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
          analyzing={analyzing}
          onAnalyze={runAnalyze}
        />
      )}

      {phase === 'review' && preview && (
        <ReviewPanel
          preview={preview}
          canonSelections={canonSelections}
          setCanonSelections={setCanonSelections}
          arcDraft={arcDraft}
          setArcDraft={setArcDraft}
          seasonsDraft={seasonsDraft}
          setSeasonsDraft={setSeasonsDraft}
          issuesDraft={issuesDraft}
          setIssuesDraft={setIssuesDraft}
          committing={committing}
          onCommit={runCommit}
          onBack={() => setPhase('intake')}
        />
      )}
    </div>
  );
}

function stripPrivate(entry) {
  const { _selected, ...rest } = entry;
  return rest;
}

function IntakeForm({ intake, setIntake, intakeValid, sourceLen, sourceOver, analyzing, onAnalyze }) {
  return (
    <div className="space-y-4 bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
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
            {sourceLen.toLocaleString()} / {IMPORTER_SOURCE_CHAR_LIMIT.toLocaleString()} chars
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
    </div>
  );
}

function ReviewPanel({
  preview, canonSelections, setCanonSelections,
  arcDraft, setArcDraft, seasonsDraft, setSeasonsDraft,
  issuesDraft, setIssuesDraft,
  committing, onCommit, onBack,
}) {
  const toggleSelected = (kind, idx) => {
    setCanonSelections((cs) => ({
      ...cs,
      [kind]: cs[kind].map((e, i) => i === idx ? { ...e, _selected: !e._selected } : e),
    }));
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
        onToggle={(idx) => toggleSelected('characters', idx)}
        renderSubtitle={(e) => e.role || ''}
        renderBody={(e) => [e.physicalDescription, e.personality, e.background].filter(Boolean).join(' • ')}
      />

      <CanonReviewSection
        title="Places"
        kind="places"
        entries={canonSelections.places}
        onToggle={(idx) => toggleSelected('places', idx)}
        renderSubtitle={(e) => e.slugline || ''}
        renderBody={(e) => e.description || ''}
      />

      <CanonReviewSection
        title="Objects"
        kind="objects"
        entries={canonSelections.objects}
        onToggle={(idx) => toggleSelected('objects', idx)}
        renderSubtitle={() => ''}
        renderBody={(e) => [e.description, e.significance].filter(Boolean).join(' • ')}
      />

      <ArcReviewSection arc={arcDraft} setArc={setArcDraft} seasons={seasonsDraft} setSeasons={setSeasonsDraft} />

      <IssuesReviewSection issues={issuesDraft} setIssues={setIssuesDraft} seasons={seasonsDraft} />

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

function CanonReviewSection({ title, kind, entries, onToggle, renderSubtitle, renderBody }) {
  if (entries.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-xs text-port-text-muted">None extracted from the source.</p>
      </section>
    );
  }
  const selectedCount = entries.filter((e) => e._selected).length;
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
              entry._selected ? 'border-port-accent bg-port-accent/5' : 'border-port-border opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={!!entry._selected}
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
                      onChange={(e) => updateAt(seasons, setSeasons, idx, { number: Number(e.target.value) })}
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

function IssuesReviewSection({ issues, setIssues, seasons }) {
  if (issues.length === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Proposed Issues</h2>
        <p className="text-xs text-port-error">No issues proposed — the LLM did not split the source. Re-run analyze.</p>
      </section>
    );
  }
  const seasonOptions = seasons.length > 1
    ? [{ value: '', label: '(first season)' }, ...seasons.map((s) => ({ value: String(s.number), label: `S${s.number} — ${s.title || ''}` }))]
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
                  value={it.arcPosition ?? idx + 1}
                  onChange={(e) => updateAt(issues, setIssues, idx, { arcPosition: Number(e.target.value) })}
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
                  {ARC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
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

function updateAt(list, setList, idx, patch) {
  setList(list.map((e, i) => i === idx ? { ...e, ...patch } : e));
}
