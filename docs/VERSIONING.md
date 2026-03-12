# Versioning & Release Process

## Version Format

PortOS uses semantic versioning: **Major.Minor.Patch**

| Component | Description | When Incremented |
|-----------|-------------|------------------|
| **Major** | Breaking changes | Via `/do:release` slash command |
| **Minor** | New features | Via `/do:release` slash command |
| **Patch** | Bug fixes, refactors | Via `/do:release` slash command |

Example progression: `0.22.0` → `0.22.1` (fix) → `0.23.0` (feature) → `1.0.0` (breaking)

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Push `main` to `release` to trigger GitHub Release workflow |

## Workflow

### Version Bumping

Version is managed by the `/do:release` Claude Code slash command (provided by the [slashdo](https://github.com/atomantic/slashdo) skill). Do not bump `package.json` version manually during development.

### On Push/PR to `main`

CI runs tests and linting. No version changes.

### On Push `main` → `release`

1. Release workflow triggers
2. Creates git tag with current version (e.g., `v1.31.0`)
3. Generates GitHub release with changelog (priority: exact `.changelog/v{version}.md` → pattern `.changelog/v{major}.{minor}.x.md` → fallback commit log)
4. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used, archives it by renaming to the exact version file on `main`
5. If the archive step ran, fast-forwards `release` to match `main`

### Regular Development

```bash
# Work on main or feature branches
git checkout main
git pull

# Make changes, commit, push
git add [changed files]
git commit -m "fix: resolve issue"
git pull --rebase --autostash && git push
```

### Creating a Release

Use the `/do:release` slash command from `main`. It handles version bumping, changelog finalization, and pushing to the `release` branch.

## CI Skip

Use `[skip ci]` in commit messages to prevent CI from running (used by automation for changelog archives).
