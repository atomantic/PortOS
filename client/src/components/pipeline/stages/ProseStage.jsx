import TextStagePanel from './TextStagePanel';

export default function ProseStage(props) {
  return (
    <TextStagePanel
      {...props}
      stageId="prose"
      generateLabel="Draft prose"
      outputPlaceholder="An 800–1500 word short-story draft for this issue. Will be lightly structured with `## Scene N — Slugline` H2 markers so the comic and TV script stages have stable anchors."
    />
  );
}
