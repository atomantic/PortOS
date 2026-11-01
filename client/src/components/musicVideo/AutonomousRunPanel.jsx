import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, Circle, CircleDot, ExternalLink, Loader2, Pause, Play, RotateCcw, Wand2, X, XCircle } from 'lucide-react';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_PRODUCE_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_STATUS_LABELS, AUTONOMOUS_VIEWABLE_STAGES,
  autonomousStageOutput, autonomousStageRows, isAutonomousLive, isOrchestratedRun,
} from '../../lib/musicVideoAutonomous.js';
import { MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../lib/musicVideoAutomation.js';
import { VideoModelField } from './ToolPicker.jsx';
import { productionReviewStopGuidance } from '../../lib/musicVideoStages.js';
import { formatCount, formatUsd } from '../../utils/formatters.js';
import AutoApproveFields from './AutoApproveFields.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import OrchestratorReviewLog from './OrchestratorReviewLog.jsx';
import { isSunoSongUrl, sunoSongIdFromUrl } from '../../../../server/lib/sunoSong.js';

// The stages that report a sub-step while they run (the server's `stages[id].step`).
const STEP_LABELS = { lyrics: AUTONOMOUS_LYRICS_STEP_LABELS, produce: AUTONOMOUS_PRODUCE_STEP_LABELS, song: AUTONOMOUS_SONG_STEP_LABELS };

const STATUS_TONES = {
  running: 'text-port-accent', 'awaiting-approval': 'text-port-warning', 'needs-human': 'text-port-warning', stopped: 'text-port-warning',
  completed: 'text-port-success', failed: 'text-port-error', canceled: 'text-port-text-muted',
};
const STAGE_MARKS = {
  done: { Icon: CheckCircle2, cls: 'text-port-success', label: 'done' },
  running: { Icon: Loader2, cls: 'text-port-accent animate-spin', label: 'running' },
  failed: { Icon: XCircle, cls: 'text-port-error', label: 'failed' },
  pending: { Icon: Circle, cls: 'text-port-text-muted', label: 'not started' },
};
const BARE_SUNO_SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A bare Suno song id or a Suno song page link; an id inside any other URL or text is not one.
const pastedSunoSongId = (text) => {
  const value = text.trim();
  if (BARE_SUNO_SONG_ID.test(value)) return value.toLowerCase();
  return isSunoSongUrl(value) ? sunoSongIdFromUrl(value) : null;
};
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const buttonClass = 'flex items-center gap-1 rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/** The read-only output of one stage the director opened from the checklist. */
function StageOutput({ run, row, editableBelow }) {
  const fields = autonomousStageOutput(run, row.id);
  return (
    <div id={`mv-run-stage-${row.id}`} role="region" aria-label={`${row.label} output`} className="rounded border border-port-border bg-port-bg p-2 space-y-2 min-w-0">
      {fields.length === 0 && <p className="text-xs text-port-text-muted">This stage did not store anything to show.</p>}
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <div className="text-xs text-port-text-muted">{field.label}</div>
          {field.href ? (
            <Link to={field.href} className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline min-h-[44px] sm:min-h-0">
              {field.text} <ExternalLink size={12} aria-hidden="true" />
            </Link>
          ) : (
            <p className={`text-sm break-words ${field.multiline ? 'whitespace-pre-wrap' : ''} ${field.mono ? 'font-mono text-xs' : ''}`}>{field.text}</p>
          )}
        </div>
      ))}
      {editableBelow && <p className="text-xs text-port-text-muted">Edit this in the approval box below before continuing.</p>}
    </div>
  );
}

/**
 * The fully-autonomous run on a project: where it is in the pipeline, what it is
 * waiting for, and the few things the director can do — approve a checkpoint
 * (optionally with edited lyrics or Suno style), retake the song at the song
 * checkpoint, retry the stage that stopped,
 * pause, or cancel. A finished stage's output (brief, lyrics, style, song) opens
 * read-only from its checklist row; the open row is the caller's URL state
 * (`selectedStage` / `onSelectStage`). Progress arrives over `music-video:autonomous` through
 * `useAutonomousMusicVideo`; this panel only renders the run it is given.
 * `framed={false}` drops the card chrome and title for a host that supplies them.
 */
