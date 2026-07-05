/**
 * Reader Panel view (#2170, CWQE Phase 6) — the "Reader Panel" tab on the Reader
 * Map page. Four personas each read a condensed arc digest and answer the same
 * qualitative questions; this renders their answers side-by-side plus the mined
 * disagreement list (consensus concerns routed to manuscript-review findings,
 * softer "editorial attention" judgment calls, and best-vs-worst polarizing
 * splits). Convening the panel spends one LLM call per persona and runs only from
 * the explicit button here (AI-provider policy).
 */

import { Link } from 'react-router-dom';
import { Loader2, Sparkles, Users, AlertTriangle, Scale, Split, ArrowRight } from 'lucide-react';
import { useReaderPanel } from '../../hooks/useReaderPanel';

// Mirror server/lib/editorial/panelDisagreement.js persona + question labels
// (keep in sync — the two are small, stable vocabularies).
const PERSONA_LABELS = {
  editor: 'The Editor',
  'genre-reader': 'The Genre Reader',
  writer: 'The Writer',
  'first-reader': 'The First Reader',
};
const PERSONA_ORDER = ['editor', 'genre-reader', 'writer', 'first-reader'];
const QUESTION_LABELS = [
  ['momentum_loss', 'Momentum lost'],
  ['earned_ending', 'Earned ending'],
  ['cut_candidate', 'Cut candidate'],
  ['missing_scene', 'Missing scene'],
  ['thinnest_character', 'Thinnest character'],
  ['best_scene', 'Best scene'],
  ['worst_scene', 'Worst scene'],
  ['would_recommend', 'Would recommend'],
  ['haunts_you', 'Haunts you'],
  ['next_book', 'Next book'],
];

const personaLabel = (id) => PERSONA_LABELS[id] || id;
const IssueTags = ({ issues }) => (
  issues?.length ? (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {issues.map((n) => (
        <span key={n} className="text-[9px] font-mono px-1 rounded bg-port-bg text-gray-400 border border-port-border">#{n}</span>
      ))}
    </span>
  ) : null
);

