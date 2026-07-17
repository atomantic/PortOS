/**
 * Pipeline — Continuity Bible / Series Continuity view (#1305, PR 1).
 *
 * A browsable established-facts ledger: the concrete, checkable facts the story
 * has committed to, grouped by category (physical traits, ages, dates, places,
 * possessions, world rules, who-knows-what-when). Facts are auto-seeded from
 * universe canon (locked canon = ground truth) and learned from the drafted
 * prose. Each prose fact deep-links to the issue where it was established.
 * Generation streams progress over SSE; the ledger flags itself stale when the
 * manuscript or canon changes.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw, X, ArrowLeft, BookOpen, AlertTriangle, BookMarked, Lock } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getPipelineSeries,
  getContinuityBible,
  generateContinuityBible,
  cancelContinuityBible,
  getContinuityBibleStatus,
  pipelineContinuityBibleSseUrl,
} from '../services/api';
import { usePipelineProgress } from '../hooks/usePipelineProgress';

const RUN_ENDED = new Set(['complete', 'canceled', 'cancelled', 'error']);

// The server ships `ledger.categories` (its FACT_CATEGORIES) with every
// response, so section order + labels come from the server and can't drift.
// This is only a fallback for a payload that predates that field.
const FALLBACK_CATEGORIES = [
  { id: 'physical', label: 'Physical traits' },
  { id: 'age', label: 'Ages & birthdays' },
  { id: 'timeline', label: 'Dates & elapsed time' },
  { id: 'location', label: 'Locations & geography' },
  { id: 'possession', label: 'Possessions & wardrobe' },
  { id: 'world-rule', label: 'World rules' },
  { id: 'knowledge', label: 'Who knows what, when' },
];

export default function PipelineContinuityBible() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const activeRunIdRef = useRef(null);

  // Load series + ledger, and re-attach to an in-flight run on (re)mount.
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    Promise.all([
      getPipelineSeries(seriesId, { silent: true }),
      getContinuityBible(seriesId, { silent: true }),
      getContinuityBibleStatus(seriesId).catch(() => ({ active: false })),
    ])
      .then(([s, l, status]) => {
        if (canceled) return;
        setSeries(s);
        setLedger(l);
        if (status?.active) setActive(true);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load continuity bible');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  const { latest } = usePipelineProgress(pipelineContinuityBibleSseUrl, [seriesId], { enabled: active });

  // React to the terminal frame: refetch the ledger, drop the busy state.
  useEffect(() => {
    if (!active || !latest || !RUN_ENDED.has(latest.type)) return;
    if (activeRunIdRef.current && latest.runId && latest.runId !== activeRunIdRef.current) return;
    setActive(false);
    activeRunIdRef.current = null;
    if (latest.type === 'complete') {
      getContinuityBible(seriesId).then((l) => setLedger(l)).catch(() => {});
      if (latest.status === 'no-content') toast.warning('Nothing to build a ledger from — add canon or draft a manuscript first');
      else toast.success(`Continuity bible ready — ${latest.factCount || 0} facts`);
    } else if (latest.type === 'canceled') {
      toast.success('Continuity bible canceled');
    } else {
      toast.error(latest.error || 'Continuity bible failed');
    }
  }, [active, latest, seriesId]);

  const handleGenerate = async (force) => {
    setStarting(true);
    // Await the POST so the run is registered server-side BEFORE the SSE
    // subscription connects — otherwise the progress stream 404s on attach.
    const res = await generateContinuityBible(seriesId, { force }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to start continuity bible');
      return null;
    });
    setStarting(false);
    if (!res?.runId) return;
    activeRunIdRef.current = res.runId;
    setActive(true);
  };

  const handleCancel = () => {
    cancelContinuityBible(seriesId).catch(() => {});
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  const facts = ledger?.facts || [];
  const completed = ledger?.status === 'complete';
  const hasLedger = completed && facts.length > 0;
  const busy = active || starting;
  const categories = ledger?.categories?.length ? ledger.categories : FALLBACK_CATEGORIES;
  const groups = categories
    .map((cat) => ({ ...cat, facts: facts.filter((f) => f.category === cat.id) }))
    .filter((g) => g.facts.length > 0);
  const canonCount = facts.filter((f) => f.source === 'canon').length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-2 mb-4">
        <Link
          to={`/pipeline/series/${seriesId}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
          title="Back to series"
        >
          <ArrowLeft size={12} /> Series
        </Link>
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <BookMarked size={18} className="text-port-accent" /> Series Continuity
        </h1>
        {series?.name ? <span className="text-sm text-gray-400 truncate">— {series.name}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-port-border bg-port-card text-sm text-gray-300 hover:text-white"
            >
              <X size={14} /> Cancel
            </button>
          ) : null}
          <button
            type="button"
            // Force a rebuild whenever a run already completed — even one that
            // extracted 0 facts — otherwise the server returns the cached empty
            // ledger on every retry until the manuscript or canon changes.
            onClick={() => handleGenerate(completed)}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            title={completed ? 'Re-extract the facts ledger from canon + the current manuscript' : 'Build the facts ledger from canon + the drafted manuscript'}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {busy ? 'Building…' : completed ? 'Rebuild ledger' : 'Build ledger'}
          </button>
        </div>
      </header>

      {ledger?.stale && hasLedger ? (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg border border-port-warning/40 bg-port-warning/10 text-port-warning text-sm">
          <AlertTriangle size={14} />
          The manuscript or canon changed since this ledger was built — rebuild to refresh.
        </div>
      ) : null}

      {!hasLedger ? (
        <EmptyState status={ledger?.status} active={busy} />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <FactGroup key={group.id} group={group} seriesId={seriesId} navigate={navigate} />
          ))}
          <p className="text-xs text-gray-500">
            {facts.length} facts · {canonCount} from canon · {facts.length - canonCount} from prose
            {ledger?.truncated ? ' · manuscript truncated for analysis (long series)' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

function EmptyState({ status, active }) {
  if (active) {
    return (
      <div className="text-center text-gray-400 py-16">
        <Loader2 className="animate-spin mx-auto mb-3" size={24} />
        Extracting established facts from canon and the manuscript…
      </div>
    );
  }
  if (status === 'no-content') {
    return (
      <div className="text-center text-gray-400 py-16">
        <BookOpen className="mx-auto mb-3 opacity-40" size={28} />
        No canon and nothing drafted yet. Add characters/places/objects or write a manuscript, then build the ledger.
      </div>
    );
  }
  return (
    <div className="text-center text-gray-400 py-16">
      <BookMarked className="mx-auto mb-3 opacity-40" size={28} />
      No continuity bible yet. Build one to ledger the facts your story has established.
    </div>
  );
}

function FactGroup({ group, seriesId, navigate }) {
  return (
    <section className="border border-port-border rounded-lg overflow-hidden">
      <h2 className="px-3 py-2 bg-port-card text-sm font-semibold text-white flex items-center gap-2">
        {group.label}
        <span className="text-xs text-gray-500 font-normal">{group.facts.length}</span>
      </h2>
      <ul className="divide-y divide-port-border/50">
        {group.facts.map((fact) => (
          <FactRow key={fact.id} fact={fact} seriesId={seriesId} navigate={navigate} />
        ))}
      </ul>
    </section>
  );
}

function FactRow({ fact, seriesId, navigate }) {
  const fromCanon = fact.source === 'canon';
  return (
    <li className="px-3 py-2 flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <span className="text-xs font-medium text-gray-200 shrink-0 mt-0.5">{fact.subject}</span>
        <span className="text-sm text-gray-300 flex-1">{fact.statement}</span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
            fromCanon ? 'bg-port-accent/15 text-port-accent' : 'bg-port-border/40 text-gray-400'
          }`}
          title={fromCanon ? (fact.canonical ? 'Seeded from locked canon (ground truth)' : 'Seeded from universe canon') : 'Learned from the drafted prose'}
        >
          {fromCanon && fact.canonical ? <Lock size={9} /> : null}
          {fromCanon ? 'canon' : 'prose'}
        </span>
      </div>
      {(fact.anchorQuote || fact.issueNumber != null) ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {fact.anchorQuote ? <span className="italic truncate">“{fact.anchorQuote}”</span> : null}
          {fact.issueNumber != null ? (
            <button
              type="button"
              onClick={() => navigate(`/pipeline/series/${seriesId}/manuscript/${fact.issueNumber}`)}
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-gray-400 hover:text-white border border-port-border shrink-0"
              title="Open the issue where this fact is established"
            >
              <BookOpen size={11} /> Issue {fact.issueNumber}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
