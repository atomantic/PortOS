import SentPromptPanel from './SentPromptPanel';
import ModelReferenceImages from './ModelReferenceImages';

/**
 * What Generate will send (#11317): the server's preview, built by the same
 * code as the render, shown under a form's prompt box. The box above keeps only
 * the user's words; a refusal the render would give shows here instead.
 */
export default function ModelInputPreview({ preview, prompt }) {
  if (preview?.error) return <p role="alert" className="text-xs text-port-warning">{preview.error}</p>;
  const sent = preview?.preview;
  if (!sent) return null;
  return (
    <div className="text-xs space-y-3">
      <ModelReferenceImages images={sent.referenceImages} />
      <SentPromptPanel
        prompt={prompt}
        sentPrompt={sent.sentPrompt}
        sentNegativePrompt={sent.sentNegativePrompt}
        additions={sent.promptAdditions || []}
        asWrittenText="Sent to the model as written."
      />
    </div>
  );
}
