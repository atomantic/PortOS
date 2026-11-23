/**
 * Kind labels and the "N universes, M decks" summary of tombstone-GC prune counts.
 *
 * A leaf module so the orchestrator log and ops CLI skip the GC graph. The client
 * keeps its own copy because it cannot import server code.
 */

const KIND_LABELS = Object.freeze({
  universe: ['universe', 'universes'],
  series: ['series', 'series'],
  issue: ['issue', 'issues'],
  mediaCollection: ['collection', 'collections'],
  author: ['author', 'authors'],
  artist: ['artist', 'artists'],
  album: ['album', 'albums'],
  track: ['track', 'tracks'],
  creativeDirectorProject: ['creative director project', 'creative director projects'],
  musicVideoProject: ['music video', 'music videos'],
  moodBoard: ['mood board', 'mood boards'],
  fableLoom: ['loom', 'looms'],
  writersRoomWork: ['writers room work', 'writers room works'],
  writersRoomFolder: ['writers room folder', 'writers room folders'],
  writersRoomExercise: ['writers room exercise', 'writers room exercises'],
  commissionFeedback: ['commission feedback', 'commission feedback'],
  creativeCommission: ['commission', 'commissions'],
  deck: ['deck', 'decks'],
  storyboard: ['storyboard', 'storyboards'],
});

/** "2 universes, 1 series, 3 decks" from a `prunedByKind` map; '' when all zero. */
export function formatPrunedByKind(prunedByKind) {
  return Object.entries(prunedByKind ?? {})
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => {
      const [singular, plural] = KIND_LABELS[kind] ?? [kind, kind];
      return `${count} ${count === 1 ? singular : plural}`;
    })
    .join(', ');
}
