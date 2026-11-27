import CoverArtPanel from './CoverArtPanel.jsx';
import YoutubeThumbnailPanel from './YoutubeThumbnailPanel.jsx';
import PublishAssetsCard from './PublishAssetsCard.jsx';
import PublishCopyCard from './PublishCopyCard.jsx';

export { PUBLISH_FIELDS } from './PublishCopyCard.jsx';

/**
 * Publishing kit (#9281): build the release assets from the final render
 * (platform encodes, thumbnails, SRT captions, YouTube chapters), draft every
 * platform's copy in one provider call from the director's own making-of
 * notes, then edit and copy each field out.
 */
export default function PublishKitPanel({ project, publishKit, enabledTargets }) {
  return (
    <div className="space-y-3">
      <PublishAssetsCard key={`assets-${project?.id}`} project={project} publishKit={publishKit} />
      <YoutubeThumbnailPanel key={`yt-${project?.id}`} project={project} publishKit={publishKit} />
      <CoverArtPanel key={project?.id} project={project} publishKit={publishKit} />
      <PublishCopyCard key={`copy-${project?.id}`} project={project} publishKit={publishKit} enabledTargets={enabledTargets} />
    </div>
  );
}
