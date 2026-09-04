/**
 * Log a practice run for a repertoire song (#4102).
 *
 * The user grades the run 0..5 and the SERVER decides what that means — it owns
 * the SM-2 advance and the resulting `stage`/`practice`, because the advance is
 * computed from the stored schedule. So this component sends one number and
 * hands the whole updated record back to its parent, which merges it into local
 * state (no refetch).
 *
 * Each grade button spells out what it will do, so "Solid" advancing the stage
 * is never a surprise — the stage select stays available for a manual override.
 */

import { CheckCircle2, GraduationCap } from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { timeAgo, timeUntil } from '../../utils/formatters';
import { practiceSong } from '../../services/api';
import toast from '../ui/Toast';
import {
  SONG_PRACTICE_RATINGS, isSongDue, songNextReviewAt, songPracticeSessions,
} from './constants';

export default function PracticeLogger({ song, onLogged, className = '' }) {
  // `useAsyncAction` owns the error toast, so the request itself stays silent —
  // one error layer only (client/src/AGENTS.md).
  const [logPractice, logging] = useAsyncAction(async (quality) => {
    const updated = await practiceSong(song.id, quality, { silent: true });
    onLogged?.(updated);
    const when = timeUntil(updated?.practice?.nextReview, 'today');
    toast.success(`Practice logged — ${updated?.stage}, next review ${when}`);
    return updated;
  }, { errorMessage: 'Failed to log practice' });

  const due = isSongDue(song);
  const sessions = songPracticeSessions(song);
  const lastPracticed = song?.practice?.lastReviewed;

  return (
    <div className={`bg-port-card border border-port-border rounded-lg p-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <GraduationCap size={15} className="text-gray-500" aria-hidden="true" />
          Practice
        </h2>
        {due ? (
          <span className="px-2 py-0.5 rounded-full text-[11px] bg-port-warning/20 text-port-warning border border-port-warning/30">
            Due now
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <CheckCircle2 size={12} aria-hidden="true" />
            Next review {timeUntil(songNextReviewAt(song), 'today')}
          </span>
        )}
        <span className="text-xs text-gray-500">
          {sessions === 0
            ? 'Never practiced'
            : `${sessions} session${sessions === 1 ? '' : 's'} · last ${timeAgo(lastPracticed)}`}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Log a practice run">
        {SONG_PRACTICE_RATINGS.map((rating) => (
          <button
            key={rating.quality}
            type="button"
            onClick={() => logPractice(rating.quality)}
            disabled={logging}
            aria-label={rating.label}
            className="min-h-[48px] px-2.5 py-2 text-left sm:text-center rounded-lg border border-port-border text-gray-300 hover:text-white hover:border-port-accent/50 hover:bg-port-border/50 disabled:opacity-50 flex flex-col justify-center"
          >
            <span className="text-xs sm:text-sm font-semibold text-white">{rating.label}</span>
            <span className="text-[10px] text-gray-400 font-normal leading-tight mt-0.5">{rating.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
