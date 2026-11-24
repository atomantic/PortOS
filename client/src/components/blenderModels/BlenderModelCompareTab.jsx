import { useState } from 'react';
import { Camera, Pencil, RefreshCw, Square } from 'lucide-react';
import MediaImage from '../MediaImage';
import TabPills from '../ui/TabPills';
import BlenderModelCameraEditor from './BlenderModelCameraEditor.jsx';
import BlenderModelCroppedImage from './BlenderModelCroppedImage.jsx';
import BlenderModelDifferences from './BlenderModelDifferences.jsx';
import { blenderModelReviewFileUrl } from '../../services/apiBlenderModels.js';
import {
  BLENDER_MODEL_FIXED_VIEWS, approvedReferenceFilename, blenderModelBuilds, comparedCamera, referenceImageUrls, referenceLabel, shownBlenderModelBuild,
} from '../../lib/blenderModels.js';
import { formatDateTime } from '../../utils/formatters.js';
import { buttonCls, inputCls, labelCls } from '../musicVideo/blender/blenderStyles.js';

const LOOKS = [{ id: 'textured', label: 'Textured' }, { id: 'clay', label: 'Clay' }];

// One build seen from the chosen camera, with why it may not show what it says.
function BuildRender({ model, build, title, shown, look }) {
  const review = model.state.reviews.find((entry) => entry.buildId === build.id);
  const job = model.state.jobs.find((entry) => entry.kind === 'review' && entry.buildId === build.id && (entry.status === 'queued' || entry.status === 'running'));
  const rendered = review?.views.includes(shown.viewId);
  const moved = shown.camera && rendered && review.outdatedCameraIds.includes(shown.camera.id);
  return (
    <figure aria-label={title} className="min-w-0 space-y-1.5">
      <figcaption className="text-xs text-port-text-muted">{title}</figcaption>
      {rendered ? (
        <MediaImage src={blenderModelReviewFileUrl(model.state.id, build.id, `${shown.viewId}-${look}.png`, review.renderedAt)}
          alt={`${title}, ${look}`} className="max-h-[70dvh] w-full rounded border border-port-border object-contain" />
      ) : (
        <p className="rounded border border-dashed border-port-border p-4 text-sm">
          {job ? 'Rendering…' : review ? 'This camera was added after the renders. Render again to see it.' : 'Not rendered yet.'}
        </p>
      )}
      {review?.outOfDate && <p role="status" className="text-xs text-port-warning">Out of date: a newer build exists.</p>}
      {moved && <p role="status" className="text-xs text-port-warning">The camera changed since this was rendered. Render again.</p>}
      {job ? (
        <button type="button" className={buttonCls} disabled={!!model.pending[`cancelReview:${build.id}`]} onClick={() => model.cancelReview(build.id)}><Square size={14} aria-hidden="true" /> Cancel renders</button>
      ) : (
        <button type="button" className={buttonCls} disabled={!model.state.tool.ready || !!model.pending.review} onClick={() => model.renderReview(build.id)}>
          <RefreshCw size={14} aria-hidden="true" /> {review ? 'Render again' : 'Render views'}
        </button>
      )}
    </figure>
  );
}

/**
 * A build beside its references, from one camera (`?cam=`, a fixed direction or a
 * saved one), textured or clay (`?look=`), against a reference (`?ref=`) and,
 * when asked, an earlier build (`?vs=`).
 */
