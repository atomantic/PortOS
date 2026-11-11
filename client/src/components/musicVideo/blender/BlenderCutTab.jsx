import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowRight, Scissors, Square } from 'lucide-react';
import Pill from '../../ui/Pill';
import ProgressBar from '../../ui/ProgressBar';
import { blenderFilmSummary, blenderJobPercent, isBlenderJobActive } from '../../../lib/musicVideoBlender.js';
import { musicVideoBlenderMediaUrl } from '../../../services/apiMusicVideo.js';
import { formatCount, formatDateTime, formatDurationSec, timeAgo } from '../../../utils/formatters.js';
import { buttonCls, noticeCls, primaryCls } from './blenderStyles.js';

export const BLENDER_CUT_PARAM = 'bcut';
const QUALITY_LABELS = { preview: 'Preview', final: 'Final' };
const shotList = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).join(', ')} and ${formatCount(ids.length - 6)} more` : ids.join(', '));

// What one cut is missing: shots that had no render (black frames), shots whose render was out
// of date when it was cut, and shots rendered again since (the cut still shows their old picture).
function CutWarnings({ cut }) {
  const missing = cut.missing || [];
  const stale = cut.stale || [];
  const rerendered = cut.rerendered || [];
  if (!missing.length && !stale.length && !rerendered.length) return null;
  return (
    <div role="status" className={`${noticeCls} space-y-0.5`}>
      {missing.length > 0 && <p className="break-words">{formatCount(missing.length)} {missing.length === 1 ? 'shot was not rendered and plays' : 'shots were not rendered and play'} as black: {shotList(missing)}.</p>}
      {stale.length > 0 && <p className="break-words">{formatCount(stale.length)} {stale.length === 1 ? 'shot was' : 'shots were'} out of date when this was cut: {shotList(stale)}.</p>}
      {rerendered.length > 0 && (
        <p className="break-words">
          {formatCount(rerendered.length)} {rerendered.length === 1 ? 'shot was' : 'shots were'} rendered again after this cut: {shotList(rerendered)}. Assemble a new cut to see {rerendered.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  );
}

// One line for the cut list: what the cut lacks, or that it still matches the renders.
function cutSummary(cut) {
  const parts = [
    cut.missing?.length ? `${formatCount(cut.missing.length)} missing` : null,
    cut.stale?.length ? `${formatCount(cut.stale.length)} out of date` : null,
    cut.rerendered?.length ? `${formatCount(cut.rerendered.length)} rendered since` : null,
  ].filter(Boolean);
  return parts.length ? { text: parts.join(' · '), tone: 'text-port-warning' } : { text: 'matches the renders', tone: 'text-port-success' };
}

/**
 * Work-in-progress cuts: assemble the shot videos in film order against the
 * master song (a shot with no render plays as black), watch the newest, and
 * see what each cut was missing. A cut can also be published as the review
 * draft and finished with the project's film look (slower). The cut playing
 * is `?bcut=<id>`, the newest by default. The finished video itself is
 * rendered from the Final render step.
 */
export default function BlenderCutTab({ blender, onGoToFinalRender }) {
  const { state, pending } = blender;
  const [searchParams, setSearchParams] = useSearchParams();
  const [animatic, setAnimatic] = useState(false);
  const [filmLook, setFilmLook] = useState(false);
  const shots = state.manifest?.shots || [];
  const cuts = (state.cuts || []).slice().sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
  const requested = searchParams.get(BLENDER_CUT_PARAM);
  const cut = cuts.find((entry) => entry.id === requested) || cuts[0] || null;
  const cutJobs = (state.jobs || []).filter((job) => job.kind === 'cut' && isBlenderJobActive(job));
  const progress = blenderFilmSummary(state);
  const rendered = (quality) => shots.filter((shot) => state.renders?.[shot.id]?.[quality]?.complete).length;
  const select = (id) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(BLENDER_CUT_PARAM, id);
    return next;
  }, { replace: true });
  const assemble = (quality) => blender.assembleCut({ quality, ...(animatic ? { animatic: true } : {}), ...(filmLook ? { filmLook: true } : {}) });

  return (
    <div className="@container min-w-0 space-y-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {['preview', 'final'].map((quality) => {
            const busy = !!pending[`cut:${quality}`] || cutJobs.some((job) => job.quality === quality);
            return (
              <button key={quality} type="button" className={quality === 'preview' ? primaryCls : buttonCls} disabled={busy || !shots.length} onClick={() => assemble(quality)}>
                <Scissors size={14} aria-hidden="true" />
                {busy ? `Assembling ${quality} cut…` : `Assemble ${quality} cut`}
              </button>
            );
          })}
          <label htmlFor="mv-blender-cut-animatic" className="inline-flex min-h-[44px] items-center gap-1.5 text-xs pointer-fine:sm:min-h-0">
            <input id="mv-blender-cut-animatic" type="checkbox" checked={animatic} onChange={(event) => setAnimatic(event.target.checked)} />
            Also publish as review draft
          </label>
          <label htmlFor="mv-blender-cut-filmlook" className="inline-flex min-h-[44px] items-center gap-1.5 text-xs pointer-fine:sm:min-h-0">
            <input id="mv-blender-cut-filmlook" type="checkbox" checked={filmLook} onChange={(event) => setFilmLook(event.target.checked)} />
            Apply film look (slower)
          </label>
        </div>
        <p className="text-xs text-port-text-muted">
          {shots.length
            ? `${formatCount(rendered('preview'))} of ${formatCount(shots.length)} shots have a preview and ${formatCount(rendered('final'))} a final. A shot with no render plays as black for its length; the master song runs under the whole cut.`
            : 'Sync the shots from the scripts before assembling a cut.'}
        </p>
      </div>

      {cutJobs.map((job) => (
        <div key={job.id} role="status" className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-port-border p-2 text-xs">
          <span className="shrink-0">Assembling the {job.quality || ''} cut{job.status === 'queued' ? ' (queued)' : ''}</span>
          <ProgressBar percent={job.status === 'queued' ? 0 : blenderJobPercent(job)} label={`${job.quality || ''} cut progress`} className="min-w-[6rem] flex-1" />
          <button type="button" className={buttonCls} disabled={!!pending[`cancel:${job.id}`]} onClick={() => blender.cancelJob(job.id)}>
            <Square size={14} aria-hidden="true" /> Cancel
          </button>
        </div>
      ))}

      {cut ? (
        <div className="grid min-w-0 grid-cols-1 items-start gap-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)]">
          <div className="min-w-0 space-y-1.5">
            <video
              // The same file is rewritten when a cut is assembled again under the same name.
              key={`${cut.file}:${cut.createdAt || ''}`}
              src={musicVideoBlenderMediaUrl(blender.projectId, cut.file)}
              aria-label={`${QUALITY_LABELS[cut.quality] || 'Work-in-progress'} cut`}
              className="max-h-[50dvh] w-full rounded bg-black object-contain"
              controls playsInline preload="metadata"
            />
            <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-port-text-muted">
              <Pill size="xs" tone={cut.quality === 'final' ? 'success' : 'accent'}>{QUALITY_LABELS[cut.quality] || cut.quality} cut</Pill>
              {cut.filmLook === true && <Pill size="xs" tone="muted">film look</Pill>}
              <span title={formatDateTime(cut.createdAt)}>{timeAgo(cut.createdAt)}</span>
              {Number.isFinite(cut.durationSec) && <span>{formatDurationSec(cut.durationSec)}</span>}
            </p>
            <CutWarnings cut={cut} />
          </div>
          <ul aria-label="Cuts" className="min-w-0 divide-y divide-port-border rounded border border-port-border">
            {cuts.map((entry) => {
              const summary = cutSummary(entry);
              return (
                <li key={entry.id}>
                  <button type="button" aria-pressed={entry.id === cut.id} onClick={() => select(entry.id)}
                    className={`flex min-h-[44px] w-full min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-port-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-port-accent ${entry.id === cut.id ? 'bg-port-accent/10' : ''}`}>
                    <Pill size="xs" tone={entry.quality === 'final' ? 'success' : 'accent'}>{QUALITY_LABELS[entry.quality] || entry.quality}</Pill>
                    {entry.filmLook === true && <Pill size="xs" tone="muted">film look</Pill>}
                    <span title={formatDateTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
                    {Number.isFinite(entry.durationSec) && <span className="text-port-text-muted">{formatDurationSec(entry.durationSec)}</span>}
                    <span className={summary.tone}>{summary.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-port-text-muted">No cut yet. Assemble a preview cut to watch the film against the song.</p>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-port-border pt-2 text-xs text-port-text-muted">
        <span className="min-w-0">
          A cut is a work in progress. The finished video is rendered from Final render once every shot has a current final render
          ({formatCount(progress.finalReady)} of {formatCount(progress.total)} ready) and the storyboard is approved.
        </span>
        <button type="button" className={buttonCls} onClick={onGoToFinalRender}>
          Go to Final render <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
