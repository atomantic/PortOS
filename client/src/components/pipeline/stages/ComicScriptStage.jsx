import TextStagePanel from './TextStagePanel';

export default function ComicScriptStage(props) {
  return (
    <TextStagePanel
      {...props}
      stageId="comicScript"
      generateLabel="Adapt to comic script"
      outputPlaceholder="Page → panel → description / caption / dialogue / SFX. Marvel/DC house format. Generated from the prose stage; iterate freely without re-running."
    />
  );
}
