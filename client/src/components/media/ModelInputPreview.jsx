import SentPromptPanel from './SentPromptPanel';
import ModelReferenceImages from './ModelReferenceImages';

/**
 * What Generate will send (#11317): the server's preview, built by the same
 * code as the render, shown under a form's prompt box. The box above keeps only
 * the user's words; a refusal the render would give shows here instead.
 */
export default function ModelInputPreview({ preview, prompt, onOpenPreview, onToggleLikeness, referencesIntro = null, alwaysShowFull = false }) {
  if (preview?.error) return <p role="alert" className="text-xs text-port-warning">{preview.error}</p>;
  const sent = preview?.preview;
  if (!sent) return null;
  return (
    <div className="text-xs space-y-3">
      <ModelReferenceImages images={sent.referenceImages} editBase={sent.editBase} onOpenPreview={onOpenPreview} onToggleLikeness={onToggleLikeness} intro={referencesIntro}
        inputProvenance={sent.remote ? 'peer-requested' : sent.referenceInputProvenance} />
      {!!sent.loraAdapters?.length && (
        <section aria-label="LoRA adapters" className="space-y-1">
          <h3 className="font-semibold text-port-text">LoRA adapters</h3>
          <ul className="space-y-1 text-port-text-muted">
            {sent.loraAdapters.map((adapter, index) => (
              <li key={`${adapter.filename}:${index}`} className="break-words">
                {adapter.filename} · strength {adapter.scale} · {adapter.source}
              </li>
            ))}
          </ul>
        </section>
      )}
      <SentPromptPanel
        prompt={prompt}
        sentPrompt={sent.sentPrompt}
        sentNegativePrompt={sent.sentNegativePrompt}
        additions={sent.promptAdditions || []}
        segmentPrompts={sent.segmentPrompts}
        alwaysShowFull={alwaysShowFull}
        asWrittenText="Sent to the model as written."
      />
    </div>
  );
}