function PersonaColumn({ response }) {
  const answers = response.answers || {};
  return (
    <div className="border border-port-border rounded-lg bg-port-card flex flex-col min-w-0">
      <div className="p-2.5 border-b border-port-border">
        <div className="flex items-center gap-2">
          <Users size={13} className="text-port-accent shrink-0" />
          <span className="text-sm font-medium text-gray-100 truncate">{personaLabel(response.persona)}</span>
        </div>
        {response.verdict ? <p className="mt-1 text-[11px] text-gray-400 italic">“{response.verdict}”</p> : null}
      </div>
      <dl className="p-2.5 space-y-2 overflow-y-auto">
        {QUESTION_LABELS.map(([qid, label]) => {
          const a = answers[qid];
          if (!a || !a.text) return null;
          return (
            <div key={qid}>
              <dt className="text-[10px] uppercase tracking-wider text-gray-500">{label}<IssueTags issues={a.issues} /></dt>
              <dd className="text-[11px] text-gray-300 mt-0.5">{a.text}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function PersonaChips({ ids }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {(ids || []).map((id) => (
        <span key={id} className="text-[9px] px-1.5 py-0.5 rounded-full bg-port-bg text-gray-300 border border-port-border">{personaLabel(id)}</span>
      ))}
    </span>
  );
}

// consensus + attention are the same concern shape (differ only in tone) — one
// helper renders both; polarizing has its own loved/hated shape below.
function ConcernSection({ items, icon: Icon, title, headTone, itemClass, metaTone, labelClass }) {
  if (!items?.length) return null;
  return (
    <div>
      <h3 className={`text-[11px] uppercase tracking-wider ${headTone} mb-1.5 flex items-center gap-1.5`}>
        <Icon size={12} /> {title}
      </h3>
      <ul className="space-y-1.5">
        {items.map((c, i) => (
          <li key={`${c.questionId}-${c.issueNumber}-${i}`} className={`border rounded p-2 ${itemClass}`}>
            <div className="flex items-center gap-2 flex-wrap text-xs text-gray-300">
              <span className={`font-mono text-[10px] ${metaTone}`}>#{c.issueNumber}</span>
              <span className={labelClass}>{c.questionLabel}</span>
              <span className={`text-[10px] ${metaTone}`}>{c.count}/{c.totalPersonas}</span>
              <PersonaChips ids={c.personas} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DisagreementList({ disagreements }) {
  const { consensus = [], attention = [], polarizing = [], totalPersonas = 0 } = disagreements || {};
  const nothing = !consensus.length && !attention.length && !polarizing.length;
  if (nothing) {
    return <p className="text-xs text-gray-500 italic">The panel found no notable disagreements — a rare and suspicious consensus.</p>;
  }
  const withTotal = (list) => list.map((c) => ({ ...c, totalPersonas }));
  return (
    <div className="space-y-4">
      <ConcernSection
        items={withTotal(consensus)}
        icon={AlertTriangle}
        title="Consensus concerns — routed to editorial findings"
        headTone="text-port-error/80"
        itemClass="border-port-error/30 bg-port-error/5"
        metaTone="text-gray-400"
        labelClass="font-medium text-gray-200"
      />
      <ConcernSection
        items={withTotal(attention)}
        icon={Scale}
        title="Editorial attention — some flagged, some didn’t"
        headTone="text-port-warning/80"
        itemClass="border-port-border bg-port-bg/40"
        metaTone="text-gray-500"
        labelClass=""
      />

      {polarizing.length ? (
        <div>
          <h3 className="text-[11px] uppercase tracking-wider text-port-accent/80 mb-1.5 flex items-center gap-1.5">
            <Split size={12} /> Polarizing — one persona’s best is another’s worst
          </h3>
          <ul className="space-y-1.5">
            {polarizing.map((p, i) => (
              <li key={`${p.issueNumber}-${i}`} className="border border-port-accent/30 bg-port-accent/5 rounded p-2">
                <div className="flex items-center gap-2 flex-wrap text-xs text-gray-300">
                  <span className="font-mono text-[10px] text-gray-500">#{p.issueNumber}</span>
                  <span className="text-emerald-300">loved:</span><PersonaChips ids={p.lovedBy} />
                  <span className="text-rose-300">worst:</span><PersonaChips ids={p.hatedBy} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default function ReaderPanelView({ seriesId, hasContent }) {
  const { panel, loading, running, starting, convene, cancel, progressText } = useReaderPanel(seriesId);
  const hasPanel = panel && panel.status === 'complete' && Array.isArray(panel.personas) && panel.personas.length;
  const orderedPersonas = hasPanel
    ? [...panel.personas].sort((a, b) => PERSONA_ORDER.indexOf(a.persona) - PERSONA_ORDER.indexOf(b.persona))
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-[11px] text-gray-500 flex-1 min-w-0">
          Four reader personas read a condensed arc digest and answer the same questions. Their disagreements are the editorial signal;
          issues flagged by 3+ personas enter the{' '}
          <Link to="/pipeline/editorial-checks" className="text-port-accent hover:underline">editorial findings</Link> triage flow.
        </p>
        {running ? (
          <button type="button" onClick={cancel} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-port-border text-gray-300 hover:border-port-error/50 shrink-0">
            <Loader2 size={13} className="animate-spin" /> {progressText || 'Convening…'} (cancel)
          </button>
        ) : (
          <button
            type="button"
            onClick={convene}
            disabled={starting || !hasContent}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title={!hasContent ? 'No drafted content to read yet' : 'Convene the four-persona reader panel (one LLM call per persona)'}
          >
            {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {hasPanel ? 'Re-convene panel' : 'Convene panel'}
          </button>
        )}
      </div>

      {panel?.stale ? (
        <p className="text-[11px] text-port-warning flex items-center gap-1.5">
          <AlertTriangle size={12} /> The manuscript changed since this panel met — re-convene for a current read.
        </p>
      ) : null}

      {loading ? (
        <div className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading panel…</div>
      ) : !hasPanel ? (
        <div className="border border-dashed border-port-border rounded-lg p-6 text-center">
          <Users size={20} className="text-gray-600 mx-auto mb-2" />
          <p className="text-sm text-gray-400">The reader panel hasn’t met yet.</p>
          <p className="text-[11px] text-gray-600 mt-1">
            {hasContent ? 'Convene the panel to hear four distinct reads of the series.' : 'Draft some issue content first, then convene the panel.'}
          </p>
        </div>
      ) : (
        <>
          <section className="bg-port-card border border-port-border rounded-lg p-4">
            <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
              <ArrowRight size={13} className="text-port-accent" /> Where the panel disagrees
            </h2>
            <DisagreementList disagreements={panel.disagreements} />
          </section>

          <section>
            <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-2">The four reads</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-start">
              {orderedPersonas.map((r) => <PersonaColumn key={r.persona} response={r} />)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
