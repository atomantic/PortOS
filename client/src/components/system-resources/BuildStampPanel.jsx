import { useEffect, useState } from 'react';
import { AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import { getSystemBuild } from '../../services/apiSystem.js';
import {
  SERVED_BUILD_ID,
  TRUSTED_BUNDLE_STAMP,
  compareBuildStamps,
  describeBuild
} from '../../lib/buildStamp.js';
import { timeAgo } from '../../utils/formatters';

/**
 * Which code is actually running — the git commit of the server process, and of
 * the bundle this browser loaded (#4694). Why `version` cannot answer this: see
 * the module header of `server/lib/buildIdentity.js`.
 *
 * Fetched from `/api/system/build` rather than read off the health payload: peers
 * scrape `/health/details` and persist it verbatim, so the stamp deliberately
 * does not ride it (see that route's comment).
 *
 * The mismatch banner is the point of the panel — it turns "my change isn't
 * showing up" from a debugging session into a visible fact. The same comparison
 * runs unprompted on every page load (services/socket.js wires the watcher);
 * this is the read-out, not the only detector.
 */
export default function BuildStampPanel({ uptimeFormatted }) {
  const [build, setBuild] = useState(null);
  // `null` build covers three different states, and they must not all render as
  // "no git metadata" — that names a cause the panel has not established.
  const [load, setLoad] = useState('loading');

  // One fetch on mount, not on the page's 15s health poll: the commit a running
  // process was started from cannot change without a restart, and a restart
  // drops the socket and reloads the page anyway.
  useEffect(() => {
    let live = true;
    getSystemBuild({ silent: true })
      .then((data) => { if (live) { setBuild(data); setLoad('ready'); } })
      .catch(() => { if (live) setLoad('error'); });
    return () => { live = false; };
  }, []);

  const { state, bundleCommit, serverCommit } = compareBuildStamps(TRUSTED_BUNDLE_STAMP, build);

  const serverLabel = describeBuild({
    commit: serverCommit,
    branch: build?.branch,
    dirty: build?.dirty
  });
  const bundleLabel = describeBuild({
    commit: TRUSTED_BUNDLE_STAMP?.commit,
    branch: TRUSTED_BUNDLE_STAMP?.branch,
    dirty: TRUSTED_BUNDLE_STAMP?.dirty
  });

  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
        <GitCommitHorizontal size={16} />
        Running build
      </h3>

      {state === 'mismatch' && (
        <Banner tone="warning" size="md" icon={AlertTriangle} align="start" className="mb-3">
          <div>
            This page was built from <span className="font-mono">{bundleCommit}</span> but the API is
            running <span className="font-mono">{serverCommit}</span>. The UI is stale relative to the
            server it is calling — rebuild the client (<span className="font-mono">npm run build</span>)
            or restart the server from the checkout you are editing.
          </div>
        </Banner>
      )}

      <dl className="space-y-2 text-sm">
        <StampRow
          label="Server"
          value={serverLabel}
          // `dirty` is read once at boot, so the whole row describes the tree the
          // process STARTED from — said plainly rather than implying a live read.
          hint={uptimeFormatted ? `at start · up ${uptimeFormatted}` : 'at start'}
        />
        <StampRow
          label="This page"
          value={bundleLabel}
          hint={bundleHint()}
        />
      </dl>

      <p className="mt-3 text-xs text-gray-500">{footnote(state, build, load)}</p>
    </section>
  );
}

function bundleHint() {
  // Under `npm run dev` the Vite define is frozen at dev-server start while HMR
  // serves every commit since, so reporting it would be actively misleading.
  if (!SERVED_BUILD_ID) return 'dev server — no fixed bundle';
  return TRUSTED_BUNDLE_STAMP?.builtAt ? `built ${timeAgo(TRUSTED_BUNDLE_STAMP.builtAt)}` : null;
}

function footnote(state, build, load) {
  if (load === 'loading') return 'Checking which build is running…';
  // An older server has no /api/system/build at all. Saying "no git metadata"
  // there blames the checkout for a missing endpoint.
  if (load === 'error') return 'Could not read the server build — it may be running a version without this endpoint.';
  if (state === 'mismatch') return null;
  if (state === 'unknown') {
    return !SERVED_BUILD_ID
      ? 'Running from the Vite dev server, so there is no built bundle to compare against the server.'
      : 'Commit unknown on at least one side (no git metadata), so bundle/server drift cannot be checked here.';
  }

  // Matching commits are not the whole story. The comparison is commit-only, and
  // EITHER tree can carry uncommitted edits that no commit id reflects: the
  // server booted from a dirty checkout, or the dist was built from one (which
  // stamps its parent's clean commit). Claiming "this is the code that is
  // running" in either case would be a false assurance in exactly the debugging
  // session this panel exists to end.
  const unclean = [
    build?.dirty === true && 'the server tree',
    TRUSTED_BUNDLE_STAMP?.dirty === true && 'this bundle'
  ].filter(Boolean);
  if (unclean.length > 0) {
    return `Same commit on both sides, but ${unclean.join(' and ')} had uncommitted changes that commit does not include.`;
  }

  // Only claim full agreement once both sides confirmed clean — `null` means the
  // check did not run, which is not the same as clean.
  return build?.dirty === false && TRUSTED_BUNDLE_STAMP?.dirty === false
    ? 'Bundle and server agree — what you are looking at is the code that is running.'
    : 'Bundle and server are on the same commit. Whether either tree had uncommitted changes could not be checked.';
}

function StampRow({ label, value, hint }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {value
          ? <span className="font-mono text-xs text-gray-200">{value}</span>
          : <Pill tone="note" size="xs" bordered={false}>unknown</Pill>}
        {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
      </dd>
    </div>
  );
}
