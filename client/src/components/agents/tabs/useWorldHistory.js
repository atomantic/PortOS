import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentActivityTimeline } from '../../../services/apiAgents.js';

const MW_HISTORY_ACTIONS = ['mw_explore', 'mw_build', 'mw_think', 'mw_say', 'mw_heartbeat', 'mw_interact'];
const HISTORY_PAGE_SIZE = 30;

export default function useWorldHistory({ agentId, accountId }) {
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyFilter, setHistoryFilter] = useState('');
  // Bumped by every first-page history load; an older answer (first page or
  // Load More) is dropped so a quick filter change never shows or appends
  // another filter's rows under the selected one.
  const historyGenerationRef = useRef(0);
  // Filter the rows on screen were loaded for (null when none). Load More pages
  // only those rows; a failed first page for a different filter clears them
  // rather than leaving another filter's rows under the selected one.
  const historyShownFilterRef = useRef(null);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);

  const fetchHistory = useCallback(async (append = false, before = null) => {
    if (append && historyShownFilterRef.current !== historyFilter) return;
    const generation = append ? historyGenerationRef.current : ++historyGenerationRef.current;
    setHistoryLoading(true);
    const mwActions = historyFilter || MW_HISTORY_ACTIONS;
    // A first page owns its failure UI in WorldHistorySection; Load More keeps the helper's toast.
    const data = await (append
      ? getAgentActivityTimeline(HISTORY_PAGE_SIZE, [agentId], before, mwActions)
      : getAgentActivityTimeline(HISTORY_PAGE_SIZE, [agentId], before, mwActions, { silent: true })
    ).catch(() => null);
    if (generation !== historyGenerationRef.current) return;
    if (data) {
      const items = Array.isArray(data) ? data : [];
      if (append) {
        setHistory(prev => [...prev, ...items]);
      } else {
        historyShownFilterRef.current = historyFilter;
        setHistoryLoadFailed(false);
        setHistory(items);
      }
      // The server already applied the filter, so a full page means more may exist.
      setHistoryHasMore(items.length >= HISTORY_PAGE_SIZE);
    } else if (!append) {
      setHistoryLoadFailed(true);
      if (historyShownFilterRef.current !== historyFilter) {
        historyShownFilterRef.current = null;
        setHistory([]);
        setHistoryHasMore(false);
      }
    }
    setHistoryLoading(false);
  }, [agentId, historyFilter]);

  useEffect(() => {
    if (accountId) fetchHistory();
  }, [accountId, fetchHistory]);

  const handleLoadMoreHistory = () => {
    if (history.length === 0) return;
    const lastTs = history[history.length - 1].timestamp;
    fetchHistory(true, lastTs);
  };

  return {
    history,
    historyLoading,
    historyHasMore,
    historyFilter,
    historyLoadFailed,
    setHistoryFilter,
    fetchHistory,
    handleLoadMoreHistory
  };
}
