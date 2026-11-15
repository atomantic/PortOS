# Release Notes

This directory holds one file, `RELEASE.md`: the notes for the release currently
described by `package.json`. `/do:release` overwrites it for each release.

**The archive is GitHub Releases plus the version tags.** Older notes are not kept
in the tree; read them on the [Releases page](https://github.com/atomantic/PortOS/releases)
or with `gh release view vX.Y.Z`. The file as it stood at a tag is still available
with `git show vX.Y.Z:.changelog/RELEASE.md`.

## Source and workflow

Commit messages are the source. Nothing is written here while you work: no
`NEXT.md`, no per-branch fragment, no hand-edited file for unreleased work.
`/do:release` reads `git log` from the previous published tag through the frozen
candidate (see [the release procedure](../docs/VERSIONING.md#creating-a-release))
and writes `RELEASE.md` on the candidate. **Write commit subjects and bodies for a
human deciding whether to upgrade.**

`.github/workflows/release.yml` publishes `RELEASE.md` as the GitHub Release body.
The step fails when the heading's version differs from `package.json`, and when the
notes exceed 100 KB (they are never truncated). Only a missing file falls back to a
list of commit subjects.

## Format

The release agent chooses `{Fun Name}` after reviewing the complete release range
and identifying its one or two biggest user-visible wins: short, memorable, playful
and accurate (for example, `Performant Dragon` for faster, lower-bandwidth page
loads). The first heading is the source for the GitHub release title, so keep the
exact ` - ` separator.

```markdown
# Release v{version} - {Fun Name}

Released: YYYY-MM-DD

## Highlights

A few plain-language bullets grouped by feature area, for someone deciding
whether to upgrade.

## Added / Changed / Fixed / Removed

- One sentence per change

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v{prev}...v{current}
```

## Style

Readers are end users, not the developer who made the change.

- One sentence per change; lead with the user-visible effect.
- Plain product language: page names, feature names, button labels.
- Group related entries under a short intro paragraph with terse bullets.
- No file paths, module, function, route or CSS names; no "Touched:" footers; no
  `[plan-id]` slugs; no internal data shapes or deep technical rationale.
- No vague entries such as "various improvements".
- Do not bump the version by hand or edit the file outside a release; to correct a
  published release, fix `RELEASE.md` on the release branch and run
  `gh release edit vX.Y.Z --notes-file .changelog/RELEASE.md` (with the matching
  title).
