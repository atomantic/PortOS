/**
 * Pipeline — Series Reader Map (Editorial Roadmap detail).
 *
 * Deep-linkable view (`/pipeline/series/:seriesId/roadmap`) of the editorial
 * analysis the EditorialRoadmapPanel summarizes: the aggregate Plot / Character
 * / Reader chart, the detected protagonist + supporting character arcs, and a
 * per-issue, section-by-section log of the reader's emotional journey.
 *
 * Data comes from GET /pipeline/series/:id/editorial (aggregate) and, lazily on
 * expand, GET /pipeline/issues/:id/editorial (full per-issue snapshot). Analysis
 * is kicked off via the same batch SSE runner the panel uses.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Sparkles, ChevronRight, ChevronDown, AlertTriangle, Crown, ChartSpline, Users,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { ArcRoadmapChart } from '../components/pipeline/ArcCanvas';
import ReaderPanelView from '../components/pipeline/ReaderPanelView';
import TabPills from '../components/ui/TabPills';
import {
  getPipelineSeries, getIssueEditorial, analyzeIssueEditorial,
} from '../services/api';
import { useSeriesEditorial } from '../hooks/useSeriesEditorial';

// Deep-linkable tabs (?tab=roadmap|panel) — the URL is the source of truth for
// which view is open, per the ID-based deep-linking convention.
const TABS = [
  { id: 'roadmap', label: 'Reader Map', icon: ChartSpline },
  { id: 'panel', label: 'Reader Panel', icon: Users },
];
const TAB_IDS = TABS.map((t) => t.id);

const DIR_TONE = {
  rising: 'text-emerald-300',
  falling: 'text-rose-300',
  complex: 'text-port-accent',
  flat: 'text-gray-400',
};

// Reader valence (−100..100) → a tone for the little valence pill.
function valenceTone(v) {
  if (v >= 25) return 'bg-emerald-500/20 text-emerald-300';
  if (v <= -25) return 'bg-rose-500/20 text-rose-300';
  return 'bg-gray-600/30 text-gray-300';
}

function MeterBar({ value, tone = 'bg-port-accent' }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full rounded-full bg-port-bg overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function SectionRow({ section, index }) {
  return (
    <li className="border border-port-border rounded p-2.5 bg-port-bg/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-200">{index + 1}. {section.label}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${valenceTone(section.valence)}`}>
          {section.primaryEmotion || '—'} · {section.valence > 0 ? `+${section.valence}` : section.valence}
        </span>
      </div>
      {section.excerpt ? <p className="text-[11px] text-gray-500 italic line-clamp-2">“{section.excerpt}”</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-gray-600 w-12 shrink-0">tension</span>
        <MeterBar value={section.tension} tone="bg-port-accent" />
        <span className="text-[10px] text-gray-500 w-7 text-right">{section.tension}</span>
      </div>
      {section.note ? <p className="text-[11px] text-gray-400">{section.note}</p> : null}
    </li>
  );
}

function IssueRow({ entry, onAnalyze, analyzing }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Fetch the section detail when the row is open, and REFETCH when the
  // snapshot identity (`analyzedAt`) changes — so a re-run while the row is
  // open replaces the cached log instead of showing the pre-re-run analysis.
  useEffect(() => {
    if (!open || !entry.analyzed) return undefined;
    let canceled = false;
    setLoadingDetail(true);
    getIssueEditorial(entry.issueId, { silent: true })
      .then((d) => { if (!canceled) setDetail(d && d.status !== 'none' ? d : null); })
      .catch(() => { if (!canceled) setDetail(null); })
      .finally(() => { if (!canceled) setLoadingDetail(false); });
    return () => { canceled = true; };
  }, [open, entry.analyzed, entry.analyzedAt, entry.issueId]);

  const toggle = () => setOpen((o) => !o);

  return (
    <li className="border border-port-border rounded-lg bg-port-card">
      <div className="flex items-center gap-2 p-2.5">
        <button type="button" onClick={toggle} className="flex items-center gap-2 flex-1 min-w-0 text-left" disabled={!entry.analyzed}>
          {entry.analyzed ? (open ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />) : <span className="w-3.5 shrink-0" />}
          <span className="text-[10px] font-mono text-gray-500 shrink-0">{entry.label}</span>
          <span className="text-sm text-gray-200 truncate">{entry.title || 'Untitled'}</span>
          {entry.stale ? <AlertTriangle size={12} className="text-port-warning shrink-0" title="Content changed since this was analyzed — re-run" /> : null}
        </button>
        {entry.analyzed ? (
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[10px] text-gray-500" title="Plot tension / Character progress / Reader valence">
              P{entry.plot} · C{entry.character} · R{entry.reader}
            </span>
            {entry.primaryEmotion ? <span className="text-[10px] text-amber-300">{entry.primaryEmotion}</span> : null}
          </div>
        ) : (
          <span className="text-[10px] text-gray-600 shrink-0">{entry.hasContent ? 'not analyzed' : 'no content'}</span>
        )}
        {entry.hasContent ? (
          <button
            type="button"
            onClick={() => onAnalyze(entry.issueId)}
            disabled={analyzing}
            className="text-[10px] px-1.5 py-1 rounded border border-port-border text-gray-400 hover:text-port-accent hover:border-port-accent/40 disabled:opacity-40 shrink-0"
            title={entry.analyzed ? 'Re-analyze this issue' : 'Analyze this issue'}
          >
            {analyzing ? <Loader2 size={11} className="animate-spin" /> : (entry.analyzed ? 'Re-run' : 'Analyze')}
          </button>
        ) : null}
      </div>
      {open && entry.analyzed ? (
        <div className="border-t border-port-border p-2.5">
          {loadingDetail ? (
            <div className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading…</div>
          ) : detail?.sections?.length ? (
            <ul className="space-y-1.5">
              {detail.sections.map((s, i) => <SectionRow key={s.id ?? `${s.title ?? 'section'}-${i}`} section={s} index={i} />)}
            </ul>
          ) : (
            <p className="text-xs text-gray-500 italic">No section detail available.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function CharacterArcs({ protagonist, supportingArcs, protagonistArcText }) {
  if (!protagonist && (!supportingArcs || supportingArcs.length === 0)) {
    return <p className="text-xs text-gray-500 italic">No character arcs detected yet — run the analysis.</p>;
  }
  return (
    <div className="space-y-2.5">
      {protagonist ? (
        <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <Crown size={14} className="text-emerald-300" />
            <span className="text-sm font-medium text-emerald-200">{protagonist.name}</span>
            <span className="text-[10px] uppercase tracking-wider text-emerald-400/70">protagonist · {protagonist.arcDirection}</span>
            <span className="text-[10px] text-gray-500 ml-auto">{protagonist.issueCount} issue{protagonist.issueCount === 1 ? '' : 's'}</span>
          </div>
          {protagonist.arcSummary ? <p className="mt-1.5 text-xs text-gray-300">{protagonist.arcSummary}</p> : null}
          {protagonistArcText ? <p className="mt-1.5 text-[11px] text-gray-500"><span className="text-gray-600">Intended arc:</span> {protagonistArcText}</p> : null}
        </div>
      ) : null}
      {supportingArcs && supportingArcs.length ? (
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Other characters with arcs</h3>
          <ul className="space-y-1.5">
            {supportingArcs.map((c) => (
              <li key={c.name} className="border border-port-border rounded p-2 bg-port-bg/40">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-200">{c.name}</span>
                  <span className={`text-[10px] ${DIR_TONE[c.arcDirection] || 'text-gray-400'}`}>{c.arcDirection}</span>
                  {c.role ? <span className="text-[10px] text-gray-600">{c.role}</span> : null}
                  <span className="text-[10px] text-gray-600 ml-auto">{c.issueCount} issue{c.issueCount === 1 ? '' : 's'}</span>
                </div>
                {c.arcSummary ? <p className="mt-1 text-[11px] text-gray-400">{c.arcSummary}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-gray-500 italic">No supporting characters with a distinct arc detected.</p>
      )}
    </div>
  );
}

export default function PipelineSeriesRoadmap() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [perIssueBusy, setPerIssueBusy] = useState(null); // issueId currently analyzing solo

  // A stale/typo'd deep link degrades to the roadmap tab rather than a blank view.
  const activeTab = TAB_IDS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'roadmap';
  const setActiveTab = useCallback((id) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'roadmap') next.delete('tab'); else next.set('tab', id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Shared editorial-roadmap state + batch lifecycle (load, re-attach, SSE,
  // start/cancel, reload). The EditorialRoadmapPanel uses the same hook.
  const {
    aggregate, reload, running, starting,
    startAnalysis, cancelAnalysis, coverage, roadmap, analyzedPoints, progressText,
  } = useSeriesEditorial(seriesId);

  // The series record (title) is this page's own concern; an error here means
  // the series doesn't exist, so bounce back to the index.
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    getPipelineSeries(seriesId)
      .then((s) => { if (!canceled) setSeries(s); })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load series');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  const analyzeOne = useCallback((issueId) => {
    setPerIssueBusy(issueId);
    analyzeIssueEditorial(issueId, { force: true }, { silent: true })
      .then(() => reload())
      .catch((err) => toast.error(err?.message || 'Analysis failed'))
      .finally(() => setPerIssueBusy(null));
  }, [reload]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <Loader2 size={18} className="animate-spin mr-2" /> Loading reader map…
      </div>
    );
  }

  // This route matches Layout's full-width list (startsWith('/pipeline/series/')),
  // so it gets a bare overflow-hidden <main> — the page owns its own scroll +
  // padding, matching the standard padded page (overflow-auto p-4 md:p-6).
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link to={`/pipeline/series/${seriesId}`} className="text-gray-400 hover:text-port-accent" title="Back to series">
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white flex items-center gap-2">
            <ChartSpline size={18} className="text-port-accent" /> Reader Map
          </h1>
          <p className="text-xs text-gray-500 truncate">{series?.name}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {activeTab !== 'roadmap' ? null : running ? (
            <button type="button" onClick={cancelAnalysis} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-port-border text-gray-300 hover:border-port-error/50">
              <Loader2 size={13} className="animate-spin" /> {progressText || 'Analyzing…'} (cancel)
            </button>
          ) : (
            <button
              type="button"
              onClick={startAnalysis}
              disabled={starting || coverage.withContent === 0}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25 disabled:opacity-40 disabled:cursor-not-allowed"
              title={coverage.withContent === 0 ? 'No drafted content to analyze yet' : 'Run an LLM pass over each issue with content'}
            >
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {coverage.analyzed > 0 ? 'Re-run all' : 'Run analysis'}
            </button>
          )}
        </div>
      </div>

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={setActiveTab}
        size="sm"
        ariaLabel="Reader Map view"
        mobileDropdown
        mobileSelectId="reader-map-tab"
      />

      {activeTab === 'panel' ? (
        <ReaderPanelView seriesId={seriesId} hasContent={coverage.withContent > 0} />
      ) : (
      <>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)] gap-4 items-start">
        <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-gray-500">Arc curves</h2>
            <p className="text-[11px] text-gray-600">
              <span className={coverage.stale ? 'text-port-warning' : ''}>
                {coverage.analyzed}/{coverage.total} analyzed{coverage.stale ? ` · ${coverage.stale} stale` : ''}
              </span>
            </p>
          </div>
          <div className="h-64 rounded border border-port-border bg-port-bg/70 p-3">
            {analyzedPoints.length ? (
              <ArcRoadmapChart points={analyzedPoints} />
            ) : (
              <div className="h-full flex items-center justify-center text-center text-xs text-gray-500 italic px-4">
                {coverage.withContent === 0
                  ? 'No drafted content yet. Write or generate prose/scripts, then run the analysis.'
                  : 'Not analyzed yet. Run the analysis to map the reader’s journey from the content.'}
              </div>
            )}
          </div>
          <p className="text-[11px] text-gray-600">
            <span className="text-port-accent">Plot</span> = narrative tension ·{' '}
            <span className="text-emerald-300">Character</span> = protagonist arc progress ·{' '}
            <span className="text-amber-300">Reader</span> = emotional journey (0 = bleak, 100 = joyful)
          </p>
        </section>

        <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-gray-500">Character arcs</h2>
          <CharacterArcs
            protagonist={aggregate?.protagonist}
            supportingArcs={aggregate?.supportingArcs}
            protagonistArcText={aggregate?.protagonistArcText}
          />
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Per-issue reader journey</h2>
        {roadmap.length ? (
          <ul className="space-y-2">
            {roadmap.map((entry) => (
              <IssueRow
                key={entry.issueId}
                entry={entry}
                onAnalyze={analyzeOne}
                analyzing={perIssueBusy === entry.issueId || running}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-500 italic">This series has no issues yet.</p>
        )}
      </section>
      </>
      )}
    </div>
  );
}
