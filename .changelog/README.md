# Release Changelogs

This directory contains **all** release notes for PortOS. Unlike traditional projects that maintain a root `CHANGELOG.md` file, we use version-specific files that evolve with development and automatically archive on release.

**No root CHANGELOG.md needed** - all changelog content lives in this directory.

## Structure

Each minor version series has its own markdown file following the naming convention:

```
v{major}.{minor}.x.md
```

The "x" is a literal character, not a placeholder - it represents the entire minor version series (e.g., all 0.10.x releases share `v0.10.x.md`).

Examples:
- `v0.9.x.md` - Used for releases 0.9.1, 0.9.2, 0.9.3, etc.
- `v0.10.x.md` - Used for releases 0.10.1, 0.10.2, 0.10.3, etc.
- `v1.0.x.md` - Used for releases 1.0.1, 1.0.2, 1.0.3, etc.

Alternatively, you can create a specific version file (e.g., `v0.10.5.md`) which takes precedence over the pattern file.

## Format

Each changelog file should follow this structure:

```markdown
# Release v{major}.{minor}.x - {Descriptive Title}

Released: YYYY-MM-DD

## Overview

A brief summary of the release, highlighting the main theme or most important changes.

## 🎉 New Features

### Feature Category 1
- Feature description with technical details
- Another feature in this category

### Feature Category 2
- More features...

## 🐛 Bug Fixes

### Fix Category
- Description of what was fixed
- Impact and technical details

## 🔧 Improvements

### Improvement Category
- What was improved
- Why it matters

## 🗑️ Removed

### Deprecated Features
- What was removed
- Why it was removed

## 📦 Installation

\`\`\`bash
git clone https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all
pm2 start ecosystem.config.cjs
\`\`\`

## 🔗 Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v{prev}...v{major}.{minor}.x
```

## Workflow Integration

The GitHub Actions release workflow (`.github/workflows/release.yml`) automatically:

### During Release (on main)
1. Checks for an exact version changelog file (e.g., `v0.10.5.md`)
2. If not found, checks for a minor version pattern file (e.g., `v0.10.x.md`)
3. If found, replaces version placeholders with actual release version
4. Creates the GitHub release with the substituted changelog
5. If no changelog found, falls back to generating from git commits

### After Release (dev branch prep)
1. Checks out dev branch
2. If pattern file exists (e.g., `v0.10.x.md`):
   - Renames it to versioned file (e.g., `v0.10.5.md`) using `git mv` to preserve history
   - Replaces version placeholders in the renamed file
   - Commits the renamed file to dev with `[skip ci]`
   - Cherry-picks that commit to main with `[skip ci]`
3. Bumps dev branch to next minor version (e.g., 0.11.0)

This means:
- You maintain one `v0.10.x.md` file throughout development
- On release, it's renamed to the actual version (preserving git history)
- Dev and main both have the historical record matching the tag
- Git history shows the file evolution from `v0.10.x.md` → `v0.10.5.md`

## Creating a New Changelog

When working on a new minor version series (e.g., starting 0.10.x development):

1. **Start of Minor Version**: Create the changelog file when dev branch is bumped:
   ```bash
   # After main release bumps dev to 0.10.0, create the changelog
   cp .changelog/v0.9.x.md .changelog/v0.10.x.md

   # Edit the new file with template structure
   # Keep the version as "v0.10.x" throughout development
   ```

2. **During Development**: Update `.changelog/v0.10.x.md` **every time** you add features and fixes
   - This is your only changelog - no separate CHANGELOG.md file
   - Add entries under appropriate emoji sections (🎉 Features, 🐛 Fixes, 🔧 Improvements)
   - Keep the version in the file as `v0.10.x` (literal x)
   - Don't worry about the final patch number - it will be substituted automatically

3. **Before Merging to Main**: Final review and updates:
   - Ensure all changes are documented in `.changelog/v0.10.x.md`
   - Add release date (update "YYYY-MM-DD" to actual date)
   - Review and polish the content
   - Commit the changelog file

4. **On Release**: The GitHub Actions workflow will:
   - Read `.changelog/v0.10.x.md`
   - Replace all instances of `0.10.x` with the actual version (e.g., `0.10.5`)
   - Create the GitHub release with the substituted changelog
   - Create `.changelog/v0.10.5.md` in dev branch (archived copy)
   - Merge that archived file back to main with `[skip ci]`

5. **After Release**:
   - The pattern file `v0.10.x.md` is renamed to `v0.10.5.md` in dev branch
   - Main branch receives the same file via cherry-pick
   - Both branches now have the versioned file matching the tag
   - You'll need to create a new `v0.11.x.md` for the next minor version

## Best Practices

### ✅ Do:
- Update the changelog file **as you work** (not just before release)
- Use clear, descriptive section headings
- Group related changes together
- Include technical details where helpful
- Explain the "why" not just the "what"
- Use emoji section headers for visual organization (🎉 ✨ 🐛 🔧 🗑️ 📦)
- Link to relevant documentation or issues
- Include upgrade instructions for breaking changes
- Highlight security improvements
- Keep all changelog content in `.changelog/` directory only

### ❌ Don't:
- Create a root `CHANGELOG.md` file (all changelogs live in `.changelog/` directory)
- Use vague descriptions like "various improvements"
- Include internal implementation details users don't care about
- Repeat the same information in multiple sections
- Use raw commit messages without context
- Forget to update the release date before merging to main
- Leave placeholder or TODO content
- Change the version from `v0.10.x` to specific patch numbers during development

## Maintenance

### Updating Past Releases

If you need to update a past release's changelog:

1. Edit the `.changelog/v{version}.md` file
2. Update the GitHub release manually:
   ```bash
   gh release edit v{version} --notes-file .changelog/v{version}.md
   ```

### Consistency Check

Periodically verify that:
- All tagged releases have corresponding changelog files
- Root `CHANGELOG.md` is in sync with `.changelog/` directory
- Release dates match git tag dates
- Links to full diffs are correct

## Tools

### View Release on GitHub
```bash
gh release view v{version}
```

### Edit Release Notes
```bash
gh release edit v{version} --notes-file .changelog/v{version}.md
```
