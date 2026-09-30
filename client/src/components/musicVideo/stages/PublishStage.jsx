import PublishKitPanel from '../PublishKitPanel.jsx';
import PublishPostingPanel from '../PublishPostingPanel.jsx';

/**
 * Publish: the release kit made from the final render (encodes, thumbnails,
 * captions, chapters), the per-platform copy (#9281), and posting it through
 * the PortOS Browser with a review before every post (#9282).
 */
export default function PublishStage({ board }) {
  const { project, locked, publishKit, publishing } = board;
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <PublishKitPanel project={project} publishKit={publishKit} />
      {publishing && <PublishPostingPanel project={project} publishing={publishing} />}
    </fieldset>
  );
}
