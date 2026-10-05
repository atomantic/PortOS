import PublishKitPanel from '../PublishKitPanel.jsx';
import PublishPostingPanel from '../PublishPostingPanel.jsx';
import PublishPlatformsPanel from '../PublishPlatformsPanel.jsx';

/**
 * Publish: the release kit made from the final render (encodes, thumbnails,
 * captions, chapters), the per-platform copy (#9281), and posting it through
 * the PortOS Browser with a review before every post (#9282), only to the
 * platforms the director turned on (#9287).
 */
export default function PublishStage({ board }) {
  const { project, locked, publishKit, publishing } = board;
  return (
    <fieldset id="mv-publish-kit" disabled={locked} className="min-w-0 space-y-3">
      {publishing && <PublishPlatformsPanel publishing={publishing} />}
      <PublishKitPanel project={project} publishKit={publishKit} enabledTargets={publishing?.enabledTargets} />
      {publishing && <PublishPostingPanel project={project} publishing={publishing} />}
    </fieldset>
  );
}
