import { useEffect, useState } from 'react';
import { Eye, ScrollText, Upload } from 'lucide-react';
import Pill from '../ui/Pill';
import ListLoadError from '../ui/ListLoadError';
import BlenderJobsTab from '../musicVideo/blender/BlenderJobsTab.jsx';
import { getBlenderModelBuildLog } from '../../services/apiBlenderModels.js';
import { blenderModelBuilds } from '../../lib/blenderModels.js';
import { formatCount, formatDateTime, formatDurationMs } from '../../utils/formatters.js';
import { buttonCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';

const STATUS = {
  running: ['Building', 'accent'], complete: ['Complete', 'success'], failed: ['Failed', 'error'], canceled: ['Canceled', 'warning'],
};

// "2 baked sets at 2048 px (1 reused)", "baking skipped (draft)": what a build's describe().bake came to.
function bakeText(bake) {
  if (!bake) return null;
  if (bake.skipped === 'draft') return 'baking skipped (draft)';
  if (bake.skipped === 'invalid') return 'bake not run (see the report)';
  const reused = bake.reused ? ` (${formatCount(bake.reused)} reused)` : '';
  return `${formatCount(bake.sets)} baked ${bake.sets === 1 ? 'set' : 'sets'} at ${formatCount(bake.size)} px${reused}`;
}

// Jobs live in the server's memory; a kept build's log stays readable here after a restart. Mounted keyed by build id.
function BuildLog({ modelId, build }) {
  const [log, setLog] = useState({ text: '', status: 'loading', error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLog((current) => ({ ...current, status: 'loading', error: null }));
    getBlenderModelBuildLog(modelId, build.id, { silent: true })
      .then((text) => { if (active) setLog({ text, status: 'ready', error: null }); })
      .catch((error) => { if (active) setLog({ text: '', status: 'error', error }); });
    return () => { active = false; };
  }, [modelId, build.id, build.status, attempt]);
  if (log.status === 'error') return <ListLoadError what="the build log" error={log.error} onRetry={() => setAttempt((count) => count + 1)} />;
  if (log.status === 'loading' && !log.text) return <p role="status" className="text-xs text-port-text-muted">Loading the log…</p>;
  return (
    <pre tabIndex={0} aria-label="Build log" className="max-h-[50dvh] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded border border-port-border bg-port-bg p-2 font-mono text-[11px] leading-4">
      {log.text || 'The log is empty.'}
    </pre>
  );
}

/** Build jobs since PortOS started (progress, cancel, log), then every kept build with its log, review and Publish. */
export default function BlenderModelBuildsTab({ model, openBuildId, onOpenLog, onReview }) {
  const { state, pending } = model;
  const builds = blenderModelBuilds(state);
  return (
    <div className="min-w-0 space-y-4">
      <section aria-label="Build jobs" className="min-w-0 space-y-2">
        <h2 className="text-sm font-medium">Jobs</h2>
        <BlenderJobsTab blender={model} emptyText="No build has run since PortOS last started. Kept builds and their logs are below." />
      </section>
      <section aria-label="Build history" className="min-w-0 space-y-2">
        <h2 className="text-sm font-medium">History</h2>
        <p className="text-xs text-port-text-muted">
          PortOS keeps the published build and the newest five. Draft builds skip texture baking; Full builds bake the sets describe() lists and reuse a set that did not change.
        </p>
        {!builds.length && <p className="text-xs text-port-text-muted">Never built.</p>}
        {builds.length > 0 && (
          <ul className="min-w-0 divide-y divide-port-border rounded border border-port-border">
            {builds.map((build) => {
              const [label, tone] = STATUS[build.status] || [build.status, 'muted'];
              const took = Date.parse(build.finishedAt || '') - Date.parse(build.startedAt || '');
              const open = openBuildId === build.id;
              return (
                <li key={build.id} aria-label={`Build ${formatDateTime(build.startedAt)}`} className="min-w-0 space-y-1 px-2 py-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-sm">{formatDateTime(build.startedAt)}</span>
                    <Pill size="xs" tone={tone}>{label}</Pill>
                    {state.publishedBuildId === build.id && <Pill size="xs" tone="success">Published</Pill>}
                    <span className="min-w-0 flex-1 text-port-text-muted">
                      {[build.quality, Number.isFinite(took) ? formatDurationMs(Math.max(0, took)) : null, bakeText(build.bake),
                        build.counts ? `${formatCount(build.counts.error)} errors, ${formatCount(build.counts.warning)} warnings` : null].filter(Boolean).join(' · ')}
                    </span>
                    {build.status === 'complete' && (
                      <button type="button" className={buttonCls} onClick={() => onReview(build.id)}><Eye size={14} aria-hidden="true" /> Review</button>
                    )}
                    {build.status === 'complete' && build.publishable && state.publishedBuildId !== build.id && (
                      <button type="button" className={primaryCls} disabled={!!pending.publish} onClick={() => model.publish(build.id)}>
                        <Upload size={14} aria-hidden="true" /> {pending.publish ? 'Publishing…' : 'Publish'}
                      </button>
                    )}
                    <button type="button" className={buttonCls} aria-pressed={open} onClick={() => onOpenLog(open ? null : build.id)}>
                      <ScrollText size={14} aria-hidden="true" /> {open ? 'Hide build log' : 'Build log'}
                    </button>
                  </div>
                  {build.error && <p role="status" className="break-words text-xs text-port-error">{build.error}</p>}
                  {open && <BuildLog modelId={state.id} build={build} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
