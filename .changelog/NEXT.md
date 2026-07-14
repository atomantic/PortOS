# Unreleased

## Fixed

- **[issue-2510] MidiPianoRoll: clear the stale hover overlay when the transcription data changes.** The piano-roll kept its hovered note/chord identity (objects from the previous parse) when the `data`/`chords` props swapped on a mounted instance, so a re-transcription or Retry while a hover was active and the pointer sat still would keep stroking the old note at coordinates mapped into the new file until the next pointer move or Escape. A `useEffect` now drops the hover identity whenever `data`/`chords` change.
