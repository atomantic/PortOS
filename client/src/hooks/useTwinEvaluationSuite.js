import { useState, useEffect } from 'react';
import toast from '../components/ui/Toast';

/**
 * Shared lifecycle for the Digital Twin evaluation-suite panels (M34 P6) —
 * Values-Alignment, Adversarial-Boundary, and Multi-Turn. All three panels load
 * a suite + recent history, run every selected provider/model in parallel,
 * prepend fresh runs to the history list, and handle the stale-persona /
 * partial-failure toast fan-out identically. This hook owns that lifecycle so
 * the panels only differ in their suite descriptor + detail renderer.
 *
 * The three run responses each carry a suite-specific pass-count field
 * (`aligned` / `held` / `consistent`); `countField` names it so the fresh
 * history entry preserves it without the hook knowing which suite it serves.
 *
 * @param {object}   cfg
 * @param {Array}    cfg.selectedProviders     `[{ providerId, model }]` from TestTab.
 * @param {string}   cfg.personaId             Selected persona id ('' = base twin).
 * @param {Function} [cfg.onPersonaNotFound]   Parent clears its picker on a stale persona.
 * @param {Function} [cfg.onRefresh]           Parent refresh after a run.
 * @param {Function} cfg.getTests              `(options) => Promise<item[]>`.
 * @param {Function} cfg.getHistory            `(limit, options) => Promise<run[]>`.
 * @param {Function} cfg.runTests              `(providerId, model, testIds, personaId, options) => Promise<run>`.
 * @param {string}   cfg.countField            Suite pass-count key to preserve in history.
 * @param {string}   cfg.successToast          Copy for the all-succeeded toast.
 */
export function useTwinEvaluationSuite({
  selectedProviders = [],
  personaId = '',
  onPersonaNotFound,
  onRefresh,
  getTests,
  getHistory,
  runTests,
  countField,
  successToast,
}) {
  const [items, setItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  // Sentinel: `null` = the suite loaded (empty or not); a string = the load
  // failed. This keeps a server/network failure distinct from a genuinely
  // empty install so the two never collapse to the same "No suite" state.
  const [loadError, setLoadError] = useState(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    // The suite load owns its error UI (inline load-error state + Retry below)
    // so silence the helper's default toast — the sentinel `null` on failure is
    // distinct from `[]`, which is a real, successfully-loaded empty suite.
    // History is secondary: a failed history load degrades to no history rather
    // than blocking the whole panel.
    const [itemData, historyData] = await Promise.all([
      getTests({ silent: true }).catch(() => null),
      getHistory(5, { silent: true }).catch(() => [])
    ]);
    if (itemData === null) {
      setLoadError('Could not load the suite — check provider/server availability and retry.');
      setItems([]);
    } else {
      setItems(itemData);
    }
    setHistory(historyData);
    setLoading(false);
  };

  const run = async () => {
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
        runTests(providerId, model, null, personaId || null, { silent: true })
          .then(result => ({ providerId, model, ...result }))
          .catch(err => ({ providerId, model, error: err.message, code: err?.code }))
      )
    );

    setResults(runResults);
    // The run response already carries each run's history entry — prepend it
    // to the local list instead of refetching (reactive-update convention).
    const fresh = runResults
      .filter(r => !r.error && r.runId)
      .map(r => ({
        runId: r.runId,
        score: r.score,
        total: r.total,
        timestamp: r.timestamp,
        model: r.model,
        personaName: r.personaName,
        [countField]: r[countField]
      }));
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
      toast.success(successToast);
    }
    onRefresh?.();
  };

  return { items, history, loading, loadError, running, results, expanded, setExpanded, run, reload: loadData };
}
