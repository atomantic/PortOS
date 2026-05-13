import TextStagePanel from './TextStagePanel';

export default function IdeaStage(props) {
  return (
    <TextStagePanel
      {...props}
      stageId="idea"
      generateLabel="Generate beat sheet"
      seedPlaceholder="A rough idea for this issue — a single sentence is fine. The LLM expands it into a beat sheet."
      outputPlaceholder="The generated beat sheet will appear here. You can edit it freely; downstream stages use this content verbatim as upstream context."
    />
  );
}
