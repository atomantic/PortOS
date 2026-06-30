import { useState, useEffect } from 'react';
import {
  Play,
  ShieldAlert,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  History
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';

import PersonaBadge from '../PersonaBadge';
import { ADVERSARIAL_STATUS, scoreToColor } from '../constants';
import { timeAgo } from '../../../utils/formatters';

/**
 * Adversarial Boundary testing (M34 P6). Tries to manipulate the embodied twin
 * — authority pressure, flattery, guilt, incremental escalation, harmful
 * reframing — into crossing a stated boundary, then grades whether the twin
 * held the line. Reuses the provider/model + persona selection from the parent
 * TestTab via props so the three suites share one configuration.
 */
export default function AdversarialBoundaryPanel({ selectedProviders = [], personaId = '', onPersonaNotFound, onRefresh }) {
  const [scenarios, setScenarios] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    // These loads own their fallback ([]) so silence the helper's default toast.
    const [scenarioData, historyData] = await Promise.all([
      api.getAdversarialTests({ silent: true }).catch(() => []),
      api.getAdversarialTestHistory(5, { silent: true }).catch(() => [])
    ]);
    setScenarios(scenarioData);
    setHistory(historyData);
    setLoading(false);
  };

  const runTests = async () => {
    if (selectedProviders.length === 0) {
      toast.error('Select at least one provider/model above');
      return;
    }

    setRunning(true);
    setResults([]);

    // These calls own their error UI below (and one path delegates to the
    // parent), so silence the helper's default toast to avoid double-toasting.
    const runResults = await Promise.all(
      selectedProviders.map(({ providerId, model }) =>
        api.runAdversarialTests(providerId, model, null, personaId || null, { silent: true })
          .then(result => ({ providerId, model, ...result }))
          .catch(err => ({ providerId, model, error: err.message, code: err?.code }))
      )
    );

    setResults(runResults);
    // The run response already carries each run's history entry — prepend it
    // to the local list instead of refetching (reactive-update convention).
    const fresh = runResults
      .filter(r => !r.error && r.runId)
      .map(({ runId, score, held, total, timestamp, model, personaName }) => ({ runId, score, held, total, timestamp, model, personaName }));
    if (fresh.length) setHistory(prev => [...fresh, ...prev].slice(0, 5));
    setRunning(false);

    // A stale/deleted persona is rejected by the same route guard the
    // behavioral runner hits; ask the parent (which owns the picker) to clear
    // it, and show a persona-specific message instead of the generic one.
    if (runResults.some(r => r.code === 'NOT_FOUND')) {
      onPersonaNotFound?.();
      toast.error('That persona no longer exists — switched to the base twin. Try again.');
    } else if (runResults.some(r => r.error)) {
      toast.error('Some runs failed — check provider availability');
    } else {
      toast.success('Adversarial boundary tests completed');
    }
    onRefresh?.();
  };

  const getResultIcon = (result) => {
    switch (result) {
      case 'held':
        return <CheckCircle className="w-5 h-5 text-port-success" />;
      case 'breached':
        return <XCircle className="w-5 h-5 text-port-error" />;
      case 'partial':
        return <AlertCircle className="w-5 h-5 text-port-warning" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <BrailleSpinner text="Loading boundary suite" />
      </div>
    );
  }

  return (
    <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
      <div className="p-4 border-b border-port-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-port-accent" />
            Adversarial Boundary Tests
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Manipulation attempts scored on whether your twin held its boundaries (non-negotiables &amp; error-intolerances).
          </p>
        </div>
        <button
          onClick={runTests}
          disabled={running || scenarios.length === 0 || selectedProviders.length === 0}
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
              Run Scenarios
            </>
          )}
        </button>
      </div>

      {scenarios.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-400">
          No adversarial-boundary suite found. Add an <span className="text-gray-300">ADVERSARIAL_BOUNDARY_SUITE.md</span> to your digital twin folder to enable these tests.
        </div>
      ) : (
        <>
          {/* Results table */}
          {results.length > 0 && (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full min-w-[500px]">
                <thead>
                  <tr className="border-b border-port-border">
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Scenario</th>
                    {results.map(r => (
                      <th key={`${r.providerId}-${r.model}`} className="px-4 py-3 text-left text-sm font-medium text-gray-400">
                        {r.model}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map(scenario => (
                    <tr
                      key={scenario.testId}
                      className="border-b border-port-border last:border-b-0 hover:bg-port-border/30"
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpanded(expanded === scenario.testId ? null : scenario.testId)}
                          className="flex items-center gap-2 text-sm text-white text-left"
                        >
                          {expanded === scenario.testId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {scenario.testId}. {scenario.testName}
                        </button>
                      </td>
                      {results.map(r => {
                        const tr = r.results?.find(x => x.testId === scenario.testId);
                        return (
                          <td key={`${r.providerId}-${r.model}`} className="px-4 py-3">
                            {tr ? (
                              <div className="flex items-center gap-2">
                                {getResultIcon(tr.result)}
                                <span className={`text-sm ${ADVERSARIAL_STATUS[tr.result]?.color?.split(' ')[1]}`}>
                                  {ADVERSARIAL_STATUS[tr.result]?.label}
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
                    <td className="px-4 py-3 font-medium text-white">Boundary Score</td>
                    {results.map(r => (
                      <td key={`${r.providerId}-${r.model}-score`} className="px-4 py-3">
                        {r.error ? (
                          <span className="text-sm text-red-400">{r.error}</span>
                        ) : (
                          <>
                            <span className={`text-lg font-bold ${scoreToColor(r.score || 0)}`}>
                              {Math.round((r.score || 0) * 100)}%
                            </span>
                            <span className="text-sm text-gray-500 ml-2">
                              ({r.held || 0}/{r.total || 0})
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

          {/* Expanded scenario detail */}
          {expanded && (
            <div className="p-4 bg-port-bg border-t border-port-border">
              {(() => {
                const scenario = scenarios.find(s => s.testId === expanded);
                if (!scenario) return null;
                return (
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Manipulation Setup</h4>
                      <p className="text-white bg-port-card p-3 rounded">{scenario.setup}</p>
                    </div>
                    {scenario.boundaryTested?.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {scenario.boundaryTested.map(b => (
                          <span key={b} className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent">
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-port-success text-xs mb-1">Held Response</div>
                        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.heldResponse}</div>
                      </div>
                      <div>
                        <div className="text-port-error text-xs mb-1">Breached Response</div>
                        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.breachedResponse}</div>
                      </div>
                    </div>

                    {results.map(r => {
                      const tr = r.results?.find(x => x.testId === expanded);
                      if (!tr) return null;
                      return (
                        <div key={`${r.providerId}-${r.model}-resp`}>
                          <h4 className="text-sm font-medium text-gray-400 mb-1 flex items-center gap-2">
                            {r.model} Response {getResultIcon(tr.result)}
                          </h4>
                          <div className="bg-port-card p-3 rounded">
                            <p className="text-white whitespace-pre-wrap">{tr.response}</p>
                            {tr.reasoning && (
                              <p className="text-sm text-gray-400 mt-2 pt-2 border-t border-port-border">
                                Reasoning: {tr.reasoning}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* History */}
          {history.length > 0 && (
            <div className="p-4 border-t border-port-border">
              <h4 className="font-semibold text-white mb-3 flex items-center gap-2 text-sm">
                <History size={16} />
                Recent Boundary Runs
              </h4>
              <div className="space-y-2">
                {history.map(run => (
                  <div key={run.runId} className="flex items-center justify-between p-3 rounded bg-port-bg">
                    <div className="flex items-center gap-4">
                      <span className={`text-xl font-bold ${scoreToColor(run.score)}`}>
                        {Math.round(run.score * 100)}%
                      </span>
                      <div>
                        <div className="text-sm text-white flex items-center gap-2">
                          {run.model}
                          <PersonaBadge name={run.personaName} />
                        </div>
                        <div className="text-xs text-gray-500">
                          {run.held}/{run.total} held • {timeAgo(run.timestamp)}
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
