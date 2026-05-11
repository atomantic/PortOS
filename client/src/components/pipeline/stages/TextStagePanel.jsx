/**
 * Shared editor for the four text stages (idea, prose, comicScript, tvScript).
 * Each per-stage component wraps this with stage-specific labels + placeholders
 * — the underlying mechanic is identical: textarea for the user's edits +
 * generate button that calls the server's text-stage runner.
 */

import { useEffect, useState } from 'react';
import { Loader2, Sparkles, Save } from 'lucide-react';
import toast from '../../ui/Toast';
import { generatePipelineStage, updatePipelineIssue, PIPELINE_STAGE_LABELS } from '../../../services/api';

const STATUS_LABEL = {
  empty: 'Not started',
  generating: 'Generating…',
  ready: 'Ready',
  edited: 'Edited',
  'needs-review': 'Needs review',
  error: 'Error',
};

const STATUS_COLOR = {
  empty: 'text-gray-500',
  generating: 'text-port-accent',
  ready: 'text-port-success',
  edited: 'text-port-warning',
  'needs-review': 'text-port-warning',
  error: 'text-port-error',
};

export default function TextStagePanel({
  issue,
  stageId,
  onStageUpdate,
  seedPlaceholder,
  outputPlaceholder,
  generateLabel = 'Generate',
  extraActions = null,
}) {
  const stage = issue.stages?.[stageId] || { status: 'empty', input: '', output: '' };
  const [draftOutput, setDraftOutput] = useState(stage.output || '');
  const [draftInput, setDraftInput] = useState(stage.input || '');
  const [generating, setGenerating] = useState(stage.status === 'generating');
  const [saving, setSaving] = useState(false);

  // Reset local edits when the stage record changes from the parent (e.g.
  // auto-run pushed a new output).
  useEffect(() => {
    setDraftOutput(stage.output || '');
    setDraftInput(stage.input || '');
    setGenerating(stage.status === 'generating');
  }, [stage.output, stage.input, stage.status, stage.lastRunId]);

  const handleGenerate = async () => {
    setGenerating(true);
    const result = await generatePipelineStage(issue.id, stageId, { seedInput: draftInput }).catch((err) => {
      toast.error(err.message || `Failed to generate ${stageId}`);
      return null;
    });
    setGenerating(false);
    if (!result) return;
    onStageUpdate?.(stageId, result.stage);
    toast.success(`${PIPELINE_STAGE_LABELS[stageId]} generated`);
  };

  const dirty = draftOutput !== (stage.output || '') || draftInput !== (stage.input || '');

  const handleSave = async () => {
    setSaving(true);
    const patch = {
      stages: {
        [stageId]: {
          status: 'edited',
          input: draftInput,
          output: draftOutput,
        },
      },
    };
    const updated = await updatePipelineIssue(issue.id, patch).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
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
            disabled={generating}
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
    </div>
  );
}
