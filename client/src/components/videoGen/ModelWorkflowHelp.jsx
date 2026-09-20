// Advice uses runtime capabilities and declared Finish edges, never a guessed
// cross-model seed relationship. Changing size does not start a generation.
export default function ModelWorkflowHelp({ model, models = [], onResolutionChange }) {
  if (!model) return null;
  const fastH3 = model.runtime === 'fastvideo' && model.fastvideoFamily === 'fasth3';
  const fastMetal = model.runtime === 'fastvideo' && !fastH3;
  const finish = models.find((entry) => entry.id === model.finishModelId);

  return (
    <details className="mt-2 rounded-lg border border-port-border px-3 py-2 text-xs text-gray-400">
      <summary className="cursor-pointer text-gray-300">Choosing a model: preview → final</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          Start with a small resolution and the shortest available duration to check composition and motion.
          Smaller renders reduce generation work, but model loading and first-use conversion still take time.
          Keep a distilled model’s trained step count; fewer steps can spoil the result.
        </p>
        {fastH3 ? (
          <>
            <p>
              {model.fastvideoVsa
                ? 'FastH3 V2 is an eight-step quality option with video and audio, not a real-time preview model.'
                : 'FastH3 Preview uses four steps for video and audio; it still loads a large model.'}
              {' '}Use the 832×480 preset and shortest duration for an initial quality check.
              For a cheaper wiring test, try 512×288; this smaller canvas is experimental and may reduce quality.
              INT6 uses smaller transformer weights than INT8; it is not a guaranteed speed increase.
            </p>
            <button type="button" onClick={() => onResolutionChange(512, 288)} className="text-port-accent underline">
              Use 512×288 test size
            </button>
          </>
        ) : fastMetal ? (
          <p>FastMetal is a draft option: 1.3B is the smallest model, while 5B offers a larger three-step model. Try a small preview resolution before a larger render.</p>
        ) : (
          <p>Where offered, use the Fast speed profile or a Lightning model for drafts. Choose Quality for the final render. Original MiniMax H3 is a slow quality reference; smaller quantization mainly reduces weight size.</p>
        )}
        {finish && (
          <p>This model has a declared delivery pair: <strong className="text-gray-300">{finish.name}</strong>. Eligible text-to-video gallery clips offer Finish to re-render with that model.</p>
        )}
        <p>
          To enlarge a clip you like, use its gallery Upscale action: resize preserves the content;
          the LTX-2.5 generative option can add detail and change it, and requires its model pack.
          Switching from FastMetal or FastH3 Preview to FastH3 V2 generates a new shot — the same prompt
          and seed do not preserve the original composition across models. Use Finish only where offered.
        </p>
      </div>
    </details>
  );
}
