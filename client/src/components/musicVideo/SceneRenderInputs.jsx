import { falHearsAudioReference, falPromptExpansionAddition, falPromptExpansionMode, getFalVideoModel } from '../../lib/falVideoModels.js';
import { falSceneTake, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';
import { getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { shotActionContractProblem } from '../../../../server/lib/musicVideoActionContract.js';
import { authoredShotPrompt, musicVideoShotModelInput } from '../../../../server/lib/musicVideoShotPrompt.js';
import { localModelTakesSongAudio } from '../../../../server/lib/musicVideoLocalModels.js';
import { formatCount } from '../../utils/formatters.js';
import SentPromptPanel from '../media/SentPromptPanel';

const clock = (sec) => {
  const whole = Math.max(0, sec || 0);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Exactly what the shot card's Render sends: the director's text, then what
 * the card itself adds (its camera move, its applied shot actions, Grok's
 * approximate phrase timing, the audio-reactive guard) as labeled additions,
 * and which inputs go with it. The composer is the server's own
 * (lib/musicVideoShotPrompt.js): Render sends the director's text and the
 * server composes the same prompt (a performance shot's action times shift to
 * its padded song slice). The project's style and bible are not added.
 *
 * `settings` is the renderer this render uses (the project's, or the card's
 * Render on pick merged over it); `inputs` holds the card's toggles,
 * `{ endFrame, songAudio, wholeLine }`, each undefined until the director flips it.
 * `plan` is the performance shot's planned song window (planPerformanceWindow),
 * which names the line a Whole sung line take covers.
 * Returns `{ authored, prompt, promptAdditions, promptUsed, maxChars, endFrame, songAudio, wholeLine, contractProblem }`, where each
 * input is `{ state: 'on' | 'off' | 'required' | 'unavailable', note }` (`wholeLine` is null off a performance shot).
 */
export function shotCardRenderRequest({
  project = null, greybox = null, scene, settings = {}, performance = false, endFramePlan = null, models = [], defaultModel = '', inputs = {}, plan = null,
}) {
  const falModel = settings.backend === 'fal' ? getFalVideoModel(falSceneTake({ scene, videoSettings: settings }).modelId) : null;
  const runwayModel = settings.backend === 'runway' ? getRunwayVideoModel(runwaySceneTake({ scene, videoSettings: settings }).modelId) : null;
  const localModel = settings.backend === 'local'
    ? models.find((model) => model.id === (settings.modelId || defaultModel)) || null : null;
  const span = `${clock(scene?.startSec)}–${clock(scene?.endSec)}`;

  let songAudio;
  if (performance) songAudio = { state: 'required', note: `Song ${span}` };
  else if (localModel && localModelTakesSongAudio(localModel)) {
    const on = inputs.songAudio ?? settings.generationMode === 'suppliedAudio';
    songAudio = { state: on ? 'on' : 'off', note: `Song ${span}` };
  } else songAudio = { state: 'unavailable', note: 'This model hears no audio' };
  // An audio-reactive LoRA render hears the song through its own weights.
  const audioReactive = settings.backend === 'local' && settings.generationMode === 'audioReactive' && !performance;
  if (audioReactive) songAudio = { state: 'required', note: `Song ${span} drives the motion` };

  // A take that hears nothing gets its shot actions without the lyric and beat lines it cannot hear.
  const hears = songAudio.state === 'on' || songAudio.state === 'required';
  // A saved contract can outgrow its scene (a split piece, a retimed shot); the card shows the problem rather than throwing.
  const contract = scene?.direction?.actionContract;
  const contractProblem = contract != null ? shotActionContractProblem(contract, scene) : null;
  const authored = authoredShotPrompt(scene);
  const { prompt, promptAdditions: composedAdditions } = musicVideoShotModelInput(contractProblem ? null : project, scene, {
    greybox, authored, asTyped: true, hears, backend: settings.backend, audioReactive,
    audioReferenceModelId: performance && falHearsAudioReference(falModel) ? falModel.id : null,
  });
  // The server sends music-video fal takes with provider expansion disabled (fal.js).
  const promptAdditions = [...composedAdditions, falPromptExpansionAddition(falPromptExpansionMode(falModel, 'disabled'))].filter(Boolean);

  let endFrame = null;
  if (scene?.endImageId) {
    if (songAudio.state === 'on') endFrame = { state: 'unavailable', note: 'Not with song audio' };
    else if (endFramePlan?.used) endFrame = { state: inputs.endFrame === false ? 'off' : 'on', note: null };
    // The card says why under Render on (its end-frame line), so no note repeats it here.
    else endFrame = { state: 'unavailable', note: null };
  }

  // A performance take can hear the whole lyric line the shot sits in, so the
  // clip can play the full line or be cut down to the shot.
  let wholeLine = null;
  if (performance) {
    const on = inputs.wholeLine === true;
    const note = !on || !plan?.ok || plan.lineStartSec == null ? null
      : plan.lineTooLong ? 'Line too long for one take; renders the shot'
        : `Song ${clock(plan.lineStartSec)}–${clock(plan.lineEndSec)}`;
    wholeLine = { state: on ? 'on' : 'off', note };
  }

  return {
    authored,
    prompt,
    promptAdditions,
    promptUsed: falModel?.prompt !== 'none',
    maxChars: falModel?.promptMaxChars ?? runwayModel?.promptMaxChars ?? null,
    endFrame,
    songAudio,
    wholeLine,
    contractProblem,
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
  const { authored, prompt, promptAdditions, promptUsed, maxChars, endFrame, songAudio, wholeLine } = request;
  const over = maxChars != null && prompt.length > maxChars;
  return (
    <div className="min-w-0 space-y-1 rounded border border-port-border p-2 text-xs" data-testid="render-inputs">
      <div className="text-port-text-muted">Sent to the model</div>
      {!promptUsed
        ? <p className="text-port-text-muted">No prompt: this model takes the still and the song only.</p>
        : prompt
          ? (
            <>
              <p className="whitespace-pre-wrap break-words">{authored || prompt}</p>
              {promptAdditions.length > 0 && <SentPromptPanel prompt={authored} sentPrompt={prompt} additions={promptAdditions} />}
            </>
          )
          : <p className="text-port-text-muted">No prompt</p>}
      {promptUsed && maxChars != null && (
        <p className={over ? 'text-port-warning' : 'text-port-text-muted'}>
          {formatCount(prompt.length)} of {formatCount(maxChars)} characters{over ? ' · shorten the prompt to render' : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <InputToggle id={`${id}-still`} label="Still" input={{ state: 'required', note: null }} />
        {endFrame && <InputToggle id={`${id}-end`} label="End frame" input={endFrame} onChange={(on) => onChange({ endFrame: on })} />}
        <InputToggle id={`${id}-audio`} label="Song audio" input={songAudio} onChange={(on) => onChange({ songAudio: on })} />
        {wholeLine && <InputToggle id={`${id}-line`} label="Whole sung line" input={wholeLine} onChange={(on) => onChange({ wholeLine: on })} />}
      </div>
    </div>
  );
}

/** Why the card's Render cannot send this request, or null. */
export const shotCardRequestProblem = (request) => request.contractProblem || (request.promptUsed && request.maxChars != null && request.prompt.length > request.maxChars
  ? `The prompt is ${formatCount(request.prompt.length)} characters; this model takes ${formatCount(request.maxChars)}` : null);
