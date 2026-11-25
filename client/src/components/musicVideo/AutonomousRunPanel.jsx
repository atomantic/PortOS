import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ExternalLink, Wand2 } from 'lucide-react';
import {
  AUTONOMOUS_VIEWABLE_STAGES, autonomousStageOutput, autonomousStageRows, isAutonomousLive, isOrchestratedRun,
} from '../../lib/musicVideoAutonomous.js';
import { MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../lib/musicVideoAutomation.js';
import { productionReviewStopGuidance } from '../../lib/musicVideoStages.js';
import { formatCount, formatUsd } from '../../utils/formatters.js';
import AutoApproveFields from './AutoApproveFields.jsx';
import OrchestratorReviewLog from './OrchestratorReviewLog.jsx';
import AutonomousStageList from './autonomousRun/AutonomousStageList.jsx';
import CheckpointApprovalBox from './autonomousRun/CheckpointApprovalBox.jsx';
import ParkedRunControls from './autonomousRun/ParkedRunControls.jsx';
import useScopedDraft from './autonomousRun/useScopedDraft.js';
import useSunoSongDrafts from './autonomousRun/useSunoSongDrafts.js';
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from '../../lib/musicVideoRunStatus.js';

const VIDEO_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((tool) => tool.id.startsWith('video:'));

function checkpointEdit(run, awaiting) {
  if (awaiting === 'lyrics') return { key: 'lyrics', label: 'Lyrics', value: run.output?.lyrics || '' };
  if (awaiting === 'style') return { key: 'style', label: 'Suno style', value: run.output?.sunoStyle || '' };
  return null;
}

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
            <Link to={field.href} className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline min-h-[44px] pointer-fine:sm:min-h-0">
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

function RunHeader({ run, framed, orchestrator }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {framed && <span className="flex items-center gap-1 text-sm font-medium"><Wand2 size={15} className="text-port-accent" aria-hidden="true" /> Autonomous run</span>}
      <span className={`text-sm ${RUN_STATUS_TONES[run.status] || ''}`}>{run.interrupted ? 'Interrupted — resume to continue' : RUN_STATUS_LABELS[run.status] || run.status}</span>
      {orchestrator && (
        <span className="text-xs text-port-text-muted break-all">Orchestrated by {orchestrator.providerId}{orchestrator.model ? ` / ${orchestrator.model}` : ''}{orchestrator.effort ? ` · ${orchestrator.effort}` : ''}</span>
      )}
      {run.brief?.origin?.kind === 'schedule' && (
        <span className="text-xs text-port-text-muted">Scheduled{run.brief.origin.ideaTitle ? ` · from “${run.brief.origin.ideaTitle}”` : ''}</span>
      )}
    </div>
  );
}

// The production budget tracks video spend. Suno generations are counted separately.
function RunSpend({ project, run, sunoCount }) {
  const productionRunId = run.output?.productionRunId;
  const spendRun = productionRunId && project.productionRuns?.find((item) => item.id === productionRunId);
  if (!spendRun) return null;

  return (
    <p aria-label="Run spend" className="text-xs text-port-text-muted break-words">
      {formatCount(spendRun.usage?.generations ?? 0)}/{formatCount(spendRun.limits?.maxGenerations ?? 0)} generations
      {' · '}{formatUsd(spendRun.usage?.spentUsd ?? 0)}{spendRun.limits?.spendCapUsd != null ? ` of ${formatUsd(spendRun.limits.spendCapUsd)} video budget` : ' video spend (no cap)'}
      {sunoCount > 0 && ` · ${formatCount(sunoCount)} Suno generation${sunoCount === 1 ? '' : 's'} (separate)`}
      {' · '}<Link to={`/music-video/${encodeURIComponent(project.id)}/produce`} className="text-port-accent hover:underline">View production run</Link>
    </p>
  );
}

function RunNotices({ run, project, readiness }) {
  const guidance = productionReviewStopGuidance(run, readiness);
  return (
    <>
      {run.error && (
        <p role="status" className="flex items-start gap-1 text-xs text-port-warning break-words min-w-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> <span className="min-w-0">{guidance?.current || run.error}</span>
        </p>
      )}

      {run.status === 'completed' && project.renderHistoryId && (
        <Link to={`/music-video/${encodeURIComponent(project.id)}/review`} className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline min-h-[44px] pointer-fine:sm:min-h-0">
          Watch final video <ExternalLink size={12} aria-hidden="true" />
        </Link>
      )}

      {guidance?.historical && <p className="text-xs text-port-text-muted break-words">Historical stop reason: {guidance.historical}</p>}
    </>
  );
}

