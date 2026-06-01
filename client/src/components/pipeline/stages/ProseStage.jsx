import TextStagePanel from './TextStagePanel';

// Bibles extraction lives on the Nouns stage now — kept the prose panel a
// thin pass-through so the workflow is Idea → Prose → Nouns → Comic.
export default function ProseStage(props) {
  return (
    <TextStagePanel
      {...props}
      stageId="prose"
      generateLabel="Draft prose"
      proseEditor
      outputPlaceholder="An 800–1500 word short-story draft for this issue. Will be lightly structured with `## Scene N — Slugline` H2 markers so the comic and teleplay stages have stable anchors."
    />
  );
}