export default function AutonomousRunPanel({ project, auto, readiness, selectedStage = null, onSelectStage, framed = true }) {
  const run = project?.autonomousRun;
  const [edit, setEdit] = useState(null); // { for: stage, value } — the director's edit at a checkpoint
  // Planning approval authority is granted with the next explicit resume.
  const [autoApproveEdit, setAutoApproveEdit] = useState(null);
  const autoApprove = autoApproveEdit && autoApproveEdit.runId === run?.id ? autoApproveEdit.value : (run?.brief?.autoApprove || []).filter(stage => stage !== 'proof');
  const [grantError, setGrantError] = useState(null);
  // The video model swaps the director picked for a parked production stage: { runId, value: { 'video:<mode>': id } }.
  const [videoSwapEdit, setVideoSwapEdit] = useState(null);
  // Video tools the director adds while approving the stills: { runId, value: ['video:<mode>'] }.
  const [addToolsEdit, setAddToolsEdit] = useState(null);
  // The Suno render the director picks to download at the song checkpoint, or a song they made
  // or revised in Suno themselves, pasted as a link: { for, value }, where `for` names the run
  // and its renders, so a retake's new renders start from a fresh pick with the link cleared.
  const [songPick, setSongPick] = useState(null);
  const [songLink, setSongLink] = useState(null);
  if (!run) return null;
  const guidance = productionReviewStopGuidance(run, readiness);
  const rows = autonomousStageRows(run);
  const live = isAutonomousLive(run);
  const awaiting = run.status === 'awaiting-approval' ? run.awaiting : null;
  // The one editable output each checkpoint offers: lyrics before the style
  // stage, the Suno style line before the song is made.
  const editable = awaiting === 'lyrics' ? { key: 'lyrics', label: 'Lyrics', value: run.output?.lyrics || '' }
    : awaiting === 'style' ? { key: 'style', label: 'Suno style', value: run.output?.sunoStyle || '' } : null;
  const draft = edit && edit.for === awaiting ? edit.value : editable?.value;
  const changed = editable && draft !== editable.value;
  // A run canceled while waiting on production can resume: it adopts or restarts production.
  const reopenable = run.status === 'canceled' && run.stage === 'produce';
  const canRetry = ['needs-human', 'failed', 'stopped'].includes(run.status) || run.interrupted || reopenable;
  // A run parked in production can swap its video model on Resume; the same production run carries on.
  const videoTools = canRetry && !awaiting && run.stage === 'produce'
    ? MUSIC_VIDEO_AUTOMATION_TOOLS.filter((tool) => tool.id.startsWith('video:') && (run.brief?.tools || []).includes(tool.id))
    : [];
  const videoSwaps = videoSwapEdit && videoSwapEdit.runId === run.id ? videoSwapEdit.value : {};
  // Stills approved on a run with no video tool: offer one, or the clips have no route.
  const missingVideoTools = awaiting === 'stills' && !(run.brief?.tools || []).some((id) => id.startsWith('video:'))
    ? MUSIC_VIDEO_AUTOMATION_TOOLS.filter((tool) => tool.id.startsWith('video:')) : [];
  const addTools = addToolsEdit && addToolsEdit.runId === run.id ? addToolsEdit.value : [];
  const modelsSwap = Object.fromEntries(Object.entries(videoSwaps).filter(([tool, id]) => id !== (run.brief?.models?.[tool] || '')).map(([tool, id]) => [tool, id || null]));
  const orchestrator = isOrchestratedRun(run) ? run.brief.orchestrator : null;
  const tone = STATUS_TONES[run.status] || '';
  // #10157: what the production run has used against its limits (Suno is counted apart).
  const spendRun = run.output?.productionRunId ? (project.productionRuns || []).find((r) => r.id === run.output.productionRunId) : null;
  const sunoCount = Array.isArray(run.output?.sunoSongIds) ? run.output.sunoSongIds.length : 0;
  // Parked on fresh Suno renders before their download (a download spends one of the account's
  // monthly downloads): the director listens on Suno and approves the one to download.
  const songRenders = awaiting === 'song' && run.stage === 'song' && !run.output?.trackId && sunoCount ? run.output.sunoSongIds : [];
  const songsFor = `${run.id}:${songRenders.join(',')}`;
  const linkText = songLink && songLink.for === songsFor ? songLink.value : '';
  const linkedSong = pastedSunoSongId(linkText);
  const pickedRender = !songRenders.length ? null
    : linkedSong || (songPick && songPick.for === songsFor && songRenders.includes(songPick.value) ? songPick.value : songRenders[songRenders.length > 1 ? 1 : 0]);
  // A failed run that only has the final render left retries just that.
  const retryLabel = run.status === 'failed' && run.stage === 'produce' && (run.output?.renderJobId || run.output?.productionDone) ? 'Retry render' : run.status === 'failed' ? 'Retry' : 'Resume';
  // A stale or hand-edited `?run-stage=` that names no finished, viewable stage opens nothing.
  const selectedRow = rows.find((row) => row.id === selectedStage && row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id)) || null;
  const selected = selectedRow?.id || null;
  // Every resume path carries the selected grant and shows authorization failures inline.
  const resume = (rawEdits = {}) => {
    const edits = Object.keys(modelsSwap).length && videoTools.length ? { ...rawEdits, models: modelsSwap } : rawEdits;
    if (!autoApproveEdit || autoApproveEdit.runId !== run.id) return auto.resume(edits);
    setGrantError(null);
    return auto.resume({ ...edits, autoApprove }, { inline: true })
      .then((res) => { setAutoApproveEdit(null); return res; })
      .catch((err) => { setGrantError(err?.message || 'Could not grant auto-approval'); });
  };

  return (
    <section id="mv-autonomous-run" className={`${framed ? 'bg-port-card border border-port-border rounded-lg p-3 ' : ''}space-y-3 min-w-0`} aria-label="Autonomous run">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {framed && <span className="flex items-center gap-1 text-sm font-medium"><Wand2 size={15} className="text-port-accent" aria-hidden="true" /> Autonomous run</span>}
        <span className={`text-sm ${tone}`}>{run.interrupted ? 'Interrupted — resume to continue' : AUTONOMOUS_STATUS_LABELS[run.status] || run.status}</span>
        {orchestrator && (
          <span className="text-xs text-port-text-muted break-all">Orchestrated by {orchestrator.providerId}{orchestrator.model ? ` / ${orchestrator.model}` : ''}{orchestrator.effort ? ` · ${orchestrator.effort}` : ''}</span>
        )}
        {run.brief?.origin?.kind === 'schedule' && (
          <span className="text-xs text-port-text-muted">Scheduled{run.brief.origin.ideaTitle ? ` · from “${run.brief.origin.ideaTitle}”` : ''}</span>
        )}
      </div>

      <ol aria-label="Autonomous stages" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => {
          const { Icon, cls, label } = STAGE_MARKS[row.status] || STAGE_MARKS.pending;
          const mark = row.current && row.status === 'pending' ? <CircleDot size={13} className="shrink-0 text-port-accent" aria-hidden="true" /> : <Icon size={13} className={`shrink-0 ${cls}`} aria-hidden="true" />;
          const content = (
            <>
              {mark}
              <span className="truncate">{row.label}</span>
              <span className="sr-only">({label})</span>
            </>
          );
          const tone = row.current ? 'font-medium text-port-text' : 'text-port-text-muted';
          // Only a stage that finished and keeps something to show opens.
          const openable = row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id) && onSelectStage;
          return (
            <li key={row.id} aria-current={row.current ? 'step' : undefined} className="min-w-0">
              {openable ? (
                <button
                  type="button"
                  aria-expanded={selected === row.id}
                  aria-controls={`mv-run-stage-${row.id}`}
                  onClick={() => onSelectStage(selected === row.id ? null : row.id)}
                  className={`flex w-full min-w-0 items-center gap-1 rounded px-1 -mx-1 min-h-[44px] sm:min-h-0 hover:bg-port-bg ${selected === row.id ? 'bg-port-bg' : ''} ${tone}`}
                >
                  {content}
                </button>
              ) : (
                <span className={`flex min-w-0 items-center gap-1 ${tone}`}>{content}</span>
              )}
              {STEP_LABELS[row.id] && row.status === 'running' && row.step && (
                <p role="status" className="pl-[17px] text-port-accent break-words">{STEP_LABELS[row.id][row.step] || row.step}…</p>
              )}
            </li>
          );
        })}
      </ol>

      {spendRun && (
        <p aria-label="Run spend" className="text-xs text-port-text-muted break-words">
          {formatCount(spendRun.usage?.generations ?? 0)}/{formatCount(spendRun.limits?.maxGenerations ?? 0)} generations
          {' · '}{formatUsd(spendRun.usage?.spentUsd ?? 0)}{spendRun.limits?.spendCapUsd != null ? ` of ${formatUsd(spendRun.limits.spendCapUsd)} video budget` : ' video spend (no cap)'}
          {sunoCount > 0 && ` · ${formatCount(sunoCount)} Suno generation${sunoCount === 1 ? '' : 's'} (separate)`}
          {' · '}<Link to={`/music-video/${encodeURIComponent(project.id)}/produce`} className="text-port-accent hover:underline">View production run</Link>
        </p>
      )}

      {orchestrator && <OrchestratorReviewLog run={run} />}

      {selectedRow && <StageOutput run={run} row={selectedRow} editableBelow={!!editable && awaiting === selectedRow.id} />}

      {run.error && (
        <p role="status" className="flex items-start gap-1 text-xs text-port-warning break-words min-w-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> <span className="min-w-0">{guidance?.current || run.error}</span>
        </p>
      )}

      {run.status === 'completed' && project.renderHistoryId && (
        <Link to={`/music-video/${encodeURIComponent(project.id)}/review`} className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline min-h-[44px] sm:min-h-0">
          Watch final video <ExternalLink size={12} aria-hidden="true" />
        </Link>
      )}

      {guidance?.historical && <p className="text-xs text-port-text-muted break-words">Historical stop reason: {guidance.historical}</p>}

      {awaiting && (
        <div className="rounded border border-port-border p-2 space-y-2">
          <p className="text-xs text-port-text-muted">
            Paused after <strong className="text-port-text">{AUTONOMOUS_CHECKPOINT_LABELS[awaiting] || awaiting}</strong> — nothing further runs until you approve.
          </p>
          {editable && (
            <div>
              <label htmlFor="mv-auto-edit" className="block text-xs text-port-text-muted mb-1">{editable.label} (edit before continuing)</label>
              <textarea
                id="mv-auto-edit"
                rows={editable.key === 'lyrics' ? 10 : 3}
                value={draft}
                onChange={(e) => setEdit({ for: awaiting, value: e.target.value })}
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
          )}
          {songRenders.length > 0 && (
            <fieldset className="min-w-0" aria-label="Suno render to download">
              <span className="block text-xs text-port-text-muted mb-1">Listen on Suno, then pick the render to download. Approving downloads only that one (it uses one Suno download).</span>
              <div className="flex flex-col gap-1">
                {songRenders.map((id, i) => (
                  <label key={id} className="flex items-center gap-2 text-sm min-w-0">
                    <input type="radio" name="mv-run-song-pick" checked={pickedRender === id} onChange={() => { setSongPick({ for: songsFor, value: id }); setSongLink(null); }} />
                    <span>Render {i + 1}</span>
                    <a href={`https://suno.com/song/${id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-port-accent text-xs">
                      Listen <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </label>
                ))}
              </div>
              <label htmlFor="mv-run-song-link" className="block text-xs text-port-text-muted mt-2 mb-1">Or a version you made or revised in Suno (paste its link)</label>
              <input
                id="mv-run-song-link"
                type="text"
                value={linkText}
                onChange={(e) => setSongLink({ for: songsFor, value: e.target.value })}
                placeholder="https://suno.com/song/…"
                className={`${inputClass} text-xs`}
              />
              {linkText.trim() && !linkedSong && <p className="text-xs text-port-error mt-1">That is not a Suno song link.</p>}
            </fieldset>
          )}
          <div className="flex flex-wrap gap-2">
            {missingVideoTools.length > 0 && (
              <fieldset className="w-full min-w-0" aria-label="Video tool for the clips">
                <span className="block text-xs text-port-text-muted mb-1">Make the clips with</span>
                <div className="flex flex-wrap gap-1.5">
                  {missingVideoTools.map((tool) => (
                    <ToggleChip
                      key={tool.id}
                      id={`mv-run-add-${tool.id}`}
                      label={tool.label}
                      checked={addTools.includes(tool.id)}
                      onToggle={() => setAddToolsEdit({ runId: run.id, value: addTools.includes(tool.id) ? addTools.filter((id) => id !== tool.id) : [...addTools, tool.id] })}
                    />
                  ))}
                </div>
              </fieldset>
            )}
            <button type="button" disabled={auto.busy || (missingVideoTools.length > 0 && !addTools.length) || (linkText.trim() !== '' && !linkedSong)} title={missingVideoTools.length > 0 && !addTools.length ? 'Choose a video tool to make the clips' : undefined} onClick={() => resume({ ...(changed ? { [editable.key]: draft } : {}), ...(addTools.length ? { addTools } : {}), ...(pickedRender ? { sunoSongId: pickedRender } : {}) })} className={`${buttonClass} bg-port-accent text-white border-port-accent`}>
              <Play size={14} aria-hidden="true" /> {changed ? 'Save edit & approve' : pickedRender ? 'Approve & download this render' : 'Approve & continue'}
            </button>
            {awaiting === 'song' && (
              // Discards this song and makes a new one (a new Suno generation spends credits), then pauses here again.
              <button type="button" disabled={auto.busy} onClick={() => resume({ retakeSong: true })} className={buttonClass}>
                <RotateCcw size={14} aria-hidden="true" /> Retake song
              </button>
            )}
          </div>
        </div>
      )}

      {!orchestrator && (awaiting || canRetry) && (live || run.status === 'failed' || reopenable) && (
        <AutoApproveFields
          idPrefix="mv-run"
          value={autoApprove}
          onChange={(next) => { setAutoApproveEdit({ runId: run.id, value: next }); setGrantError(null); }}
          error={grantError}
          granted={run.brief?.autoApprove || []}
        />
      )}

      {videoTools.length > 0 && (
        <fieldset aria-label="Swap the video model" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
          {videoTools.map((tool) => (
            <VideoModelField
              key={tool.id}
              id={`mv-run-video-model-${tool.id}`}
              tool={tool}
              value={tool.id in videoSwaps ? videoSwaps[tool.id] : run.brief?.models?.[tool.id] || ''}
              onChange={(value) => setVideoSwapEdit({ runId: run.id, value: { ...videoSwaps, [tool.id]: value } })}
            />
          ))}
        </fieldset>
      )}

      {live || run.status === 'failed' || reopenable ? (
        <div className="flex flex-wrap gap-2">
          {canRetry && !awaiting && (
            <button type="button" disabled={auto.busy} onClick={() => resume()} className={buttonClass}>
              <Play size={14} aria-hidden="true" /> {retryLabel}
            </button>
          )}
          {run.status === 'running' && !run.interrupted && (
            <button type="button" disabled={auto.busy} onClick={() => auto.stop()} className={buttonClass}><Pause size={14} aria-hidden="true" /> Pause</button>
          )}
          {!reopenable && <button type="button" disabled={auto.busy} onClick={() => auto.cancel()} className={`${buttonClass} text-port-error`}><X size={14} aria-hidden="true" /> Cancel</button>}
        </div>
      ) : null}
    </section>
  );
}