// Every resume path carries the selected planning grant and shows authorization failures inline.
function useRunResume(run, auto) {
  const autoApprove = useScopedDraft(run?.id, (run?.brief?.autoApprove || []).filter(stage => stage !== 'proof'));
  const [grantError, setGrantError] = useState(null);
  const changeGrant = (next) => {
    autoApprove.setValue(next);
    setGrantError(null);
  };
  const resume = (edits = {}) => {
    if (!autoApprove.hasDraft) return auto.resume(edits);
    setGrantError(null);
    return auto.resume({ ...edits, autoApprove: autoApprove.value }, { inline: true })
      .then((res) => { autoApprove.clear(); return res; })
      .catch((err) => { setGrantError(err?.message || 'Could not grant auto-approval'); });
  };
  return { autoApprove: autoApprove.value, changeGrant, grantError, resume };
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
  const awaiting = run?.status === 'awaiting-approval' ? run.awaiting : null;
  const editable = checkpointEdit(run, awaiting);
  const draft = useScopedDraft(awaiting, editable?.value);
  const videoDraft = useScopedDraft(run?.id, {});
  const tools = useScopedDraft(run?.id, []);
  const { autoApprove, changeGrant, grantError, resume } = useRunResume(run, auto);
  const sunoCount = Array.isArray(run?.output?.sunoSongIds) ? run.output.sunoSongIds.length : 0;
  const song = useSunoSongDrafts(run, awaiting, sunoCount);

  if (!run) return null;
  const rows = autonomousStageRows(run);
  const live = isAutonomousLive(run);
  // A run canceled while waiting on production can resume: it adopts or restarts production.
  const reopenable = run.status === 'canceled' && run.stage === 'produce';
  const canRetry = ['needs-human', 'failed', 'stopped'].includes(run.status) || run.interrupted || reopenable;
  const canAct = live || run.status === 'failed' || reopenable;
  const activeTools = run.brief?.tools || [];
  const videoTools = canRetry && !awaiting && run.stage === 'produce' ? VIDEO_TOOLS.filter((tool) => activeTools.includes(tool.id)) : [];
  // Without a video tool, the clips have no route after stills approval.
  const missingVideoTools = awaiting === 'stills' && !activeTools.some((id) => id.startsWith('video:')) ? VIDEO_TOOLS : [];
  const orchestrator = isOrchestratedRun(run) ? run.brief.orchestrator : null;
  // A stale or hand-edited `?run-stage=` that names no finished, viewable stage opens nothing.
  const selectedRow = rows.find((row) => row.id === selectedStage && row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id));
  const selected = selectedRow?.id || null;

  return (
    <section id="mv-autonomous-run" className={`${framed ? 'bg-port-card border border-port-border rounded-lg p-3 ' : ''}space-y-3 min-w-0`} aria-label="Autonomous run">
      <RunHeader run={run} framed={framed} orchestrator={orchestrator} />

      <AutonomousStageList rows={rows} selected={selected} onSelectStage={onSelectStage} />

      <RunSpend project={project} run={run} sunoCount={sunoCount} />

      {orchestrator && <OrchestratorReviewLog run={run} />}

      {selectedRow && <StageOutput run={run} row={selectedRow} editableBelow={!!editable && awaiting === selectedRow.id} />}

      <RunNotices run={run} project={project} readiness={readiness} />

      {awaiting && (
        <CheckpointApprovalBox
          awaiting={awaiting}
          editable={editable}
          draft={draft}
          missingVideoTools={missingVideoTools}
          tools={tools}
          song={song}
          busy={auto.busy}
          resume={resume}
        />
      )}

      {!orchestrator && (awaiting || canRetry) && canAct && (
        <AutoApproveFields
          idPrefix="mv-run"
          value={autoApprove}
          onChange={changeGrant}
          error={grantError}
          granted={run.brief?.autoApprove || []}
        />
      )}

      <ParkedRunControls
        run={run}
        auto={auto}
        resume={resume}
        videoTools={videoTools}
        videoDraft={videoDraft}
        song={song}
        canAct={canAct}
        canRetry={canRetry}
        awaiting={awaiting}
        reopenable={reopenable}
      />
    </section>
  );
}
