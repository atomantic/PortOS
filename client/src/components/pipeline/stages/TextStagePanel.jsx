/**
 * Shared editor for the four text stages (idea, prose, comicScript, teleplay).
 * Each per-stage component wraps this with stage-specific labels + placeholders
 * — the underlying mechanic is identical: textarea for the user's edits +
 * generate button that calls the server's text-stage runner.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Save, History, Check, X } from 'lucide-react';
import toast from '../../ui/Toast';
import ProseEditor from '../../ui/ProseEditor';
import {
  generatePipelineStage, updatePipelineIssue,
  pipelineStageProgressUrl,
  PIPELINE_STAGE_LABELS,
  PIPELINE_TEXT_STAGES,
  PIPELINE_DEFAULT_FORWARD_SOURCE as DEFAULT_FORWARD_SOURCE,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { useSseProgress, isTerminalSseFrame } from '../../../hooks/useSseProgress';
import { formatDurationMs } from '../../../utils/formatters';
import StageHistoryModal from './StageHistoryModal';

const stageHasContent = (stage) => Boolean(stage?.input?.trim() || stage?.output?.trim());

// Human-readable labels for the live progress line, mirroring PolishPanel's
// phase-label pattern. The server's own `label` is the fallback so a new phase
// still reads sensibly before this map catches up.
const PHASE_LABEL = {
  context: 'Building prompt context…',
  generate: 'Drafting…',
  judge: 'Judging the draft…',
  restore: 'Restoring the best draft…',
  budget: 'Budget spent — keeping the best draft…',
  canon: 'Extracting canon…',
};

// null/undefined = the judge never scored this attempt, which is NOT the same as
// a legitimate score of 0 — render the two differently rather than gating on
// truthiness.
const fmtScore = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '—');

export default function TextStagePanel({
  issue,
  series,
  stageId,
  onStageUpdate,
  seedPlaceholder,
  outputPlaceholder,
  generateLabel = 'Generate',
  extraActions = null,
  actionsGated = false,
  // The prose stage opts into the shared reading-comfortable <ProseEditor>
  // (serif, spellcheck) for its output; the script-shaped stages keep the
  // mono textarea that suits slugline/panel markup.
  proseEditor = false,
}) {
  const stage = issue.stages?.[stageId] || { status: 'empty', input: '', output: '', runHistory: [] };
  const [draftOutput, setDraftOutput] = useState(stage.output || '');
  const [draftInput, setDraftInput] = useState(stage.input || '');
  // Server-pushed in-flight state — separate from the hook's local-action
  // running flag so an auto-run kicked off elsewhere still keeps the
  // Generate button locked.
  const [serverGenerating, setServerGenerating] = useState(stage.status === 'generating');
  const [historyOpen, setHistoryOpen] = useState(false);
  const runHistory = stage.runHistory || [];

  // Live generation progress (#3393). The URL is set for the duration of one
  // generate call; the server opens the channel when we attach, so subscribing
  // just before the POST can't race it. Frames survive the teardown so the
  // attempt scorecard stays on screen after the run finishes.
  const [progressUrl, setProgressUrl] = useState(null);
  // Which issue+stage the retained frames describe — the panel is reused across
  // issues, and a stale scorecard from a different record must not linger.
  const [progressFor, setProgressFor] = useState(null);
  const { frames } = useSseProgress(progressUrl, { enabled: !!progressUrl });
  const progressKey = `${issue.id}:${stageId}`;

  // Other text stages that currently have content — the candidate source
  // material for this generation. Excludes the target stage itself. Lets you
  // generate any stage FROM any other populated stage (backport), e.g. prose
  // from a comic script. Ordered by the canonical stage order.
  const availableSources = useMemo(
    () => PIPELINE_TEXT_STAGES.filter(
      (id) => id !== stageId && stageHasContent(issue.stages?.[id]),
    ),
    [issue.stages, stageId],
  );

  // Selected source stage ids. Defaults to the conventional forward source(s)
  // that exist; recomputed whenever the candidate set changes (issue/stage swap).
  const [selectedSources, setSelectedSources] = useState([]);
  useEffect(() => {
    const preferred = (DEFAULT_FORWARD_SOURCE[stageId] || []).filter((id) => availableSources.includes(id));
    setSelectedSources(preferred);
  }, [issue.id, stageId, availableSources]);

  const toggleSource = (id) => setSelectedSources(
    (prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]),
  );

  // Reset local edits when the stage record changes from the parent (e.g.
  // auto-run pushed a new output).
  useEffect(() => {
    setDraftOutput(stage.output || '');
    setDraftInput(stage.input || '');
    setServerGenerating(stage.status === 'generating');
  }, [stage.output, stage.input, stage.status, stage.lastRunId]);

  const [runGenerate, localGenerating] = useAsyncAction(
    () => generatePipelineStage(issue.id, stageId, {
      seedInput: draftInput,
      providerId: series?.llm?.provider || undefined,
      model: series?.llm?.model || undefined,
      // Only send when there's a real choice to make — omitting it lets the
      // server fall back to the conventional forward source (unchanged behavior).
      ...(availableSources.length ? { sourceStageIds: selectedSources } : {}),
    }, { silent: true }),
    { errorMessage: `Failed to generate ${stageId}` },
  );
  const generating = localGenerating || serverGenerating;

  const handleGenerate = async () => {
    // Subscribe to the progress stream first. It is purely advisory — an
    // environment without EventSource (or a channel that never opens) just
    // falls back to the spinner; generation itself is unaffected.
    setProgressFor(progressKey);
    if (typeof EventSource !== 'undefined') {
      setProgressUrl(pipelineStageProgressUrl(issue.id, stageId));
    }
    const result = await runGenerate();
    // Close the stream once the POST has settled — the terminal frame has
    // already landed, and the frames stay rendered after the teardown.
    setProgressUrl(null);
    if (!result) return;
    onStageUpdate?.(stageId, result.stage);
    toast.success(`${PIPELINE_STAGE_LABELS[stageId]} generated`);
  };

  // Derived progress view. `activePhase` is the most recent phase frame that
  // hasn't been superseded by a terminal frame — same walk PolishPanel does.
  const showProgress = progressFor === progressKey;
  const attemptFrames = useMemo(
    () => (showProgress ? frames.filter((f) => f.type === 'attempt') : []),
    [frames, showProgress],
  );
  const gateFrame = useMemo(
    () => (showProgress ? frames.find((f) => f.type === 'gate') || null : null),
    [frames, showProgress],
  );
  const activePhase = useMemo(() => {
    if (!generating || !showProgress) return null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (isTerminalSseFrame(frames[i])) return null;
      if (frames[i].type === 'phase') return frames[i];
    }
    return null;
  }, [frames, generating, showProgress]);

  const dirty = draftOutput !== (stage.output || '') || draftInput !== (stage.input || '');
  // Generate gates on OUTPUT drift only: the seed input is sent live with the
  // request (seedInput: draftInput), so unsaved seed edits are consumed, not
  // skipped — only an unsaved output edit would be clobbered by the result.
  const outputDirty = draftOutput !== (stage.output || '');

  const [runSave, saving] = useAsyncAction(
    () => updatePipelineIssue(issue.id, {
      stages: {
        [stageId]: {
          status: 'edited',
          input: draftInput,
          output: draftOutput,
        },
      },
    }),
    { errorMessage: 'Save failed' },
  );

  const handleSave = async () => {
    const updated = await runSave();
    if (!updated) return;
    onStageUpdate?.(stageId, updated.stages[stageId], updated);
    toast.success(`${PIPELINE_STAGE_LABELS[stageId]} saved`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">{PIPELINE_STAGE_LABELS[stageId]}</h2>
          <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[stage.status] || 'text-gray-500'}`}>
            {STATUS_LABEL[stage.status] || stage.status}
          </span>
          {stage.lastRunId ? (
            <span className="text-[10px] text-gray-600 font-mono">run {stage.lastRunId.slice(0, 8)}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {typeof extraActions === 'function' ? extraActions({ dirty: outputDirty }) : extraActions}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            disabled={runHistory.length === 0}
            title={runHistory.length === 0 ? 'No prior versions yet' : `${runHistory.length} prior version${runHistory.length === 1 ? '' : 's'}`}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
          >
            <History size={14} />
            History{runHistory.length ? ` (${runHistory.length})` : ''}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save edits
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || actionsGated || outputDirty}
            title={actionsGated ? 'Saving settings…' : (outputDirty ? 'Save or discard your edits first' : undefined)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generateLabel}
          </button>
        </div>
      </div>

      {availableSources.length > 0 ? (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="uppercase tracking-wider text-gray-500">Generate from:</span>
          {availableSources.map((id) => {
            const active = selectedSources.includes(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleSource(id)}
                aria-pressed={active}
                className={`px-2 py-1 rounded-full border transition-colors ${
                  active
                    ? 'bg-port-accent/20 border-port-accent text-white'
                    : 'bg-port-card border-port-border text-gray-400 hover:border-port-accent/50'
                }`}
              >
                {PIPELINE_STAGE_LABELS[id]}
              </button>
            );
          })}
        </div>
      ) : null}

      {(activePhase || attemptFrames.length > 0) ? (
        <div className="border border-port-border rounded p-3 space-y-2 bg-port-bg/40">
          <div className="flex items-center justify-between gap-2 text-[11px] flex-wrap">
            <span className="uppercase tracking-wider text-gray-500">Generation progress</span>
            {activePhase ? (
              <span className="flex items-center gap-1.5 text-port-accent">
                <Loader2 size={11} className="animate-spin" />
                {PHASE_LABEL[activePhase.phase] || activePhase.label || activePhase.phase}
                {activePhase.attempts > 1 ? (
                  <span className="text-gray-500">· attempt {activePhase.attempt} of {activePhase.attempts}</span>
                ) : null}
              </span>
            ) : null}
          </div>
          {attemptFrames.length > 0 ? (
            <ul className="space-y-1">
              {attemptFrames.map((f) => {
                // Before the gate frame lands nothing is decided yet — don't
                // pre-label an attempt as rejected mid-run.
                const decided = !!gateFrame;
                const won = decided && f.runId === gateFrame.winner;
                return (
                  <li key={f.runId || f.attempt} className="flex items-center gap-2 text-[12px]">
                    <span className="text-gray-500 w-20 shrink-0">Attempt {f.attempt}</span>
                    <span className="px-1.5 py-0.5 rounded border border-port-border bg-port-card text-[11px] tabular-nums shrink-0">
                      {fmtScore(f.qualityScore)}
                    </span>
                    {decided ? (
                      won ? (
                        <span className="flex items-center gap-1 text-port-success text-[11px]"><Check size={11} /> kept</span>
                      ) : (
                        <span className="flex items-center gap-1 text-gray-500 text-[11px]"><X size={11} /> rejected</span>
                      )
                    ) : null}
                    <span className="text-gray-600 text-[10px] tabular-nums ml-auto">
                      {Number.isFinite(f.outputLength) ? `${f.outputLength.toLocaleString()} chars · ` : ''}
                      {formatDurationMs(f.ms)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {gateFrame?.stoppedEarly ? (
            <div className="text-[11px] text-gray-500 italic">
              Stopped early after {gateFrame.ran} of {gateFrame.attempts} attempts.
            </div>
          ) : null}
        </div>
      ) : null}

      {stageId === 'idea' ? (
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Seed idea</span>
          <textarea
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            placeholder={seedPlaceholder}
            rows={4}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
          />
        </label>
      ) : null}

      <label className="block">
        <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Output</span>
        {proseEditor ? (
          <ProseEditor
            value={draftOutput}
            onChange={(e) => setDraftOutput(e.target.value)}
            placeholder={outputPlaceholder}
            rows={24}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
        ) : (
          <textarea
            value={draftOutput}
            onChange={(e) => setDraftOutput(e.target.value)}
            placeholder={outputPlaceholder}
            rows={24}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono leading-relaxed"
          />
        )}
      </label>

      {stage.errorMessage ? (
        <div className="text-xs text-port-error">{stage.errorMessage}</div>
      ) : null}

      <StageHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        issueId={issue.id}
        stageId={stageId}
        currentOutput={stage.output || ''}
        currentRunId={stage.lastRunId}
        runHistory={runHistory}
        restoreBlockedReason={dirty ? 'Save or discard your unsaved edits before restoring.' : null}
        onRestored={(restoredStage, restoredIssue) => {
          onStageUpdate?.(stageId, restoredStage, restoredIssue);
        }}
      />
    </div>
  );
}
