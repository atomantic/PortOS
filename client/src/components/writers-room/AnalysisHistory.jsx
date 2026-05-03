import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clapperboard, FileSignature, Loader2, RotateCcw, Sparkles, Users } from 'lucide-react';
import toast from '../ui/Toast';
import { listWritersRoomAnalyses, getWritersRoomAnalysis } from '../../services/apiWritersRoom';
import { timeAgo } from '../../utils/formatters';
import useMounted from '../../hooks/useMounted';

const KIND_ICON = { evaluate: Sparkles, format: FileSignature, script: Clapperboard, characters: Users };
const KIND_LABEL = { evaluate: 'Evaluate', format: 'Format', script: 'Adapt', characters: 'Characters' };

const SEVERITY_COLOR = {
  major: 'text-port-error border-port-error/40',
  moderate: 'text-port-warning border-port-warning/40',
  minor: 'text-gray-400 border-port-border',
};

// Read-only history of past Evaluate / Format / Adapt / Characters runs.
// `onApplyFormat` is the only mutation hook — Format-pass results call it
// with the cleaned text and the caller decides what to do with it.
export default function AnalysisHistory({ work, activeHash, onApplyFormat }) {
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [details, setDetails] = useState({});
  const [expanded, setExpanded] = useState(null);
  const mountedRef = useMounted();

  const refresh = async () => {
    setLoading(true);
    const list = await listWritersRoomAnalyses(work.id).catch(() => []);
    if (!mountedRef.current) return;
    setLoading(false);
    setAnalyses(list);
  };

  useEffect(() => {
    setAnalyses([]);
    setExpanded(null);
    setDetails({});
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id]);

  const expand = async (analysis) => {
    if (expanded === analysis.id) {
      setExpanded(null);
      return;
    }
    setExpanded(analysis.id);
    if (details[analysis.id]) return;
    const full = await getWritersRoomAnalysis(work.id, analysis.id).catch((err) => {
      if (mountedRef.current) toast.error(`Failed to load analysis: ${err.message}`);
      return null;
    });
    if (full && mountedRef.current) setDetails((d) => ({ ...d, [analysis.id]: full }));
  };

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] text-gray-500">{analyses.length} run{analyses.length === 1 ? '' : 's'}</div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-gray-500 hover:text-white disabled:opacity-50"
          aria-label="Refresh"
        >
          <RotateCcw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {analyses.length === 0 && !loading && (
        <div className="text-gray-500 italic">No analyses yet — run one from the work menu.</div>
      )}
      <ul className="space-y-1.5">
        {analyses.map((a) => {
          const Icon = KIND_ICON[a.kind] || Sparkles;
          const stale = a.sourceContentHash && activeHash && a.sourceContentHash !== activeHash;
          const isOpen = expanded === a.id;
          const full = details[a.id];
          return (
            <li key={a.id} className="border border-port-border rounded">
              <button
                onClick={() => expand(a)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-port-bg"
              >
                <Icon size={12} className="text-gray-400 shrink-0" />
                <span className="flex-1 truncate">
                  {KIND_LABEL[a.kind] || a.kind}
                  {a.status === 'failed' && <span className="text-port-error"> · failed</span>}
                  {a.status === 'running' && <span className="text-port-accent"> · running…</span>}
                </span>
                {stale && (
                  <span title="Source draft has changed since this analysis ran" className="text-port-warning">
                    <AlertTriangle size={10} />
                  </span>
                )}
                <span className="text-[10px] text-gray-500 shrink-0">{timeAgo(a.completedAt || a.createdAt, '')}</span>
              </button>
              {isOpen && (
                <div className="border-t border-port-border bg-port-bg/40 p-2 space-y-2">
                  {!full && <div className="text-gray-500">Loading…</div>}
                  {full?.status === 'failed' && (
                    <div className="text-port-error text-[11px] whitespace-pre-wrap">{full.error || 'Unknown error'}</div>
                  )}
                  {full?.status === 'succeeded' && full.kind === 'evaluate' && (
                    <EvaluateResult result={full.result} />
                  )}
                  {full?.status === 'succeeded' && full.kind === 'format' && (
                    <FormatResult result={full.result} onApply={onApplyFormat} />
                  )}
                  {full?.status === 'succeeded' && full.kind === 'script' && (
                    <ScriptSummary result={full.result} count={full.result?.scenes?.length || 0} />
                  )}
                  {full?.status === 'succeeded' && full.kind === 'characters' && (
                    <CharactersSummary result={full.result} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EvaluateResult({ result }) {
  if (!result) return null;
  const labelCls = 'uppercase text-[9px] text-gray-500';
  return (
    <div className="space-y-2 text-[11px] text-gray-300">
      {result.logline && <div><span className={labelCls}>Logline</span><div className="italic">{result.logline}</div></div>}
      {result.summary && <div><span className={labelCls}>Summary</span><div>{result.summary}</div></div>}
      {result.themes?.length > 0 && (
        <div>
          <span className={labelCls}>Themes</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {result.themes.map((t, i) => (
              <span key={i} className="px-1.5 py-0.5 border rounded text-[10px] bg-port-card border-port-border">{t}</span>
            ))}
          </div>
        </div>
      )}
      {result.strengths?.length > 0 && (
        <div>
          <span className={labelCls}>Strengths</span>
          <ul className="list-disc list-inside space-y-0.5 mt-0.5 text-gray-400">
            {result.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {result.issues?.length > 0 && (
        <div>
          <span className={labelCls}>Issues</span>
          <ul className="space-y-1 mt-0.5">
            {result.issues.map((iss, i) => (
              <li key={i} className={`pl-2 border-l-2 ${SEVERITY_COLOR[iss.severity] || SEVERITY_COLOR.minor}`}>
                <div className="text-[10px] uppercase tracking-wide opacity-80">{iss.severity || 'minor'} · {iss.category || 'note'}</div>
                <div>{iss.note}</div>
                {iss.excerpt && <div className="italic mt-0.5 text-gray-500">"{iss.excerpt}"</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.suggestions?.length > 0 && (
        <div>
          <span className={labelCls}>Suggestions</span>
          <ul className="space-y-1 mt-0.5">
            {result.suggestions.map((s, i) => (
              <li key={i} className="pl-2 border-l-2 border-port-accent/40">
                <div className="text-[10px] uppercase tracking-wide opacity-80 text-port-accent">{s.target}</div>
                <div>{s.recommendation}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FormatResult({ result, onApply }) {
  const text = result?.formattedBody || '';
  if (!text) return <div className="text-gray-500">Format pass returned no text.</div>;
  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="uppercase text-[9px] text-gray-500">Cleaned prose ({text.length.toLocaleString()} chars)</span>
        {onApply && (
          <button
            onClick={() => onApply(text)}
            className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80"
          >
            <Check size={10} /> Apply to draft
          </button>
        )}
      </div>
      <pre className="whitespace-pre-wrap font-serif text-gray-300 bg-port-bg border border-port-border rounded p-2 max-h-64 overflow-y-auto">{text}</pre>
    </div>
  );
}

function ScriptSummary({ result, count }) {
  return (
    <div className="text-[11px] text-gray-400">
      {count} scene{count === 1 ? '' : 's'} captured. The storyboard sidebar shows them — scene-level images live there.
      {result?.logline && <div className="italic text-gray-500 mt-1">"{result.logline}"</div>}
    </div>
  );
}

function CharactersSummary({ result }) {
  const list = result?.characters || [];
  if (!list.length) return <div className="text-gray-500">No characters returned.</div>;
  return (
    <div className="text-[11px] text-gray-400">
      {list.length} character{list.length === 1 ? '' : 's'} extracted. Open the Characters drawer to edit the bible.
    </div>
  );
}
