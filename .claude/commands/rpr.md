# Resolve PR Review Feedback

Address the latest code review feedback on the current branch's pull request.

## Steps

1. **Get the current PR**: Use `gh pr view --json number,url,reviewDecision,reviews` to find the PR for this branch

2. **Fetch review comments**: Use `gh api graphql` to get all unresolved review threads:
   ```
   gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             nodes {
               id
               isResolved
               comments(first: 10) {
                 nodes {
                   body
                   path
                   line
                   author { login }
                 }
               }
             }
           }
         }
       }
     }
   '
   ```

3. **Address each unresolved thread**:
   - Read the file and understand the context
   - Make the requested code changes if they are accurate
   - Keep track of which thread IDs were addressed
   - Check to see if there are further opportunities to DRY up the code
   - Do your own code review and correct any other issues

4. **Commit and push**: Stage changes, commit with message like `fix: address PR review feedback`, push to dev branch

5. **Resolve conversations**: For each addressed thread, use the GraphQL mutation:
   ```
   gh api graphql -f query='
     mutation($threadId: ID!) {
       resolveReviewThread(input: {threadId: $threadId}) {
         thread { isResolved }
       }
     }
   ' -f threadId='<THREAD_ID>'
   ```

6. **Re-request review** if needed: `gh pr edit --add-reviewer <reviewer>`

## Notes

- Parse the repo owner/name from `gh repo view --json owner,name`
- Only resolve threads where you've actually addressed the feedback
- If feedback is unclear, leave a reply instead of resolving
- Do not include co-author info in commits
- This project uses `dev` as the working branch, PRs go from `dev` to `main`
