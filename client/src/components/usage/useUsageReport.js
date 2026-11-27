import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { getUsage } from '../../services/apiSystem.js';
import { USAGE_PERIOD_OPTIONS, DEFAULT_USAGE_PERIOD } from '../../lib/usagePeriods';

export default function useUsageReport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || DEFAULT_USAGE_PERIOD;
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const isCustom = Boolean(from || to);

  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [loadedRange, setLoadedRange] = useState(null);

  // One fetch for every trigger — the range effect, the backfill-complete
  // refetch, and a subscription-price save (which re-derives the savings block
  // server-side). It resolves once the new payload is applied, so a caller can
  // keep its button busy until the screen actually reflects the change.
  const requestRef = useRef(0);
  const fetchUsage = useCallback(async () => {
    const token = ++requestRef.current;
    const params = isCustom ? { from, to } : { period };
    const rangeLabel = isCustom
      ? `${from || 'Beginning'} to ${to || 'No end'}`
      : (USAGE_PERIOD_OPTIONS.find((option) => option.id === period)?.label || period);
    setLoading(true);
    setReadError(false);
    const data = await getUsage(params, { silent: true }).catch(() => null);
    if (token === requestRef.current) {
      if (data) {
        setUsage(data);
        setLoadedRange(rangeLabel);
      }
      setReadError(!data);
      setLoading(false);
    }
    return data;
  }, [period, from, to, isCustom]);

  useEffect(() => {
    fetchUsage();
    return () => { requestRef.current += 1; };
  }, [fetchUsage]);

  const setPeriod = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('from');
      next.delete('to');
      if (id === DEFAULT_USAGE_PERIOD) next.delete('period'); else next.set('period', id);
      return next;
    }, { replace: true });
  };

  const setRange = (nextFrom, nextTo) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('period');
      if (nextFrom) next.set('from', nextFrom); else next.delete('from');
      if (nextTo) next.set('to', nextTo); else next.delete('to');
      return next;
    }, { replace: true });
  };

  return { period, from, to, isCustom, usage, loading, readError, loadedRange, fetchUsage, setPeriod, setRange };
}
