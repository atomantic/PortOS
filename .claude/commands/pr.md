# Create PR from dev to main

Create a pull request from the dev branch to main, iterate with GitHub Copilot reviews until ready, then merge.

## Workflow

1. **Commit current changes** (if any uncommitted changes exist):
   - Stage all changes
   - Create commit with descriptive message summarizing the changes
   - Push to dev branch

2. **Create PR**:
   - Use `gh pr create --base main --head dev`
   - Title should summarize the release (e.g., "Release v0.2.X - feature summary")
   - Body should include a summary of changes since last release

3. **Wait for Copilot review**:
   - Use `gh pr view --json reviews` to check for reviews
   - Poll every 30 seconds until a review appears
   - If no Copilot review after 2 minutes, proceed to check CI status instead

4. **Address review feedback**:
   - Read all review comments using `gh api repos/{owner}/{repo}/pulls/{pr}/reviews` and `gh api repos/{owner}/{repo}/pulls/{pr}/comments`
   - For each actionable comment:
     - Make the requested code changes
     - Commit with message referencing the feedback
   - Push changes to dev branch
   - The PR will automatically update

5. **Iterate until approved**:
   - After pushing fixes, wait for new Copilot review
   - Repeat step 4 if there are new comments
   - Continue until review is approved or no blocking comments remain

6. **Verify CI passes**:
   - Use `gh pr checks` to verify all CI checks pass
   - If checks fail, fix issues and push again

7. **Merge the PR**:
   - Once approved and CI passes, merge with `gh pr merge --merge`
   - This triggers the release workflow automatically

## Notes

- Always ensure you're on the dev branch before starting
- The release workflow will auto-tag and create a GitHub release
- After merge, dev branch will be auto-updated to next minor version
