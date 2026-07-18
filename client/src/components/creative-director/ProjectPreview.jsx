import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Play, Film, Music } from 'lucide-react';
import MediaImage from '../MediaImage.jsx';
import ScenePreview from './ScenePreview.jsx';
import { selectProjectPreview, previewAspectClass } from '../../lib/creativeDirectorPreview.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';

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
  const preview = selectProjectPreview(project);
  const aspectClass = previewAspectClass(project?.aspectRatio);

  // The card keeps its identity across list updates (the grid keys on project
  // id, and start/pause patch a project in place), so this instance outlives a
  // change of preview target — e.g. a scene render lands, or the stitch
  // promotes a finalVideoId. Drop back to the poster when the target moves, or
  // a card left playing would keep showing the previous render. (MediaImage and
  // ScenePreview each own the reset of their own load state.)
  useEffect(() => {
    setPlaying(false);
  }, [preview.jobId, preview.src]);

  // A video id is not necessarily its filename stem (a stitched final cut is
  // `timeline-*.mp4` behind a UUID), so resolve the real file before playing.
  // `enabled` keeps the grid light: this fires only once the user presses play,
  // never for the N cards sitting idle on the page.
  const { src: resolvedSrc, resolving, retry: retryResolve } = useVideoFileSrc(preview.jobId, {
    enabled: playing && preview.kind === 'video',
  });

  if (playing) {
    // Autoplay races the lookup, so hold the frame until it settles — mounting
    // early would autoplay the unresolved guess and flash "media missing".
    if (resolving) {
      return (
        <div className={`${aspectClass} rounded overflow-hidden bg-port-bg border border-port-border flex items-center justify-center text-port-text-muted text-xs`}>
          loading…
        </div>
      );
    }
    return (
      <ScenePreview
        jobId={preview.jobId}
        src={resolvedSrc}
        onRetry={retryResolve}
        label={`${project?.name || 'Project'} — ${preview.label}`}
        aspectClass={aspectClass}
        autoPlay
      />
    );
  }

  // A `music` commission's output is an audio track, not a frame — render a
  // native <audio controls> so the run is playable/rateable in place (#2772).
  // The player is interactive, so it sits OUTSIDE the navigation <Link> (same
  // "no interactive control inside an <a>" rule as the video play button); the
  // icon + label above it carry the click-to-open target instead.
  if (preview.kind === 'audio') {
    const durationSuffix = preview.durationSec ? ` · ${Math.round(preview.durationSec)}s` : '';
    return (
      <div className={`relative ${aspectClass} rounded overflow-hidden bg-port-bg border border-port-border flex flex-col items-center justify-center gap-2 p-3`}>
        <Link
          to={to}
          className="flex flex-col items-center gap-1 text-port-text-muted hover:text-white focus:outline-none focus:ring-2 focus:ring-port-accent rounded"
          aria-label={`Open ${project?.name || 'project'}`}
        >
          <Music className="w-6 h-6 text-port-accent" aria-hidden="true" />
          <span className="text-[10px]">{preview.label}{durationSuffix}</span>
        </Link>
        <audio
          controls
          preload="none"
          src={preview.src}
          aria-label={`${project?.name || 'Project'} — ${preview.label}`}
          className="w-full max-w-[95%]"
        />
      </div>
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
        {preview.kind === 'video' && (
          // Every render path writes a `<jobId>.jpg` thumbnail (clips via
          // videoGen, stitched finals via the timeline renderer), so a failure
          // here means the poster isn't loadable right now — a pruned history
          // entry, or a federated project whose bytes haven't been pulled yet.
          // MediaImage is the right tool for exactly that: it degrades to a
          // placeholder instead of a broken-image icon AND auto-recovers on
          // `peerSync:asset-arrived`, which a bare <img onError> can't do (it
          // would strand the card on the placeholder until a remount). The play
          // affordance stays regardless — the mp4 can be fine when its poster
          // isn't.
          <MediaImage
            src={preview.poster}
            alt={`${preview.label} — ${project?.name || 'project'}`}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        )}
        {preview.kind === 'none' && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-port-text-muted text-xs">
            <Film className="w-4 h-4 opacity-50" aria-hidden="true" />
            <span>no render yet</span>
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
