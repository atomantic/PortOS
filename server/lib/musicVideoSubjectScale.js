/**
 * A shot's real-world scale cue: how tall each person in it is and how big its
 * sets and props are. Sheets and plates composited into one frame carry no size
 * of their own, so without it a model sizes a person against a fence or a sign
 * by guesswork (one figure towering over both a 4 ft fence and a 7 ft sign).
 *
 * `sizes` is `{ [subjectId]: text }` from the catalog (loadMusicVideoSubjectSizes);
 * this module only picks the shot's subjects and words the line.
 */
import { activeMusicVideoSubjects } from './musicVideoCastSelection.js';

const SCALE_LEAD = 'Real-world sizes: keep every person, object and set feature in the frame at these true sizes against each other';

const subjectLine = (subject, size) => (subject.kind === 'character'
  ? `${subject.name}${subject.castForm?.age != null ? ` (age ${subject.castForm.age})` : ''}: ${size} tall`
  : `${subject.name}: ${size}`);

/** The scale line for a shot's subjects, '' when none has a known size. */
export function musicVideoSubjectScaleText(concept, sizes) {
  if (!sizes || typeof sizes !== 'object') return '';
  // Like the production bible: every active subject (the caller passes a
  // storyboard-filtered concept when the shot has a panel).
  const lines = activeMusicVideoSubjects(concept)
    .map((subject) => {
      const size = typeof sizes[subject.id] === 'string' ? sizes[subject.id].trim() : '';
      return size && subject.name?.trim() ? subjectLine(subject, size) : '';
    })
    .filter(Boolean);
  return lines.length ? `${SCALE_LEAD}: ${lines.join('; ')}.` : '';
}
