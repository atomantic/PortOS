import { useState, useEffect, useCallback, useRef } from 'react';
import { getAssignableInstances } from '../services/apiSystem';
import useMounted from './useMounted';

// The federated instances a CoS task may be pinned to (#4520) — this machine
// plus every peer that has advertised a federation identity.
//
// Silent by design (no toast): a non-federated install has exactly one entry
// (itself) and the surfaces that consume this hide their picker entirely.
// `instances` starts as `null` — "not fetched yet", distinct from `[]`
// ("fetched, nothing assignable"). A rejected read never stores `[]`: it sets
// `error` (kept until the next success, so a retry in flight still reads as failed)
// and leaves `instances` alone, so a failed read cannot pass for "not
// federated" — a consumer renders the failure and offers `refresh`.
export default function useAssignableInstances() {
  const [instances, setInstances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mounted = useMounted();
  const request = useRef(null);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    const current = ++generation.current;
    request.current = controller;
    setLoading(true);
    return getAssignableInstances({ silent: true, signal: controller.signal })
      .then((data) => {
        if (!mounted.current || controller.signal.aborted || generation.current !== current) return;
        setInstances(Array.isArray(data?.instances) ? data.instances : []);
        setError(null);
      })
      .catch((err) => {
        if (mounted.current && !controller.signal.aborted && generation.current === current) {
          setError(err instanceof Error ? err : new Error('Could not load federated instances'));
        }
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted && generation.current === current) {
          request.current = null;
          setLoading(false);
        }
      });
  }, [mounted]);

  useEffect(() => {
    refresh();
    return () => { generation.current += 1; request.current?.abort(); request.current = null; };
  }, [refresh]);

  // A single instance means "not federated" — nothing to choose between, so
  // callers gate their picker on this rather than re-deriving the rule. `null`
  // is passed through deliberately: a consumer must be able to tell "registry
  // not read yet" from "read, and there is nothing here".
  const isFederated = Array.isArray(instances) && instances.length > 1;
  return { instances, loading, error, isFederated, refresh };
}
