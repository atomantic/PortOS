// The CoS task prompt for a managed app's release PR (dev → base branch).
// Step numbers shift by one when the repo keeps a `.changelog/`, so every
// later step and the "repeat steps X-Y" cross-reference are computed.
export function buildReleasePrompt({ repoPath, appName, comparison, baseBranch, devBranch, hasChangelog }) {
  const commitList = comparison.commits
    .map(c => `- ${c.hash} ${c.message}`)
    .join('\n');

  const changelogStep = hasChangelog ? `
2. **Changelog management**:
   - Read version from package.json to determine the minor version series (e.g., 0.12.x)
   - Check if \`.changelog/v{major}.{minor}.x.md\` exists
   - If not, create it using the structure from an existing changelog file as template
   - Update it with entries for the commits being released, categorized by type (Features, Fixes, Improvements)
   - Keep the version as literal "x" — the release workflow substitutes the actual version
   - Commit the changelog: \`git add .changelog/ && git commit -m "docs: update changelog for release"\`
   - Push: \`git pull --rebase --autostash && git push\`
` : '';

  const prStep = hasChangelog ? 3 : 2;
  const reviewStep = prStep + 1;
  const feedbackStep = reviewStep + 1;
  const reRequestStep = feedbackStep + 1;
  const iterateStep = reRequestStep + 1;
  const ciStep = iterateStep + 1;
  const mergeStep = ciStep + 1;

  return `You are performing a release workflow for ${appName}. The repo is at: ${repoPath}

## Commits to release (${comparison.ahead} commits ahead of ${baseBranch}):
${commitList}

## Steps

1. **Ensure clean state**:
   - Check for uncommitted changes. If any, stage, commit with a descriptive message, then run \`git pull --rebase --autostash && git push\`
   - If no uncommitted changes, still run \`git pull --rebase --autostash && git push\` to ensure we're up to date
${changelogStep}
${prStep}. **Create PR**:
   - Check for existing PR: \`gh pr list --base ${baseBranch} --head ${devBranch} --state open\`
   - If no existing PR, create one: \`gh pr create --base ${baseBranch} --head ${devBranch} --title "Release vX.Y.Z" --body "Release notes..."\`
   - Include a summary of changes in the PR body

${reviewStep}. **Wait for Copilot review**:
   - Poll \`gh pr view --json reviews\` every 30 seconds
   - Timeout after 2 minutes if no review appears

${feedbackStep}. **Address review feedback** (if any):
   - Fetch unresolved threads via GraphQL:
     \`\`\`
     gh api graphql -f query='query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 10) { nodes { body path line author { login } } } } } } } }'
     \`\`\`
   - Make requested changes, commit, push (\`git pull --rebase --autostash && git push\`)
   - Resolve addressed threads via GraphQL mutation

${reRequestStep}. **Re-request review**:
   - Get repo info: \`gh repo view --json owner,name\`
   - Get PR number from \`gh pr view --json number\`
   - Try API: \`gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers -f '{"reviewers":["copilot-pull-request-reviewer"]}' --method POST\`
   - If that fails, use browser MCP to navigate to the PR page and click the re-request review button (the sync icon button with \`name="re_request_reviewer_id"\`)

${iterateStep}. **Iterate**: Repeat steps ${reviewStep}-${reRequestStep} up to 3 times max

${ciStep}. **Verify CI**: Run \`gh pr checks\` and fix any failures

${mergeStep}. **Merge**: Once approved and CI passes, merge with \`gh pr merge --merge\`

## Important rules:
- Always \`git pull --rebase --autostash\` before pushing
- No co-author info in commits${hasChangelog ? '\n- Keep changelog version as literal "x" (the release workflow substitutes the actual version number)' : ''}
- Max 3 review iterations to prevent infinite loops
- Report clearly if something fails
- Parse repo owner/name from \`gh repo view --json owner,name\``;
}
