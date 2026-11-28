// Shared limits and rating vocabulary for media annotations.


export const NOTE_MAX_LENGTH = 2000;

// Good = keep it for its use; bad = a garbage file worth deleting. Absent =
// unrated. "Rejected" (wrong for one shot) belongs to music video takes only.
export const MEDIA_RATINGS = Object.freeze(['good', 'bad']);
