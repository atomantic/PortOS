# Versioning & Release Process

## Version Format

PortOS uses semantic versioning with the format **Major.Release.Build**:

| Component | Description | When Incremented |
|-----------|-------------|------------------|
| **Major** | Breaking changes | Manually by maintainer |
| **Release** | New features/releases | Auto on merge to `main` |
| **Build** | Development iterations | Auto on push to `dev` |

Example progression: `0.2.0` → `0.2.1` → `0.2.2` → (release) → `0.3.0`

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production releases only |
| `dev` | Active development |

## Automated Workflow

### On Push to `dev`

1. CI runs tests and linting
2. If tests pass, GitHub Actions auto-increments the **Build** number
3. Commits with `[skip ci]` to avoid infinite loops

```
Push commit → CI passes → Auto-commit: "build: bump version to 0.2.1 [skip ci]"
```

### On Merge `dev` → `main`

1. Release workflow triggers
2. Creates git tag with current version (e.g., `v0.2.5`)
3. Generates GitHub release with changelog
4. Preps `dev` branch for next release cycle:
   - Increments **Release** number
   - Resets **Build** to 0
   - Example: `0.2.5` → `0.3.0`

## Manual Steps

### Regular Development

```bash
# Work on dev branch
git checkout dev
git pull

# Make changes, commit, push
git add .
git commit -m "feat: add new feature"
git push
# CI will auto-bump: 0.2.0 → 0.2.1
```

### Creating a Release

```bash
# Ensure dev is up to date
git checkout dev
git pull

# Create PR from dev to main (via GitHub UI or CLI)
gh pr create --base main --head dev --title "Release v0.2.X"

# After PR is merged:
# - GitHub creates tag v0.2.X
# - GitHub creates release with changelog
# - dev branch is auto-updated to 0.3.0
```

### Major Version Bump

For breaking changes, manually update before merging:

```bash
git checkout dev

# Update all package.json files
npm version 1.0.0 --no-git-tag-version
cd client && npm version 1.0.0 --no-git-tag-version && cd ..
cd server && npm version 1.0.0 --no-git-tag-version && cd ..

git add -A
git commit -m "build: prep v1.0.0 major release [skip ci]"
git push

# Then create PR to main
```

## CI Skip

Use `[skip ci]` in commit messages to prevent CI from running:

- Auto-version bump commits include this automatically
- Use manually when making non-code changes (docs, etc.)

## Files Updated by Automation

The following files are updated by GitHub Actions:

- `/package.json`
- `/package-lock.json`
- `/client/package.json`
- `/server/package.json`
