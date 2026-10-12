import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { falSceneTake } from '../../lib/musicVideoShotTiming.js';
import { shotCameraPrompt } from '../../../../server/lib/cameraMovements.js';
import { localModelTakesSongAudio } from '../../../../server/lib/musicVideoLocalModels.js';
import { formatCount } from '../../utils/formatters.js';

const clock = (sec) => {
  const whole = Math.max(0, sec || 0);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Exactly what the shot card's Render sends: the prompt as typed (plus the
 * camera move the card sets), and which inputs go with it. Nothing the card
 * does not show is added: the server receives `promptAsTyped` and leaves the
 * prompt alone.
 *
 * `settings` is the renderer this render uses (the project's, or the card's
 * Render on pick merged over it); `inputs` holds the card's toggles,
 * `{ endFrame, songAudio }`, each undefined until the director flips it.
 * Returns `{ prompt, promptUsed, maxChars, endFrame, songAudio }`, where each
 * input is `{ state: 'on' | 'off' | 'required' | 'unavailable', note }`.
 */
export function shotCardRenderRequest({
  scene, settings = {}, performance = false, endFramePlan = null, models = [], defaultModel = '', inputs = {},
}) {
  const prompt = [(scene?.prompt?.trim() || scene?.framePrompt?.trim() || ''), shotCameraPrompt(scene?.camera)].filter(Boolean).join('\n');
  const falModel = settings.backend === 'fal' ? getFalVideoModel(falSceneTake({ scene, videoSettings: settings }).modelId) : null;
  const localModel = settings.backend === 'local'
    ? models.find((model) => model.id === (settings.modelId || defaultModel)) || null : null;
  const span = `${clock(scene?.startSec)}–${clock(scene?.endSec)}`;

  let songAudio;
  if (performance) songAudio = { state: 'required', note: `Song ${span}` };
  else if (localModel && localModelTakesSongAudio(localModel)) {
    const on = inputs.songAudio ?? settings.generationMode === 'suppliedAudio';
    songAudio = { state: on ? 'on' : 'off', note: `Song ${span}` };
  } else songAudio = { state: 'unavailable', note: 'This model hears no audio' };

  let endFrame = null;
  if (scene?.endImageId) {
    if (songAudio.state === 'on') endFrame = { state: 'unavailable', note: 'Not with song audio' };
    else if (endFramePlan?.used) endFrame = { state: inputs.endFrame === false ? 'off' : 'on', note: null };
    // The card says why under Render on (its end-frame line), so no note repeats it here.
    else endFrame = { state: 'unavailable', note: null };
  }

  return {
    prompt,
    promptUsed: falModel?.prompt !== 'none',
    maxChars: falModel?.promptMaxChars ?? null,
    endFrame,
    songAudio,
  };
}

function InputToggle({ id, label, input, onChange }) {
  const fixed = input.state === 'required' || input.state === 'unavailable';
  return (
    <span className={`flex items-center gap-1 ${input.state === 'unavailable' ? 'text-port-text-muted' : ''}`}>
      <input id={id} type="checkbox" checked={input.state === 'on' || input.state === 'required'} disabled={fixed}
        onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      <label htmlFor={id}>{label}</label>
      {input.note && <span className="text-port-text-muted">· {input.note}</span>}
    </span>
  );
}

/** The card's "Sent to the model" block: the exact prompt and the inputs going with it. */
export default function SceneRenderInputs({ id, request, onChange }) {
  const { prompt, promptUsed, maxChars, endFrame, songAudio } = request;
  const over = maxChars != null && prompt.length > maxChars;
  return (
    <div className="min-w-0 space-y-1 rounded border border-port-border p-2 text-xs" data-testid="render-inputs">
      <div className="text-port-text-muted">Sent to the model</div>
      {promptUsed
        ? <p className="whitespace-pre-wrap break-words">{prompt || <span className="text-port-text-muted">No prompt</span>}</p>
        : <p className="text-port-text-muted">No prompt: this model takes the still and the song only.</p>}
      {promptUsed && maxChars != null && (
        <p className={over ? 'text-port-warning' : 'text-port-text-muted'}>
          {formatCount(prompt.length)} of {formatCount(maxChars)} characters{over ? ' · shorten the prompt to render' : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <InputToggle id={`${id}-still`} label="Still" input={{ state: 'required', note: null }} />
        {endFrame && <InputToggle id={`${id}-end`} label="End frame" input={endFrame} onChange={(on) => onChange({ endFrame: on })} />}
        <InputToggle id={`${id}-audio`} label="Song audio" input={songAudio} onChange={(on) => onChange({ songAudio: on })} />
      </div>
    </div>
  );
}

/** Why the card's Render cannot send this request, or null. */
export const shotCardRequestProblem = (request) => (request.promptUsed && request.maxChars != null && request.prompt.length > request.maxChars
  ? `The prompt is ${formatCount(request.prompt.length)} characters; this model takes ${formatCount(request.maxChars)}` : null);
