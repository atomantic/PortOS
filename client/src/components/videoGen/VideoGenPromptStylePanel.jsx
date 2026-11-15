import { FormField } from '../ui/FormField';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import StylePresetPicker from '../media/StylePresetPicker';
import UniverseStylePicker from '../media/UniverseStylePicker';
import PromptEnhancer from '../media/PromptEnhancer';

/**
 * Prompt styling for a VideoGen render: universe and style-preset pickers, the
 * negative prompt (only where the lane submits one), and the AI enhancer, which
 * writes inside `enhancePromptBudget` so a style prefix can't push it over the
 * backend cap. `promptFields` is the form's prompt group.
 */
export default function VideoGenPromptStylePanel({ promptFields, negativePromptSupported, enhancePromptBudget, mode, modelId }) {
  const {
    prompt, setPrompt, negativePrompt, setNegativePrompt,
    stylePreset, setStylePreset, selectedUniverse, setSelectedUniverse,
  } = promptFields;
  return (
    <>
      <div className="grid min-w-0 grid-cols-1 gap-3 @5xl/video-form:grid-cols-2">
        <UniverseStylePicker
          value={selectedUniverse?.id || ''}
          onChange={setSelectedUniverse}
        />
        <StylePresetPicker
          value={stylePreset?.id || ''}
          onChange={setStylePreset}
        />
      </div>
      {negativePromptSupported && (
        <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <AutoSizeTextarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={3}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
            placeholder="What to avoid..."
          />
        </FormField>
      )}

      {/* Keep Enhance live while a render is in flight so the next clip
          can be composed and submitted to its server queue. Generate
          itself becomes Cancel. */}
      <PromptEnhancer
        kind="video"
        prompt={prompt}
        setPrompt={setPrompt}
        negativePrompt={negativePromptSupported ? negativePrompt : ''}
        setNegativePrompt={negativePromptSupported ? setNegativePrompt : undefined}
        renderConfig={{ stylePreset: stylePreset?.id, mode, model: modelId }}
        maxPromptLength={enhancePromptBudget}
      />
    </>
  );
}
