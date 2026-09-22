# Release Changelogs

This directory contains detailed release notes for each version of PortOS.

**No root CHANGELOG.md needed** - all changelog content lives in this directory.

## Structure

### No per-branch entries — release notes come from the commit log

There is nothing to write while you work. `/do:release` builds the changelog
for a release by reading `git log` since the last tag and grouping commits by
feature/theme into a human-readable summary — it does this automatically as
part of the release, not from anything staged in this directory. Do not create
a `NEXT.md`, do not write a per-branch fragment, and do not hand-edit a
changelog file for unreleased work.

**Practical consequence: write commit subjects and bodies for a human deciding
whether to upgrade**, not just for `git log --oneline`. A commit message that
states what changed and why is what `/do:release` turns into a release-note
bullet. See "Git commits and PRs" in the global instructions for the format —
one specific sentence in the subject, body only when the why is non-obvious.

#### Why not per-branch fragments

PortOS used to require every branch to write a changelog fragment
(`.changelog/next/<section>-<branch>.md`, collected into `NEXT.md` at release
time) specifically so that two branches cut from the same base never touched
the same changelog line — a guaranteed merge conflict otherwise. That
machinery is gone now: since no branch writes anything under `.changelog/`
during development, there is no shared file for parallel branches to collide
on in the first place. `/do:release` reads commit history instead, which
every branch already produces without any extra step.

### Versioned Files

Each release has its own markdown file, written by `/do:release` when it runs:

```
v{major}.{minor}.{patch}.md
```

Don't create these manually and don't bump the version manually — `/do:release`
handles both. If you need to correct an already-published release's notes, edit
the versioned file directly (see Maintenance below).

## Format

The release agent chooses `{Fun Name}` after reviewing the complete release
range and identifying its one or two biggest user-visible wins. Keep it short,
memorable, playful, and accurate — for example, `Performant Dragon` for a
release centered on faster, lower-bandwidth Chief of Staff page loads. The
first heading is also the source for the GitHub release title, so keep the
exact ` - ` separator and update the notes and published title together when
correcting an existing release.

Each changelog file should follow this structure:

```markdown
# Release v{version} - {Fun Name}

Released: YYYY-MM-DD

## Highlights

A few plain-language bullets grouped by feature area, for someone deciding
whether to upgrade.

## Added

- Feature descriptions

## Changed

- What was changed

## Fixed

- Description of what was fixed

## Removed

- What was removed

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v{prev}...v{current}
```

## Workflow Integration

The GitHub Actions release workflow (`.github/workflows/release.yml`) automatically:

1. Checks for a changelog file matching the version in `package.json`
2. If found, uses it as the GitHub release description
3. If not found, falls back to generating a simple changelog from git commits

## Style Rules

Release notes are read by end users — not by the developer who wrote the change.
Write so a non-PortOS-developer can understand what changed and decide whether
they care about this release. These rules apply both to the commit messages
`/do:release` reads (since the notes are synthesized from them) and to any
manual correction of an already-published versioned file.

### Do
- **One sentence per change.** Two if a meaningful "why" needs to land. Major
  features may warrant a short paragraph, never a code review.
- **Lead with the user-visible effect.** "App deploy modal can be dismissed
  while a deploy is running" — not "DeployPanel.jsx now renders an X button
  unconditionally."
- **Use plain product language.** Page names ("Apps page header"), feature
  names ("Writers Room"), button labels ("+ Add"), and concrete UI elements
  are fine. Internal identifiers are not.
- **Group related entries.** When a single feature spans many sub-bullets
  (e.g. ten Writers Room changes), introduce it once with a short paragraph
  and follow with terse bullets, rather than ten separate paragraph entries.

### Don't
- **No file paths, module names, function names, route paths, or CSS class
  names.** If you find yourself writing `server/services/foo.js`,
  `composeStyledPrompt`, or `flex-col gap-2`, stop and rewrite from the user's
  point of view.
- **No "Touched:" / "New file:" / "Removed:" footers.** Those belong in commit
  messages, PRs, or `git log`.
- **No `[plan-id]` slug prefixes.** Slugs like `[data-versioning-split-pipeline-issues]`
  are for grep-ability across commits, branches, and PR titles — keep them out of
  user-facing release notes.
- **No internal data shapes.** "Each Work now carries `imageStyle = { presetId,
  prompt, negativePrompt }`" should be "Each Writers Room work can pin a world
  style preset that prefixes every scene's image prompt."
- **No deep technical rationale.** React StrictMode race details, diffusion
  token weighting, ffmpeg filter graphs, and Zod schema names belong in commit
  bodies / PR descriptions, not release notes.
- **No `/do:release` meta**. Don't reference the changelog tooling itself.
- **Don't create versioned changelog files manually** (use `/do:release`).
- **Don't bump the version manually** — only `/do:release` does that.
- **Don't leave vague entries** like "various improvements" or "general fixes."

### Style Examples

**Bad** (what verbose entries actually look like — file paths, paragraph length, internal API):

> **Mobile sidebar footer — version + icons no longer overflow the nav.** The
> expanded sidebar drawer footer rendered the version label and four 40×40
> touch-target icons (Ambient, theme toggle, voice toggle, notifications) on a
> single `flex justify-between` row. On mobile the sidebar is `w-56` (224px)…
> Touched: `client/src/components/Layout.jsx`.

**Good** (one sentence, user perspective, no internals):

> Mobile navigation drawer footer no longer clips the notification bell.

**Bad** (multi-paragraph code review with module names):

> **Writers Room — vertical Storyboard companion + UX cleanup.** The
> AI/Outline/Versions tabbed sidebar is replaced with an always-on
> `StoryboardPanel`… New files: `StoryboardPanel.jsx`, `SceneCard.jsx`,
> `CharactersBible.jsx`. Touched: `client/src/components/writers-room/WorkEditor.jsx`…

**Good** (intro paragraph + terse bullets, all user-facing language):

> **Writers Room storyboard.** The right column is now an always-on storyboard
> showing each scene as a card with image, slugline, summary, and character
> chips. Click a card to jump to that scene in your prose; per-card overflow
> menu adds *Why this image / Check characters / Editorial pass / Jump to prose*.
> Mobile gets a Writing/Storyboard toggle instead of a stacked layout.

## Maintenance

### Updating Past Releases

If you need to update a past release's changelog:

1. Edit the `.changelog/v{version}.md` file
2. Update the GitHub release manually:
   ```bash
   gh release edit v{version} --notes-file .changelog/v{version}.md
   ```
