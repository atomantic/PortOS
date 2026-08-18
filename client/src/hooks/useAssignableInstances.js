import { useState, useEffect } from 'react';
import { getAssignableInstances } from '../services/apiSystem';

// The federated instances a CoS task may be pinned to (#4520) — this machine
// plus every peer that has advertised a federation identity.
//
// Silent by design: a non-federated install has exactly one entry (itself) and
// the surfaces that consume this hide their picker entirely, so a failed or
// empty read must not toast. `instances` starts as `null` — "not fetched yet",
// distinct from `[]` ("fetched, nothing assignable") — so a caller can tell a
// still-loading render from a genuinely empty registry.
export default function useAssignableInstances() {
  const [instances, setInstances] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getAssignableInstances({ silent: true })
      .then((data) => {
        if (cancelled) return;
        setInstances(Array.isArray(data?.instances) ? data.instances : []);
      })
      .catch(() => { if (!cancelled) setInstances([]); });
    return () => { cancelled = true; };
  }, []);

  // A single instance means "not federated" — nothing to choose between, so
  // callers gate their picker on this rather than re-deriving the rule. `null`
  // is passed through deliberately: a consumer must be able to tell "registry
  // not read yet" from "read, and there is nothing here".
  const isFederated = Array.isArray(instances) && instances.length > 1;
  return { instances, loading: instances === null, isFederated };
}