export default function BlenderModelCompareTab({ model, build, report, params, updateParams, onOpenTab }) {
  const { state } = model;
  // null closed, 'new', or a camera id.
  const [editing, setEditing] = useState(null);
  const [resolvedSrc, setResolvedSrc] = useState(null);
  const complete = blenderModelBuilds(state).filter((entry) => entry.status === 'complete');
  const shown = comparedCamera(state, params.get('cam'));
  const look = params.get('look') === 'clay' ? 'clay' : 'textured';
  const referenceId = shown.camera?.referenceId ?? params.get('ref') ?? 'overall';
  const slot = state.references.find((entry) => entry.id === referenceId) ?? null;
  const filename = approvedReferenceFilename(slot);
  const other = complete.find((entry) => entry.id === params.get('vs') && entry.id !== build?.id) ?? null;
  const parts = report?.describe?.parts ?? state.describe?.parts ?? [];
  const reviewOf = (entry) => state.reviews.find((review) => review.buildId === entry?.id);
  const sizes = [reviewOf(build), reviewOf(other)].map((review) => JSON.stringify(review?.sizeMeters ?? null));
  const buildName = (entry) => `${formatDateTime(entry.startedAt)} · ${entry.quality}${entry.id === state.publishedBuildId ? ' · published' : ''}`;
  const [src, fallback] = filename ? referenceImageUrls(filename) : [];
  const href = src && resolvedSrc?.forSrc === src ? resolvedSrc.url : src;
  const lastReview = build && [...state.jobs].reverse().find((job) => job.kind === 'review' && job.buildId === build.id);

  if (!build) {
    return (
      <div className="min-w-0 space-y-4">
        <p className="rounded-xl border border-dashed border-port-border p-4 text-sm">Build the model to compare it with its references.</p>
        <BlenderModelDifferences model={model} buildId={null} parts={parts} referenceId={null} />
      </div>
    );
  }
  return (
    <div className="@container min-w-0 space-y-4">
      <div className="grid min-w-0 grid-cols-1 items-end gap-2 @md:grid-cols-2 @4xl:grid-cols-4">
        <div className="min-w-0">
          <label htmlFor="bm-compare-cam" className={labelCls}>Camera</label>
          <select id="bm-compare-cam" className={inputCls} value={shown.id} onChange={(event) => { setEditing(null); updateParams({ cam: event.target.value }); }}>
            <optgroup label="Every build">{BLENDER_MODEL_FIXED_VIEWS.map((view) => <option key={view.id} value={view.id}>{view.label}</option>)}</optgroup>
            {state.cameras.length > 0 && <optgroup label="Saved cameras">{state.cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}</optgroup>}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-compare-ref" className={labelCls}>Reference</label>
          <select id="bm-compare-ref" className={inputCls} value={slot?.id ?? ''} disabled={!!shown.camera} title={shown.camera ? 'A saved camera has its own reference' : undefined} onChange={(event) => updateParams({ ref: event.target.value })}>
            {!slot && <option value="">Removed</option>}
            {state.references.map((entry) => <option key={entry.id} value={entry.id}>{referenceLabel(entry)}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-compare-a" className={labelCls}>Build A</label>
          <select id="bm-compare-a" className={inputCls} value={build.id} onChange={(event) => updateParams({ build: event.target.value === shownBlenderModelBuild(state)?.id ? null : event.target.value })}>
            {complete.map((entry) => <option key={entry.id} value={entry.id}>{buildName(entry)}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-compare-b" className={labelCls}>Build B</label>
          <select id="bm-compare-b" className={inputCls} value={other?.id ?? ''} onChange={(event) => updateParams({ vs: event.target.value || null })}>
            <option value="">None</option>
            {complete.filter((entry) => entry.id !== build.id).map((entry) => <option key={entry.id} value={entry.id}>{buildName(entry)}</option>)}
          </select>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TabPills variant="filter" tabs={LOOKS} activeTab={look} onChange={(next) => updateParams({ look: next === 'clay' ? 'clay' : null })} ariaLabel="Surface" />
        {shown.camera && <button type="button" className={buttonCls} onClick={() => setEditing(shown.camera.id)}><Pencil size={14} aria-hidden="true" /> Edit camera</button>}
        <button type="button" className={buttonCls} onClick={() => setEditing('new')}><Camera size={14} aria-hidden="true" /> New camera</button>
      </div>
      {editing && (
        <BlenderModelCameraEditor key={editing} model={model} camera={editing === 'new' ? null : state.cameras.find((camera) => camera.id === editing) ?? null}
          referenceId={slot?.id ?? 'overall'} parts={parts} onClose={() => setEditing(null)} onSaved={(cameraId) => { setEditing(null); updateParams({ cam: cameraId }); }} />
      )}
      {other && sizes[0] !== 'null' && sizes[1] !== 'null' && sizes[0] !== sizes[1] && (
        <p role="status" className="text-xs text-port-warning">These builds declare different sizes, so they are not framed at the same scale.</p>
      )}
      {lastReview?.status === 'error' && (
        <p role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-error">
          <span className="min-w-0 break-words">The review renders failed: {lastReview.error || 'see the job log.'}</span>
          <button type="button" className={buttonCls} onClick={() => onOpenTab('builds', { bjob: lastReview.id })}>Open log</button>
        </p>
      )}
      <div className={`grid min-w-0 grid-cols-1 items-start gap-3 ${other ? '@2xl:grid-cols-3' : '@2xl:grid-cols-2'}`}>
        <figure aria-label="Reference image" className="min-w-0 space-y-1.5">
          <figcaption className="text-xs text-port-text-muted">{slot ? referenceLabel(slot) : 'Reference'}{shown.camera?.crop ? ` · ${shown.camera.label}` : ''}</figcaption>
          {filename ? (
            <a href={href} target="_blank" rel="noreferrer" aria-label="Open the reference full size">
              <BlenderModelCroppedImage key={src} src={src} fallbackSrc={fallback} alt={`${referenceLabel(slot)} reference`} crop={shown.camera?.crop ?? null}
                onLoad={(event) => {
                  const loaded = event.currentTarget.getAttribute('src');
                  if (loaded) setResolvedSrc({ forSrc: src, url: loaded });
                }} />
            </a>
          ) : (
            <div className="space-y-2 rounded border border-dashed border-port-border p-4 text-sm">
              <p>No approved image for this reference.</p>
              <button type="button" className={buttonCls} onClick={() => onOpenTab('references')}>Open references</button>
            </div>
          )}
        </figure>
        <BuildRender model={model} build={build} title={`Build A, ${buildName(build)}`} shown={shown} look={look} />
        {other && <BuildRender model={model} build={other} title={`Build B, ${buildName(other)}`} shown={shown} look={look} />}
      </div>
      <BlenderModelDifferences model={model} buildId={build.id} parts={parts} referenceId={slot?.id ?? null} />
    </div>
  );
}
