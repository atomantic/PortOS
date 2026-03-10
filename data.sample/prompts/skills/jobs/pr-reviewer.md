# PR Reviewer Job

Autonomous job that checks managed apps for open PRs/MRs by other contributors and posts code reviews on any that lack a review since the last commit. Runs every 2 hours during working hours (weekdays only).

## Prompt Template

You are acting as my Chief of Staff, reviewing pull requests and merge requests across managed apps.

## Steps

### Phase 0 — Prerequisites

0. **Ensure slashdo is installed**
   - Run `npx slash-do@latest --version` to check availability
   - If the command fails, install it with `npx slash-do@latest` to make `/do:` commands available

### Phase 1 — Discover PRs

1. **Find apps with repos**
   - Call `GET /api/apps` to get all managed apps
   - For each app with a `repoPath`, cd into the repo directory
   - Skip archived apps

2. **Detect SCM provider**
   - Run `git remote get-url origin` in the repo
   - If remote contains `github.com` -> use `gh` CLI
   - If remote contains `gitlab` -> use `glab` CLI

3. **List open PRs/MRs by others**
   - GitHub: `gh pr list --state open --json number,author,headRefName,updatedAt,title`
   - GitLab: `glab mr list --state opened -F json`
   - Filter out PRs/MRs authored by my username (`atomantic`)

### Phase 2 — Check Review Status

4. **Determine if review is needed**
   - For each PR/MR from other contributors:
     - GitHub: `gh pr view <number> --json reviews,commits` — extract my reviews and compare timestamps against the latest commit
     - GitLab: `glab mr view <iid> -F json` — check notes/approvals vs last commit date
   - Skip PRs where I already have a review posted **after** the most recent commit push

### Phase 3 — Review

5. **Run code review and post**
   - For each PR/MR needing review:
     - cd into the app's `repoPath`
     - Run `/do:review` to perform a deep code review of the changed files
     - Post the review output as a comment:
       - GitHub: `gh pr review <number> --comment --body "<review>"`
       - GitLab: `glab mr note <iid> --message "<review>"`

### Phase 4 — Report

6. **Generate summary report** covering:
   - Apps checked and PR/MR counts per app
   - Reviews posted (with links to the PR/MR)
   - PRs skipped (already reviewed since last commit)
   - Any errors encountered (auth issues, missing CLI tools, etc.)

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/apps` | GET | List all managed apps with repoPath |

## CLI Tools Used

| Tool | Purpose |
|------|---------|
| `gh pr list` | List open GitHub PRs |
| `gh pr view` | Get PR details including reviews and commits |
| `gh pr review --comment` | Post review comment on GitHub PR |
| `glab mr list` | List open GitLab MRs |
| `glab mr view` | Get MR details including notes and commits |
| `glab mr note` | Post review comment on GitLab MR |
| `/do:review` | Run deep code review of changed files |

## Expected Outputs

1. **Review Comments** - Posted directly on each PR/MR needing review
2. **Summary Report** - Saved via CoS reporting system

## Success Criteria

- All managed apps with repos are checked
- SCM provider (GitHub/GitLab) is correctly detected per repo
- Only PRs by other contributors are considered
- PRs already reviewed since the last commit are skipped
- `/do:review` is used for thorough code analysis
- Review is posted as a comment on the PR/MR
- Report provides clear visibility into review activity

## Job Metadata

- **Category**: pr-reviewer
- **Interval**: Every 2 hours (weekdays only)
- **Priority**: HIGH
- **Autonomy Level**: manager (reviews and posts comments but does not approve/merge)
