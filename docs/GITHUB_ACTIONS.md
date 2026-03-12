# GitHub Actions Workflows

PortOS uses two GitHub Actions workflows for CI and releases.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Push `main` to `release` to trigger releases |

## CI Workflow (`ci.yml`)

Triggers on PRs to `main`/`release` and pushes to `main`. Runs two parallel jobs:

### Test Job

- Installs root, server, and client dependencies
- Runs server tests (`npm test --prefix server`)
- Builds client (`npm run build --prefix client`)
- Skips on `[skip ci]` commits (push events only; PR CI always runs)

### Lint Job

- Checks server entry point for syntax errors (`node --check server/index.js`)

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Reads version from `package.json`
2. Checks if git tag already exists (skips if so)
3. Looks for changelog file:
   - First: `.changelog/v{version}.md` (exact match)
   - Then: `.changelog/v{major}.{minor}.x.md` (pattern match, replaces placeholders)
   - Fallback: generates changelog from commit messages
4. Creates GitHub release with tag `v{version}`
5. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used, archives it on `main` (renames `.x.md` → exact version)
6. If the archive step ran, fast-forwards `release` to match `main`

## Working with CI

### Skip CI

Add `[skip ci]` to commit messages for non-code changes (docs, configs). Auto-generated commits from the release workflow include this automatically.

### Rebase Before Push

Since CI may auto-commit changelog archives, always rebase before pushing:

```bash
git pull --rebase --autostash && git push
```

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different
