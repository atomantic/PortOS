import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  BUCKET_CANON,
  TAB_BIBLE,
  TAB_CAST,
  TAB_COMPOSITES,
  TAB_OBJECTS,
  TAB_OTHER,
  TAB_PLACES,
  TAB_RENDER,
  TRUNK_BY_ID,
  groupBucketsByKind,
} from '../lib/universeBuilderShared';

/**
 * URL-driven tab + bucket state for the Universe Builder (per CLAUDE.md
 * "Linkable routes for all views"). `?tab=cast&bucket=heroes` deep-links into
 * a sub-bucket; both fall back to bible / "" (All) on first load. Existing
 * params (e.g. `?series=` on the embedded Canon section) are forwarded
 * untouched.
 *
 * Also owns the two self-healing effects that strip a `?tab=`/`?bucket=` the
 * current categories no longer support, so the URL and the rendered view can't
 * disagree.
 */
export default function useUniverseTabs(categories) {
  const [searchParams, setSearchParams] = useSearchParams();
  const bucketsByKind = useMemo(() => groupBucketsByKind(categories), [categories]);
  const hasOtherBuckets = bucketsByKind.other.length > 0;
  const requestedTab = searchParams.get('tab');
  const isValidTab = (tab) => (
    tab === TAB_BIBLE || tab === TAB_CAST || tab === TAB_PLACES || tab === TAB_OBJECTS
    || tab === TAB_COMPOSITES || tab === TAB_RENDER
    || (tab === TAB_OTHER && hasOtherBuckets)
  );
  const activeTab = isValidTab(requestedTab) ? requestedTab : TAB_BIBLE;
  const activeBucket = searchParams.get('bucket') || '';
  const setTab = useCallback((tab, opts = {}) => {
    const currentTab = searchParams.get('tab') || TAB_BIBLE;
    const isSameTab = tab === currentTab;
    const next = new URLSearchParams(searchParams);
    if (tab === TAB_BIBLE) next.delete('tab');
    else next.set('tab', tab);
    // Bucket behavior:
    //   - explicit `opts.bucket` value (string) → set
    //   - explicit `opts.bucket: null` → clear (callers that want to drop the
    //     filter on the same tab pass null intentionally)
    //   - omitted + same tab → preserve current bucket (re-clicking the
    //     active tab shouldn't drop the user's chip/canon filter)
    //   - omitted + tab transition → clear (the old bucket is meaningless on
    //     the new tab's bucket namespace)
    if (opts.bucket === null) next.delete('bucket');
    else if (opts.bucket) next.set('bucket', opts.bucket);
    else if (!isSameTab) next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);
  // Explicit user bucket clicks push a history entry so back/forward actually
  // walks tab+bucket navigation (the PR's headline deep-link promise). The
  // stale-bucket-cleanup effect below uses `replace: true` directly so an
  // implicit URL fix-up doesn't fork the history stack.
  const setBucket = useCallback((bucket, opts = {}) => {
    const next = new URLSearchParams(searchParams);
    if (bucket) next.set('bucket', bucket);
    else next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);

  // Drop a stale `?tab=` if it points to an unknown value or `tab=other`
  // when the user has emptied the Other bucket bin. Without this, the URL
  // and UI disagree: `activeTab` silently falls back to Bible but the param
  // stays in the address bar — breaking the deep-link promise and confusing
  // back/forward.
  useEffect(() => {
    if (!requestedTab) return;
    if (isValidTab(requestedTab)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [requestedTab, hasOtherBuckets]);

  // Drop a stale `?bucket=` if the bucket no longer exists under the current
  // tab (e.g. user deleted the bucket, or auto-sort moved it to another kind).
  // `BUCKET_CANON` is a valid pseudo-bucket on every trunk tab — without an
  // explicit allow, the chip's `setBucket(BUCKET_CANON)` flashed in the URL
  // then immediately got stripped by this effect, hiding the canon-only view.
  // Other tab buckets must validate against `bucketsByKind.other`; non-trunk
  // non-Other tabs (Bible / Composites / Render) have no valid bucket scope.
  useEffect(() => {
    if (!activeBucket) return;
    const trunk = TRUNK_BY_ID[activeTab];
    if (trunk && activeBucket === BUCKET_CANON) return;
    const validBuckets = trunk
      ? (bucketsByKind[trunk.kind] || [])
      : (activeTab === TAB_OTHER ? bucketsByKind.other : []);
    if (validBuckets.includes(activeBucket)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('bucket');
    setSearchParams(next, { replace: true });
  }, [activeTab, activeBucket, bucketsByKind, searchParams, setSearchParams]);

  return {
    activeBucket,
    activeTab,
    bucketsByKind,
    hasOtherBuckets,
    setBucket,
    setTab,
  };
}
