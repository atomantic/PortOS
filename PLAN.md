# PortOS — Development Plan

The roadmap now lives entirely in the **GitHub issue tracker**:

- **Active / claimable work** — open issues labeled
  [`plan`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Aplan).
- **Parked ideas / not-yet-ready** — open issues labeled
  [`future`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Afuture)
  (speculative possibilities; promote to `plan` when one becomes a real, claimable task).

Managed by `/do:replan --issues`. For project goals, see [GOALS.md](./GOALS.md);
for completed work, see [.changelog/](./.changelog/) and `git log`.

This file no longer tracks individual tasks (so it stops generating merge
conflicts as work proceeds). Speculative ideas now live as `future`-labeled
issues rather than a list here, so they can each be promoted, refined, or closed
independently.

### SongBook follow-ups

Deferred from the SongBook feature's post-review cleanup (see
`docs/plans/2026-07-15-songbook.md`) — to be promoted to labeled GitHub issues
by `/do:replan --issues`:

- [ ] "Fit to duration" autoscroll preset: re-add an optional `scrollDurationSec`
  field to `songInputSchema` (`server/lib/brainValidation.js`) plus a preset
  button in `client/src/pages/SongBookViewer.jsx` that computes `pxPerSec` from
  the scroll container's `scrollHeight / scrollDurationSec`. Dropped from v1 as
  speculative — no UI consumed the field.
- [ ] Consolidate `server/routes/uploads.js` onto the shared `saveBase64Upload`
  / `serveLocalFile` helpers in `server/lib/fileUtils.js` (added for
  `routes/attachments.js` + `routes/brainSongbook.js`). Left out of the SongBook
  pass because uploads.js has a different response shape and uses the full
  `EXTENSION_MIME_MAP` rather than an allowlist.
  Also fix while there: `routes/attachments.js`'s 50MB cap is unreachable —
  base64 ×4/3 inflation exceeds the 55mb express.json body limit above ~41MB
  (same latent mismatch fixed in `routes/brainSongbook.js`, which now caps at 40MB).
- [ ] SongBook practice/spaced-rep integration (SM-2 style, cf.
  `meatspacePostMemory`) — the `stage` field on `songs` records is manual in v1
  (`server/lib/brainValidation.js` `songStageEnum`).
- [ ] Link songs to existing Rounds/Tracks/MIDI records — a cross-links field on
  the `songs` record + UI in `client/src/pages/SongBookViewer.jsx`.
- [ ] MIDI/score preview embedding in the SongBook viewer
  (`client/src/components/songbook/TabSheetView.jsx`). (Chord diagrams /
  fretboard rendering shipped with the instrument-view toggle, issue #2656.)
- [ ] Brain memory-bridge/graph enrollment for `songs` records (nav/⌘K already
  works via the nav manifest; this is the knowledge-graph side).
