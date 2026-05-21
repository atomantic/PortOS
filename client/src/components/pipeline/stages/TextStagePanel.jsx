/**
 * Shared editor for the four text stages (idea, prose, comicScript, teleplay).
 * Each per-stage component wraps this with stage-specific labels + placeholders
 * — the underlying mechanic is identical: textarea for the user's edits +
 * generate button that calls the server's text-stage runner.
 */

import { useEffect, useState } from 'react';
import { Loader2, Sparkles, Save, History } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineStage, updatePipelineIssue,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import StageHistoryModal from './StageHistoryModal';

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
    }),
    { errorMessage: `Failed to generate ${stageId}` },
  );
  const generating = localGenerating || serverGenerating;

  const handleGenerate = async () => {
    const result = await runGenerate();
    if (!result) return;
    onStageUpdate?.(stageId, result.stage);
    toast.success(`${PIPELINE_STAGE_LABELS[stageId]} generated`);
  };

  const dirty = draftOutput !== (stage.output || '') || draftInput !== (stage.input || '');

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
          {extraActions}
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
            disabled={generating || actionsGated}
            title={actionsGated ? 'Saving settings…' : undefined}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generateLabel}
          </button>
        </div>
      </div>

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
        <textarea
          value={draftOutput}
          onChange={(e) => setDraftOutput(e.target.value)}
          placeholder={outputPlaceholder}
          rows={24}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono leading-relaxed"
        />
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
