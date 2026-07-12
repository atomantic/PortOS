# Unreleased Changes

## MIDI transcription

- **[issue-2477] Visualize transcribed MIDI with an interactive piano-roll.** Rounds references and Music Video projects with a MuScriptor transcription now show a DAW-style time × pitch roll right below the audio controls — note bars with musical note names, a chord lane labeling simultaneous notes (Cmaj7, Am, slash inversions), hover/tap tooltips, zoom + pan + fit-to-width, click-to-scrub playhead, and a QA footer (note count, density, pitch range, duration, tempo, per-track legend). Collapsible and mobile-friendly; no external DAW needed to judge transcription quality.

## Changed

- **Elements Song study mode drops a redundant result field.** The Flash Cards study results tracked both `element` and `symbol` on each record even though they hold identical values; the review UI now reads the single `element` field, removing the duplicate.
