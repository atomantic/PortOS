import { storyboardShotDirection } from '../../../../server/lib/musicVideo/musicVideoShotPrompt.js';
import BlurCommitTextarea from '../ui/BlurCommitTextarea.jsx';
import InfoTooltip from '../ui/InfoTooltip';

/**
 * Editable shot/clip prompt with storyboard-direction sync and beat-review confirmation.
 */
export function ScenePromptField({ scene, layer, fromSheet, fieldId, applyPatch, markDirty, clearDirty, saveIfDirty, onEditLocal, onSave }) {
  // A storyboard-linked shot's prompt is its panel's direction, read live so it stays in
  // sync, until the director types one of their own; typing the panel's words back re-links it.
  const boardDirection = storyboardShotDirection(scene);
  const followsBoard = !!boardDirection && !scene.prompt?.trim();
  const isFootage = layer === 'footage';

  return (
    <div className="space-y-1">
      {scene.beatNeedsReview && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
          <span>Needs its own beat — this prompt was copied from the longer shot.</span>
          <button type="button" onClick={() => applyPatch({ beatNeedsReview: false })} className="min-h-[44px] rounded border border-port-border px-2 pointer-fine:sm:min-h-0">Mark beat ready</button>
        </div>
      )}
      <div className="flex items-center gap-1 text-[11px] text-port-text-muted">
        <label htmlFor={fieldId('prompt')}>{isFootage ? 'Clip prompt' : 'Shot prompt'}</label>
        <InfoTooltip label={isFootage ? 'About the clip prompt' : 'About the shot prompt'} placement="below" align="start" width={280}>
          {isFootage
            ? `What happens during the clip. The video model gets this text with the start frame (and end frame, if used)${fromSheet ? ', followed by the shot details' : ''}. What the frame looks like is its own prompt on the Frames tab.`
            : 'Describes the shot. The frame renders from it only when its own frame prompt is empty.'}
        </InfoTooltip>
      </div>
      <BlurCommitTextarea
        id={fieldId('prompt')}
        value={followsBoard ? boardDirection : scene.prompt || ''} rows={3}
        onCommit={(text) => { markDirty('prompt'); onEditLocal(scene.sceneId, { prompt: text }); }}
        onBlur={(e) => saveIfDirty('prompt', { prompt: boardDirection && e.target.value.trim() === boardDirection ? '' : e.target.value })}
        placeholder={isFootage ? 'What happens in this shot' : 'What this shot shows'}
        className="block w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      />
      {boardDirection && (followsBoard ? (
        <p className="text-[11px] text-port-text-muted" data-testid="prompt-from-storyboard">From the storyboard panel · stays in sync</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted" data-testid="prompt-own">
          <span>This shot's own prompt, not the panel's</span>
          <button type="button" onClick={() => { clearDirty('prompt'); onEditLocal(scene.sceneId, { prompt: '' }); onSave(scene.sceneId, { prompt: '' }); }} className="underline min-h-[44px] pointer-fine:sm:min-h-0">Use storyboard direction</button>
        </div>
      ))}
    </div>
  );
}

/**
 * Intended speaker / singer input for lip-sync performance shots.
 * Music-driven shots follow the whole mix and do not render this input.
 */
export function SceneSpeakerField({ scene, performance, fieldId, onEditLocal, onSave, setSpeakerDirty, setSpeakerSaving }) {
  if (!performance || scene.performanceStyle === 'music') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={fieldId('speaker')}>Speaker / singer</label>
      <input
        id={fieldId('speaker')}
        value={scene.performanceSpeaker || ''}
        maxLength={120}
        onChange={(e) => { setSpeakerDirty(true); onEditLocal(scene.sceneId, { performanceSpeaker: e.target.value }); }}
        onBlur={(e) => {
          setSpeakerSaving(true);
          Promise.resolve(onSave(scene.sceneId, { performanceSpeaker: e.target.value || null }))
            .then((saved) => setSpeakerDirty(saved === false), () => setSpeakerDirty(true))
            .finally(() => setSpeakerSaving(false));
        }}
        className="bg-port-bg border border-port-border rounded px-2 py-1"
        placeholder="Intended singer"
      />
    </div>
  );
}
