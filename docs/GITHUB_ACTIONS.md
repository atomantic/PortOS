# GitHub Actions Pattern

This document describes the recommended GitHub Actions workflow pattern for PortOS sub-projects.

## Overview

The pattern uses two workflows:
1. **CI Workflow** (`ci.yml`) - Tests, linting, and auto version bumps on `dev`
2. **Release Workflow** (`release.yml`) - Creates releases when merging to `main`

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production releases only |
| `dev` | Active development |

## CI Workflow (`ci.yml`)

### Trigger Configuration

```yaml
name: CI

on:
  pull_request:
    branches: [main, dev]
  push:
    branches: [dev]

permissions:
  contents: write
```

### Jobs

#### 1. Test Job

Runs tests on PRs and pushes. Uses `[skip ci]` detection to avoid infinite loops from auto-commits.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    strategy:
      matrix:
        node-version: [20.x]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci
        # For monorepos, install each workspace:
        # run: npm run install:all

      - name: Run tests
        run: npm test

      - name: Build
        run: npm run build
```

#### 2. Lint Job

Runs in parallel with tests for faster feedback.

```yaml
  lint:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js 20.x
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Check for syntax errors
        run: node --check src/index.js
```

#### 3. Version Bump Job

Auto-increments patch version after successful tests on `dev` branch.

```yaml
  bump-build:
    runs-on: ubuntu-latest
    needs: [test, lint]
    # Only on push to dev, skip if already a version bump commit
    if: github.event_name == 'push' && github.ref == 'refs/heads/dev' && !contains(github.event.head_commit.message, '[skip ci]')

    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump patch version
        run: |
          CURRENT_VERSION=$(node -p "require('./package.json').version")

          MAJOR=$(echo $CURRENT_VERSION | cut -d. -f1)
          MINOR=$(echo $CURRENT_VERSION | cut -d. -f2)
          PATCH=$(echo $CURRENT_VERSION | cut -d. -f3)

          NEW_PATCH=$((PATCH + 1))
          NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

          npm version $NEW_VERSION --no-git-tag-version

          git add package.json package-lock.json
          git commit -m "build: bump version to $NEW_VERSION [skip ci]"
          git push
```

**Monorepo variant** - Update all package.json files:

```yaml
      - name: Bump patch version
        run: |
          CURRENT_VERSION=$(node -p "require('./package.json').version")

          MAJOR=$(echo $CURRENT_VERSION | cut -d. -f1)
          MINOR=$(echo $CURRENT_VERSION | cut -d. -f2)
          PATCH=$(echo $CURRENT_VERSION | cut -d. -f3)

          NEW_PATCH=$((PATCH + 1))
          NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

          npm version $NEW_VERSION --no-git-tag-version
          cd client && npm version $NEW_VERSION --no-git-tag-version && cd ..
          cd server && npm version $NEW_VERSION --no-git-tag-version && cd ..

          git add package.json package-lock.json client/package.json server/package.json
          git commit -m "build: bump version to $NEW_VERSION [skip ci]"
          git push
```

## Release Workflow (`release.yml`)

### Trigger Configuration

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
```

### Release Job

Creates a GitHub release with changelog when code is merged to `main`.

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Use Node.js 20.x
        uses: actions/setup-node@v4
        with:
          node-version: 20.x

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Get version from package.json
        id: package-version
        run: echo "version=$(node -p "require('./package.json').version")" >> $GITHUB_OUTPUT

      - name: Check if tag exists
        id: tag-check
        run: |
          if git rev-parse "v${{ steps.package-version.outputs.version }}" >/dev/null 2>&1; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi

      - name: Generate changelog
        id: changelog
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
          CHANGELOG=$(git log $PREV_TAG..HEAD --pretty=format:"- %s" --no-merges | grep -v "\[skip ci\]" | head -50)

          echo "changelog<<EOF" >> $GITHUB_OUTPUT
          echo "$CHANGELOG" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Create Release
        if: steps.tag-check.outputs.exists == 'false'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.package-version.outputs.version }}
          name: v${{ steps.package-version.outputs.version }}
          body: |
            ## Changes

            ${{ steps.changelog.outputs.changelog }}

            ## Installation

            ```bash
            git clone https://github.com/YOUR_ORG/YOUR_REPO.git
            cd YOUR_REPO
            npm install
            npm start
            ```
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Prep dev branch for next release
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          CURRENT_VERSION=${{ steps.package-version.outputs.version }}

          MAJOR=$(echo $CURRENT_VERSION | cut -d. -f1)
          MINOR=$(echo $CURRENT_VERSION | cut -d. -f2)

          NEW_MINOR=$((MINOR + 1))
          NEW_VERSION="$MAJOR.$NEW_MINOR.0"

          git fetch origin dev
          git checkout dev

          npm version $NEW_VERSION --no-git-tag-version

          git add package.json package-lock.json
          git commit -m "build: prep v$NEW_VERSION for next release [skip ci]"
          git push origin dev
```

## Key Patterns

### Skip CI Marker

Use `[skip ci]` in commit messages to prevent CI from running:
- Auto-version bump commits include this automatically
- Use manually for non-code changes (docs, configs)

### Version Strategy

- **Patch** (0.0.X): Auto-incremented on every successful push to `dev`
- **Minor** (0.X.0): Auto-incremented when merging to `main` (release)
- **Major** (X.0.0): Manually updated for breaking changes

### Changelog Generation

The release workflow auto-generates changelogs from commit messages between tags, excluding `[skip ci]` commits.

### Git Configuration

Always configure git identity in workflows that make commits:

```yaml
- name: Configure git
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
```

## Working with Auto-Commits

Since CI auto-commits version bumps, always rebase before pushing:

```bash
git pull --rebase --autostash && git push
```

## Adapting for Your Project

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update the installation instructions in the release body
3. For monorepos, add the additional package.json update steps
4. Adjust test and build commands for your project structure
