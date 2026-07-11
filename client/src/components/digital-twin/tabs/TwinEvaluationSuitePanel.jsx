import {
  Play,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  History
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import PersonaBadge from '../PersonaBadge';
import { scoreToColor } from '../constants';
import { timeAgo } from '../../../utils/formatters';
import { useTwinEvaluationSuite } from '../../../hooks/useTwinEvaluationSuite';

/**
 * The per-model result block shared by every suite's expanded detail: a
 * `{model} {label}` heading with the run's result icon, then a body. The
 * default body is the single-response + reasoning layout (Values / Adversarial);
 * Multi-Turn passes a custom `renderBody` that lays out the full transcript.
 */
export function SuiteModelResponses({ item, results, resultIcon, label, renderBody }) {
  const body = renderBody || (tr => (
    <div className="bg-port-card p-3 rounded">
      <p className="text-white whitespace-pre-wrap">{tr.response}</p>
      {tr.reasoning && (
        <p className="text-sm text-gray-400 mt-2 pt-2 border-t border-port-border">
          Reasoning: {tr.reasoning}
        </p>
      )}
    </div>
  ));

  return results.map(r => {
    const tr = r.results?.find(x => x.testId === item.testId);
    if (!tr) return null;
    return (
      <div key={`${r.providerId}-${r.model}-resp`}>
        <h4 className="text-sm font-medium text-gray-400 mb-1 flex items-center gap-2">
          {r.model} {label} {resultIcon(tr.result)}
        </h4>
        {body(tr)}
      </div>
    );
  });
}

/**
 * Shared presentation + lifecycle for the three Digital Twin evaluation-suite
 * panels (Values-Alignment, Adversarial-Boundary, Multi-Turn). Everything the
 * three suites share — loading, multi-provider run, history prepend, results
 * table, and the recent-runs list — lives here; the caller supplies a `suite`
 * descriptor (copy + status semantics + api calls) and a `renderDetail` fn for
 * the one section that genuinely differs (the expanded per-test detail).
 *
 * @param {object}   suite                 Suite descriptor (see the panel wrappers).
 * @param {Function} renderDetail          `(item, { results, resultIcon }) => ReactNode`.
 * @param {Array}    selectedProviders     `[{ providerId, model }]` from TestTab.
 * @param {string}   personaId             Selected persona id ('' = base twin).
 * @param {Function} onPersonaNotFound     Parent clears its picker on a stale persona.
 * @param {Function} onRefresh             Parent refresh after a run.
 */
export default function TwinEvaluationSuitePanel({
  suite,
  renderDetail,
  selectedProviders = [],
  personaId = '',
  onPersonaNotFound,
  onRefresh
}) {
  const {
    HeaderIcon,
    title,
    description,
    runLabel,
    loadingText,
    itemLabel,
    emptyState,
    scoreLabel,
    countField,
    historyTitle,
    statusMap,
    passResult,
    failResult,
    getTests,
    getHistory,
    runTests,
    successToast
  } = suite;

  const {
    items,
    history,
    loading,
    running,
    results,
    expanded,
    setExpanded,
    run
  } = useTwinEvaluationSuite({
    selectedProviders,
    personaId,
    onPersonaNotFound,
    onRefresh,
    getTests,
    getHistory,
    runTests,
    countField,
    successToast
  });

  const resultIcon = (result) => {
    if (result === passResult) return <CheckCircle className="w-5 h-5 text-port-success" />;
    if (result === failResult) return <XCircle className="w-5 h-5 text-port-error" />;
    if (result === 'partial') return <AlertCircle className="w-5 h-5 text-port-warning" />;
    return <Clock className="w-5 h-5 text-gray-400" />;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <BrailleSpinner text={loadingText} />
      </div>
    );
  }

  return (
    <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
      <div className="p-4 border-b border-port-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white flex items-center gap-2">
            <HeaderIcon className="w-5 h-5 text-port-accent" />
            {title}
          </h3>
          <p className="text-xs text-gray-500 mt-1">{description}</p>
        </div>
        <button
          onClick={run}
          disabled={running || items.length === 0 || selectedProviders.length === 0}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? (
            <>
              <BrailleSpinner />
              Running...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              {runLabel}
            </>
          )}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-400">{emptyState}</div>
      ) : (
        <>
          {/* Results table */}
          {results.length > 0 && (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full min-w-[500px]">
                <thead>
                  <tr className="border-b border-port-border">
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">{itemLabel}</th>
                    {results.map(r => (
                      <th key={`${r.providerId}-${r.model}`} className="px-4 py-3 text-left text-sm font-medium text-gray-400">
                        {r.model}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr
                      key={item.testId}
                      className="border-b border-port-border last:border-b-0 hover:bg-port-border/30"
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpanded(expanded === item.testId ? null : item.testId)}
                          className="flex items-center gap-2 text-sm text-white text-left"
                        >
                          {expanded === item.testId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {item.testId}. {item.testName}
                        </button>
                      </td>
                      {results.map(r => {
                        const tr = r.results?.find(x => x.testId === item.testId);
                        return (
                          <td key={`${r.providerId}-${r.model}`} className="px-4 py-3">
                            {tr ? (
                              <div className="flex items-center gap-2">
                                {resultIcon(tr.result)}
                                <span className={`text-sm ${statusMap[tr.result]?.color?.split(' ')[1]}`}>
                                  {statusMap[tr.result]?.label}
                                </span>
                              </div>
                            ) : (
                              <span className="text-gray-500">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}

                  {/* Summary row */}
                  <tr className="bg-port-border/30">
                    <td className="px-4 py-3 font-medium text-white">{scoreLabel}</td>
                    {results.map(r => (
                      <td key={`${r.providerId}-${r.model}-score`} className="px-4 py-3">
                        {r.error ? (
                          <span className="text-sm text-port-error">{r.error}</span>
                        ) : (
                          <>
                            <span className={`text-lg font-bold ${scoreToColor(r.score || 0)}`}>
                              {Math.round((r.score || 0) * 100)}%
                            </span>
                            <span className="text-sm text-gray-500 ml-2">
                              ({r[countField] || 0}/{r.total || 0})
                            </span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Expanded detail */}
          {expanded && (
            <div className="p-4 bg-port-bg border-t border-port-border">
              {(() => {
                const item = items.find(i => i.testId === expanded);
                if (!item) return null;
                return renderDetail(item, { results, resultIcon });
              })()}
            </div>
          )}

          {/* History */}
          {history.length > 0 && (
            <div className="p-4 border-t border-port-border">
              <h4 className="font-semibold text-white mb-3 flex items-center gap-2 text-sm">
                <History size={16} />
                {historyTitle}
              </h4>
              <div className="space-y-2">
                {history.map(entry => (
                  <div key={entry.runId} className="flex items-center justify-between p-3 rounded bg-port-bg">
                    <div className="flex items-center gap-4">
                      <span className={`text-xl font-bold ${scoreToColor(entry.score)}`}>
                        {Math.round(entry.score * 100)}%
                      </span>
                      <div>
                        <div className="text-sm text-white flex items-center gap-2">
                          {entry.model}
                          <PersonaBadge name={entry.personaName} />
                        </div>
                        <div className="text-xs text-gray-500">
                          {entry[countField]}/{entry.total} {countField} • {timeAgo(entry.timestamp)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
