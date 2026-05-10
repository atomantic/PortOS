import TextStagePanel from './TextStagePanel';

export default function TVScriptStage(props) {
  return (
    <TextStagePanel
      {...props}
      stageId="tvScript"
      generateLabel="Adapt to teleplay"
      outputPlaceholder="Slugline → action → dialogue. Standard TV format with act breaks. Generated from the prose stage; iterates independently of the comic script."
    />
  );
}
