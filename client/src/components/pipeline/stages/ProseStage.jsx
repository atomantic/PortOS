import { Library, Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { extractPipelineBibles } from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import TextStagePanel from './TextStagePanel';

export default function ProseStage({ issue, series, onStageUpdate, onSeriesUpdate }) {
  const proseReady = (issue.stages?.prose?.output || '').trim().length > 0;

  const [runExtract, extracting] = useAsyncAction(
    () => extractPipelineBibles(series.id, { issueId: issue.id }),
    { errorMessage: 'Extraction failed' },
  );

  const handleExtract = async () => {
    if (!series) return;
    const result = await runExtract();
    if (!result) return;
    onSeriesUpdate?.(result.series);
    const counts = ['characters', 'settings', 'objects'].map(
      (k) => `${result.series[k]?.length ?? 0} ${k}`,
    ).join(', ');
    toast.success(`Bibles updated — ${counts}`);
  };

  return (
    <TextStagePanel
      issue={issue}
      stageId="prose"
      onStageUpdate={onStageUpdate}
      generateLabel="Draft prose"
      outputPlaceholder="An 800–1500 word short-story draft for this issue. Will be lightly structured with `## Scene N — Slugline` H2 markers so the comic and TV script stages have stable anchors."
      extraActions={(
        <button
          type="button"
          onClick={handleExtract}
          disabled={extracting || !proseReady}
          title={proseReady ? 'Extract characters, settings, and objects from the prose into the series bibles' : 'Generate prose first'}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
        >
          {extracting ? <Loader2 size={14} className="animate-spin" /> : <Library size={14} />}
          Extract bibles
        </button>
      )}
    />
  );
}
