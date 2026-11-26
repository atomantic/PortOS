import { FormField } from '../ui/FormField';
import { supportsVideoAudioControls, supportsVideoAudioPromptControls } from '../../lib/videoGenParams.js';
import { VIDEO_TILING_OPTIONS } from '../../lib/videoTilingOptions';
import { isLtx2FamilyRuntime } from '../../lib/runnerFamilies';
import {
  I2V_REFERENCE_MODE_OPTIONS, DEFAULT_I2V_REFERENCE_MODE,
  normalizeI2vReferenceMode, runtimeSupportsI2vReferenceMode,
} from '../../lib/videoReferenceModes';

export default function VideoConditioningAudioFields({
  mode, currentModel, fieldId, inputCls,
  imageStrength, onImageStrengthChange,
  i2vReferenceMode = DEFAULT_I2V_REFERENCE_MODE, onI2vReferenceModeChange,
  effectiveImageStrength = null,
  tiling, onTilingChange,
  disableAudio, onDisableAudioChange,
  noMusic, onNoMusicChange,
}) {
  // a2v derives its length + audio track from the uploaded audio, so chunking
  // and the audio flags don't apply there.
  const showAudioFlags = mode !== 'a2v';
  const showDisableAudio = showAudioFlags && supportsVideoAudioControls(currentModel);
  const showPromptAudioControls = showAudioFlags && noMusic != null && supportsVideoAudioPromptControls(currentModel);
  const audioDisabled = showDisableAudio && disableAudio;
  // ltx2 extend conditions on the source's latent rather than a single frame,
  // so image strength is meaningless for it.
  const showImageStrength = ['image', 'ic-ingredients-25'].includes(mode)
    || (mode === 'extend' && !isLtx2FamilyRuntime(currentModel?.runtime));
  // The reference-mode promise (#4874) is an image-mode question only, and only
  // a runtime that carries per-image conditioning strength can keep anything but
  // the default. Rendering it read-only elsewhere would imply a choice that does
  // not exist, so the picker appears in image mode and explains itself when the
  // selected model cannot honor the loose option.
  const showReferenceMode = mode === 'image' && typeof onI2vReferenceModeChange === 'function';
  const referenceMode = normalizeI2vReferenceMode(i2vReferenceMode);
  // Which promises this model can actually keep. An unresolved `currentModel`
  // means "the catalog has not loaded yet", NOT "anchor only" — the same
  // deferral the form's snap-back makes, so the picker can't contradict the
  // state it is rendering: collapsing to Anchor here would disable the control
  // and claim "this model can only anchor" about a model nobody has seen.
  const supportedReferenceOptions = currentModel
    ? I2V_REFERENCE_MODE_OPTIONS.filter((o) => runtimeSupportsI2vReferenceMode(currentModel.runtime, o.value))
    : I2V_REFERENCE_MODE_OPTIONS;
  // A controlled <select> must never hold a value with no matching <option>.
  // A restored pick survives one render past a model switch — until the
  // snap-back effect lands — so keep it listed for exactly that window.
  const referenceOptions = supportedReferenceOptions.some((o) => o.value === referenceMode)
    ? supportedReferenceOptions
    : [...supportedReferenceOptions, I2V_REFERENCE_MODE_OPTIONS.find((o) => o.value === referenceMode)].filter(Boolean);
  const referencePromise = I2V_REFERENCE_MODE_OPTIONS.find((o) => o.value === referenceMode);
  const referenceModeLocked = supportedReferenceOptions.length < 2;
  // `0` is a legal strength (ignore the source entirely) and the retry editor
  // hands it over as a NUMBER, so presence has to be tested explicitly — a
  // `imageStrength || …` fallback renders the slider at 1 while the form still
  // submits 0, which is the control lying about the render it will produce.
  const hasExplicitStrength = imageStrength != null && imageStrength !== '';
  const resolvedImageStrength = hasExplicitStrength ? imageStrength : effectiveImageStrength;

  return (
    <>
      {showReferenceMode && (
        <div className="col-span-2 sm:col-span-3">
          <label htmlFor={fieldId('video-reference-mode')} className="block text-xs font-medium text-gray-400 mb-1">Reference mode</label>
          <select
            id={fieldId('video-reference-mode')}
            value={referenceMode}
            disabled={referenceModeLocked}
            onChange={(e) => onI2vReferenceModeChange(e.target.value)}
            className={inputCls}
          >
            {referenceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="text-[10px] text-gray-500 leading-snug mt-1">{referencePromise?.promise}</p>
          {referenceModeLocked && (
            <p className="text-[10px] text-gray-500 leading-snug mt-1">
              {currentModel?.name || 'This model'} can only anchor a reference. Pick an LTX-2.5 model to loosen it.
            </p>
          )}
        </div>
      )}

      {showImageStrength && (
        <div className="col-span-2 sm:col-span-3">
          <div className="flex items-center justify-between gap-3 mb-1">
            <label htmlFor={fieldId('video-image-strength')} className="block text-xs font-medium text-gray-400">{mode === 'ic-ingredients-25' ? 'Opening Frame Strength' : 'Image Strength'}</label>
            <span className="text-[11px] text-gray-500">{resolvedImageStrength == null ? '1.0' : String(resolvedImageStrength)}</span>
          </div>
          <input
            id={fieldId('video-image-strength')}
            type="range" min={0} max={1} step={0.05}
            value={resolvedImageStrength ?? 1}
            onChange={(e) => onImageStrengthChange(e.target.value)}
            className="w-full accent-port-accent"
            title="Higher values preserve the source frame more strongly"
          />
        </div>
      )}

      {currentModel?.supportsTiling !== false && (
        <FormField className="col-span-2 sm:col-span-3" label="Tiling" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={tiling}
            onChange={(e) => onTilingChange(e.target.value)}
            className={inputCls}
          >
            {VIDEO_TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </FormField>
      )}

      {showDisableAudio && (
        <label htmlFor={fieldId('video-disable-audio')} className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            id={fieldId('video-disable-audio')}
            type="checkbox"
            checked={disableAudio}
            onChange={(e) => onDisableAudioChange(e.target.checked)}
            className="rounded"
          />
          Disable audio (LTX-2 only — speeds up generation)
        </label>
      )}
      {showPromptAudioControls && (
        <label
          htmlFor={fieldId('video-no-music')}
          className={`col-span-2 sm:col-span-3 flex items-center gap-2 text-xs cursor-pointer ${audioDisabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400'}`}
          title="The model conditions generated audio on the prompt — appending 'no music, no soundtrack' at submit time pushes it toward ambient/diegetic sound only"
        >
          <input
            id={fieldId('video-no-music')}
            type="checkbox"
            checked={noMusic}
            disabled={audioDisabled}
            onChange={(e) => onNoMusicChange(e.target.checked)}
            className="rounded"
          />
          No music — keep ambient/diegetic sound only
        </label>
      )}
    </>
  );
}
