import { FormField } from '../ui/FormField';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import ModelInputPreview from '../media/ModelInputPreview';
import { formatCount } from '../../utils/formatters';

/**
 * The VideoGen prompt box with its submitted-length counter, the backend cap
 * warning, and the exact model-input preview. `promptFields` is the form's
 * prompt group; `gates` is `useVideoGenSubmitGates()`.
 */
export default function VideoGenPromptField({ promptFields, gates, modelInputPreview }) {
  const { prompt, setPrompt } = promptFields;
  const { promptCap, promptCapLabel, submittedPromptLength, promptOverLimit, showNegativePromptHint } = gates;
  return (
    <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
      <AutoSizeTextarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
        placeholder="Describe the video you want to generate..."
      />
      {/* The count is the SUBMITTED length, so a style preset that
          pushes a short-looking prompt past reactor's cap is visible
          here instead of surfacing as a 400 after Generate. */}
      <p className={`mt-1 text-[11px] leading-snug ${promptOverLimit ? 'text-port-error' : 'text-gray-500'}`}>
        {promptCap != null
          ? `${formatCount(submittedPromptLength)} / ${formatCount(promptCap)} characters`
          : `${formatCount(submittedPromptLength)} characters`}
      </p>
      {/* Only crossing the cap is worth announcing; the count itself
          changes on every keystroke and would be pure noise. */}
      {promptOverLimit && (
        <p className="mt-1 text-[11px] text-port-error leading-snug" role="status">
          {promptCapLabel} will reject this — shorten the prompt. Style presets count toward the limit.
        </p>
      )}
      <div className="mt-2">
        <ModelInputPreview preview={modelInputPreview} prompt={prompt} />
      </div>
      {/* negativePromptSupported is already true for Grok and Runway, so this only fires on local lanes. */}
      {showNegativePromptHint && (
        <p className="mt-1 text-[11px] text-gray-500 leading-snug">
          This model does not use a negative prompt.
        </p>
      )}
    </FormField>
  );
}
