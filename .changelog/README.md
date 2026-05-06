# Release Changelogs

This directory contains detailed release notes for each version of PortOS.

**No root CHANGELOG.md needed** - all changelog content lives in this directory.

## Structure

### NEXT.md — Unreleased Changes Accumulator

During development, all changelog entries are appended to `NEXT.md`. This file accumulates changes across multiple commits until a release is created.

- During development, append changelog entries to `NEXT.md` under the appropriate section (Added, Changed, Fixed, Removed)
- `/do:release` (a Claude Code slash command skill) renames `NEXT.md` to `v{version}.md` and finalizes it with the version number and release date. The release workflow then uses this versioned file for the GitHub release notes
- Do NOT create versioned changelog files manually — `/do:release` handles that

### Versioned Files

Each release has its own markdown file:

```
v{major}.{minor}.{patch}.md
```

These are created automatically by `/do:release` from `NEXT.md`.

## Format

Each changelog file should follow this structure:

```markdown
# Release v{version}

Released: YYYY-MM-DD

## Overview

A brief summary of the release.

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

## Development Workflow

1. **During Development**: Append entries to `NEXT.md` under the appropriate section (Added, Changed, Fixed, Removed)

2. **During Release** (`/do:release`):
   - Determines the version bump from conventional commit prefixes
   - Bumps `package.json` version
   - Renames `NEXT.md` → `v{new_version}.md`
   - Adds version header, release date, and diff link
   - Commits the version bump + finalized changelog

## Style Rules

Release notes are read by end users — not by the developer who wrote the change.
Write so a non-PortOS-developer can understand what changed and decide whether
they care about this release.

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
- **Update the changelog as you work** so detail doesn't have to be
  reconstructed at release time.

### Don't
- **No file paths, module names, function names, route paths, or CSS class
  names.** If you find yourself writing `server/services/foo.js`,
  `composeStyledPrompt`, or `flex-col gap-2`, stop and rewrite from the user's
  point of view.
- **No "Touched:" / "New file:" / "Removed:" footers.** Those belong in commit
  messages, PRs, or `git log`.
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
