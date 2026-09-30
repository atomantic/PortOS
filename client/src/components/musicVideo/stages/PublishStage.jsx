import PublishKitPanel from '../PublishKitPanel.jsx';

/**
 * Publish: the release kit made from the final render (encodes, thumbnails,
 * captions, chapters) and the per-platform copy (#9281).
 */
export default function PublishStage({ board }) {
  const { project, locked, publishKit } = board;
  return (
    <fieldset disabled={locked} className="min-w-0">
      <PublishKitPanel project={project} publishKit={publishKit} />
    </fieldset>
  );
}
