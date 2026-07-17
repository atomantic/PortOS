import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Film } from 'lucide-react';
import MediaImage from '../MediaImage.jsx';
import ScenePreview from './ScenePreview.jsx';
import { selectProjectPreview, previewAspectClass } from '../../lib/creativeDirectorPreview.js';

/**
 * Compact media preview for a Creative Director list card (#2702) — shows what
 * the director actually produced instead of another line of metadata.
 *
 * Grid-weight contract: the card NEVER fetches an mp4 on its own. A video
 * preview renders as its poster <img> only; the mp4 is fetched exclusively when
 * the user hits the play affordance, which swaps in <ScenePreview> (the shared
 * player — missing-media fallback, Retry, cache-bust, open-in-new-tab all live
 * there, so this component hand-rolls nothing).
 *
 * Click targets are deliberately split. The poster sits INSIDE the card's
 * <Link>, so clicking the artwork navigates to the project like the rest of the
 * card. The play button is a SIBLING of that link, not a descendant: nesting a
 * <button> inside an <a> is invalid HTML and would make "play" ambiguous with
 * "navigate". It's a small centered badge, so the bulk of the poster still
 * navigates.
 */
export default function ProjectPreview({ project, to }) {
  const [playing, setPlaying] = useState(false);
  const [posterMissing, setPosterMissing] = useState(false);
  const preview = selectProjectPreview(project);
  const aspectClass = previewAspectClass(project?.aspectRatio);

  if (playing) {
    return (
      <ScenePreview
        jobId={preview.jobId}
        label={`${project?.name || 'Project'} — ${preview.label}`}
        aspectClass={aspectClass}
        autoPlay
      />
    );
  }

  return (
    <div className={`relative ${aspectClass} rounded overflow-hidden bg-port-bg border border-port-border`}>
      <Link to={to} className="block w-full h-full" aria-label={`Open ${project?.name || 'project'}`}>
        {preview.kind === 'image' && (
          <MediaImage
            src={preview.src}
            alt={`${preview.label} — ${project?.name || 'project'}`}
            className="w-full h-full object-cover"
          />
        )}
        {preview.kind === 'video' && !posterMissing && (
          <img
            src={preview.poster}
            alt={`${preview.label} — ${project?.name || 'project'}`}
            loading="lazy"
            // A stitched final has no generated thumbnail today (#2702 leaves
            // that out of scope), so a 404 here is expected, not exceptional —
            // degrade to the placeholder rather than a broken-image icon. The
            // play affordance stays either way: the mp4 can be fine even when
            // its poster isn't.
            onError={() => setPosterMissing(true)}
            className="w-full h-full object-cover"
          />
        )}
        {(preview.kind === 'none' || (preview.kind === 'video' && posterMissing)) && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-port-text-muted text-xs">
            <Film className="w-4 h-4 opacity-50" aria-hidden="true" />
            <span>{preview.kind === 'none' ? 'no render yet' : preview.label}</span>
          </div>
        )}
      </Link>
      {preview.kind === 'video' && (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play ${preview.label}`}
          title={`Play ${preview.label}`}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-port-accent"
        >
          <Play className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      {preview.kind !== 'none' && (
        <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] pointer-events-none">
          {preview.label}
        </span>
      )}
    </div>
  );
}
