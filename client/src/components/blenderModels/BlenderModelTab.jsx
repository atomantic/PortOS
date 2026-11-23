import { Suspense } from 'react';
import { Box, Download, ExternalLink, FolderPlus, Upload } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import Pill from '../ui/Pill';
import ListLoadError from '../ui/ListLoadError';
import { lazyWithReload } from '../../utils/lazyWithReload';
import { blenderModelAssetUrl, blenderModelBuildFileUrl } from '../../services/apiBlenderModels.js';
import { blenderModelBuilds, formatMeters, shownBlenderModelBuild } from '../../lib/blenderModels.js';
import { formatCount, formatDateTime } from '../../utils/formatters.js';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';

const GlbViewer = lazyWithReload(() => import('../media/GlbViewer'));
const SEVERITIES = [['error', 'Errors', 'error'], ['warning', 'Warnings', 'warning'], ['note', 'Notes', 'muted']];

function Findings({ report }) {
  const groups = SEVERITIES.map(([severity, label, tone]) => ({ label, tone, items: report.findings.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.items.length);
  return (
    <section aria-label="Findings" className="min-w-0 space-y-2">
      <h2 className="text-sm font-medium">Findings</h2>
      {!groups.length && <p className="text-xs text-port-text-muted">Every check passed.</p>}
      {groups.map(({ label, tone, items }) => (
        <div key={label} className="min-w-0 space-y-1">
          <h3 className="text-xs"><Pill size="xs" tone={tone}>{label} · {formatCount(items.length)}</Pill></h3>
          <ul aria-label={label} className="min-w-0 space-y-1 text-xs">
            {items.map((finding) => (
              <li key={finding.code} className="min-w-0 break-words">
                {finding.message}
                {finding.subjects?.length > 0 && (
                  <span className="text-port-text-muted">: {finding.subjects.join(', ')}{finding.more ? ` and ${formatCount(finding.more)} more` : ''}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Measurements({ checks }) {
  const size = formatMeters(checks.bounds?.actual);
  const declared = formatMeters(checks.bounds?.declared);
  const { total, budget } = checks.triangles || {};
  const over = total != null && budget != null && total > budget;
  return (
    <dl aria-label="Measurements" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-port-text-muted">Size</dt>
      <dd>{size || 'Not measured'}{declared ? <span className="text-port-text-muted"> (declared {declared})</span> : null}</dd>
      <dt className="text-port-text-muted">Triangles</dt>
      <dd className={over ? 'text-port-error' : ''}>{formatCount(total)} of {formatCount(budget)}</dd>
    </dl>
  );
}

// Choosing a part shows it alone; choosing it again (or "Whole model") shows everything.
function PartList({ report, part, onPartChange }) {
  const parts = report.describe?.parts || [];
  const missing = new Set(report.checks.parts.missing);
  return (
    <section aria-label="Parts" className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Parts</h2>
        {part && <button type="button" className={buttonCls} onClick={() => onPartChange(null)}>Whole model</button>}
      </div>
      {!parts.length && <p className="text-xs text-port-text-muted">This build declared no parts.</p>}
      {parts.length > 0 && (
        <ul className="max-h-[40dvh] min-w-0 divide-y divide-port-border overflow-y-auto rounded border border-port-border">
          {parts.map(({ id, label, parent }, index) => (
            // A flagged build may declare one id twice.
            <li key={`${id}:${index}`}>
              <button type="button" aria-pressed={part === id} disabled={missing.has(id)} onClick={() => onPartChange(part === id ? null : id)}
                className={`flex min-h-[44px] w-full min-w-0 flex-wrap items-center gap-x-2 px-2 py-1.5 text-left text-xs hover:bg-port-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-port-accent disabled:opacity-60 pointer-fine:sm:min-h-0 ${part === id ? 'bg-port-accent/10' : ''}`}>
                <span className="min-w-0 flex-1 break-words">{label || id}</span>
                <span className="min-w-0 break-all font-mono text-port-text-muted">{id}{parent ? ` in ${parent}` : ''}</span>
                {missing.has(id) && <span className="text-port-error">not built</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyModel({ model, onOpenTab }) {
  const { state, pending } = model;
  if (!state.workspace.hasModel) {
    return (
      <div className="min-w-0 space-y-2 rounded-xl border border-dashed border-port-border p-4 text-sm">
        <p>Start by creating the starter script, a working three-part lamp, or copy the agent brief and have a coding agent write <code className="font-mono">src/model.py</code>.</p>
        <button type="button" className={primaryCls} disabled={!!pending.workspace} onClick={model.createWorkspace}>
          <FolderPlus size={14} aria-hidden="true" /> {pending.workspace ? 'Creating…' : 'Create starter script'}
        </button>
      </div>
    );
  }
  const failed = blenderModelBuilds(state)[0]?.status === 'failed';
  return (
    <div className="min-w-0 space-y-2 rounded-xl border border-dashed border-port-border p-4 text-sm">
      <p>{state.status === 'building' ? 'The first build is running.' : failed ? 'No build has completed yet.' : 'Build the model to see it here.'}</p>
      {state.status !== 'building' && <button type="button" className={buttonCls} onClick={() => onOpenTab('files')}>Edit the script</button>}
    </div>
  );
}

/**
 * The model as built: the viewer on one build (the newest completed, or
 * `?build=`), its measurements, parts and findings, and what to do with it.
 */
export default function BlenderModelTab({ model, reportRead, build, part, onPartChange, onBuildChange, onOpenTab }) {
  const { state, pending } = model;
  if (!build) return <EmptyModel model={model} onOpenTab={onOpenTab} />;
  const report = reportRead.data;
  const published = state.publishedBuildId === build.id;
  const complete = blenderModelBuilds(state).filter((entry) => entry.status === 'complete');
  const glb = blenderModelBuildFileUrl(state.id, build.id, 'model.glb');
  const newest = shownBlenderModelBuild(state);
  const hasGlb = !report || report.checks.glbBytes != null;
  // An unknown or unbuilt part in the URL isolates nothing.
  const isolated = part && report?.describe?.parts.some((entry) => entry.id === part) && !report.checks.parts.missing.includes(part) ? part : null;

  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <label htmlFor="bm-build" className={labelCls}>Build</label>
              <select id="bm-build" value={build.id} className={inputCls} onChange={(event) => onBuildChange(event.target.value === newest?.id ? null : event.target.value)}>
                {complete.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {formatDateTime(entry.startedAt)} · {entry.quality}{entry.id === state.publishedBuildId ? ' · published' : ''}{entry.counts?.error ? ` · ${formatCount(entry.counts.error)} errors` : ''}
                  </option>
                ))}
              </select>
            </div>
            {published ? <Pill tone="success">Published</Pill> : (
              <button type="button" className={primaryCls} disabled={!build.publishable || !!pending.publish} title={build.publishable ? undefined : 'Fix the errors below and build again to publish.'}
                onClick={() => model.publish(build.id)}>
                <Upload size={14} aria-hidden="true" /> {pending.publish ? 'Publishing…' : 'Publish'}
              </button>
            )}
            <button type="button" className={buttonCls} disabled={!!pending[`open:${build.id}`]} onClick={() => model.openBuild(build.id)}>
              <ExternalLink size={14} aria-hidden="true" /> Open in Blender
            </button>
            <a className={buttonCls} href={blenderModelBuildFileUrl(state.id, build.id, 'model.blend')} download={`${state.name}.blend`}>
              <Download size={14} aria-hidden="true" /> Download .blend
            </a>
          </div>
          {hasGlb ? (
            <Suspense fallback={<BrailleSpinner text="Loading 3D viewer" />}>
              <GlbViewer src={glb} downloadHref={published ? blenderModelAssetUrl(state.id) : undefined} isolateNode={isolated} />
            </Suspense>
          ) : <p className="rounded-xl border border-dashed border-port-border p-4 text-sm">This build wrote no model.glb, so there is nothing to show.</p>}
        </div>
        <div className="min-w-0 space-y-4">
          {reportRead.error && !report && <ListLoadError what="the build report" error={reportRead.error} onRetry={reportRead.retry} />}
          {!report && !reportRead.error && <p role="status" className="text-xs text-port-text-muted">Loading the build report…</p>}
          {report && (
            <>
              {report.describe?.title && <p className="flex items-center gap-1.5 text-sm"><Box size={14} aria-hidden="true" /> {report.describe.title}</p>}
              <Measurements checks={report.checks} />
              <PartList report={report} part={isolated} onPartChange={onPartChange} />
              <Findings report={report} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
