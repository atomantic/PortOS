import { formatCount, formatTimecode } from '../../utils/formatters';
import { STORYBOARD_VIDEO_LIMITS } from '../../../../server/lib/storyboardVideo.js';

const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * The shots a storyboard gives a new Video draft, exactly as they are written:
 * each panel's prompt and length. The draft runs their total.
 */
export default function StoryboardVideoShots({ plan }) {
  const trimmed = plan.shots.filter((shot) => shot.trimmed).length;
  return (
    <section aria-label="Shots from the storyboard" className="space-y-2">
      <p className="text-sm text-port-text-muted">
        {plural(plan.shots.length, 'shot')}, one per panel, <span className="tabular-nums">{formatTimecode(plan.totalSeconds)}</span> in all.
        {' '}Changing the brief, style or production settings later has the director rewrite them.
      </p>
      {plan.problem && <p role="alert" className="text-sm text-port-error">{plan.problem}</p>}
      {trimmed > 0 && <p className="text-sm text-port-warning">{plural(trimmed, 'panel')} longer than {STORYBOARD_VIDEO_LIMITS.shotMaxSec} s {trimmed === 1 ? 'is' : 'are'} cut to {STORYBOARD_VIDEO_LIMITS.shotMaxSec} s, the longest Video shot.</p>}
      <ol className="space-y-1.5 max-h-80 overflow-auto" aria-label="Shot prompts">
        {plan.shots.map((shot, index) => (
          <li key={shot.sceneId} className="rounded border border-port-border p-2 text-xs text-gray-400">
            <p className="flex items-baseline gap-2 text-sm text-white">
              <span className="min-w-0 flex-1 truncate">{index + 1}. {shot.label}</span>
              <span className="shrink-0 tabular-nums text-gray-400">{shot.durationSeconds} s</span>
            </p>
            <p className="break-words">{shot.prompt}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
