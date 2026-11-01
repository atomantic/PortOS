import { Film } from 'lucide-react';
import { planSequenceCoverage, sequenceGroupInput, sequenceModelId } from '../../../../server/lib/musicVideoSequenceCoverage.js';
import { renderMusicVideoSequence } from '../../services/apiMusicVideo.js';
import useAsyncAction from '../../hooks/useAsyncAction.js';
import toast from '../ui/Toast';
import SentPromptPanel from '../media/SentPromptPanel';

const BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';

/**
 * A `coverage: 'sequence'` shot's card (#14241): which run of shots it is
 * generated with in one timed request, the exact prompt sent (with the
 * prompt-expansion value as a labeled addition), and — on the run's first shot —
 * the Render sequence action. Or why this shot stays per-shot.
 * The plan and prompt are the server's own (lib/musicVideoSequenceCoverage.js).
 */
export default function SceneSequenceCoverage({ project, scene }) {
  const scenes = project?.scenes || [];
  const { groups, perShot } = planSequenceCoverage(scenes, { modelId: sequenceModelId(project) });
  const group = groups.find((g) => g.sceneIds.includes(scene.sceneId));
  const [render, rendering] = useAsyncAction(async () => {
    await renderMusicVideoSequence(project.id, group.sceneIds, { silent: true });
    toast.success(`Queued one ${group.durationSec}s request for ${group.sceneIds.length} shots`);
  }, { errorMessage: 'Could not queue the sequence' });

  if (!group) {
    const reason = perShot.find((p) => p.sceneId === scene.sceneId)?.reason;
    return (
      <p className="text-[11px] text-port-text-muted" data-testid="sequence-coverage">
        Sequence coverage: this shot renders on its own{reason ? ` (${reason})` : ''}.
      </p>
    );
  }
  const { prompt, promptAdditions, members } = sequenceGroupInput(project, group);
  const index = group.sceneIds.indexOf(scene.sceneId);
  const labels = members.map((m, i) => m.label || `shot ${i + 1}`);
  const missingFrame = members.find((m) => !m.referenceImageId);
  return (
    <div className="min-w-0 space-y-1 rounded border border-port-border p-2 text-xs" data-testid="sequence-coverage">
      <div className="text-port-text-muted">
        Sequence: shot {index + 1} of {members.length} in one {group.durationSec}s request ({labels.join(', ')})
      </div>
      <p className="whitespace-pre-wrap break-words">{prompt}</p>
      <SentPromptPanel prompt={prompt} sentPrompt={prompt} additions={promptAdditions} />
      {index === 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => render()} disabled={rendering || !!missingFrame} className={BUTTON}>
            <Film size={14} /> {rendering ? 'Queueing…' : 'Render sequence'}
          </button>
          {missingFrame && <span className="text-[11px] text-port-warning">{missingFrame.label || 'A shot'} has no still yet.</span>}
        </div>
      )}
    </div>
  );
}
