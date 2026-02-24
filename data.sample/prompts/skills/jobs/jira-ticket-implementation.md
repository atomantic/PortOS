# JIRA Ticket Implementation Job

Autonomous job for implementing JIRA tickets in JIRA-connected apps using git worktrees.

## Prompt Template

You are acting as my Chief of Staff, implementing JIRA tickets for apps with JIRA integration enabled.

This job runs Monday-Friday at 9 AM and focuses on actually implementing tickets, not just reviewing them. Unlike the JIRA App Maintenance job which triages and comments on tickets, this job picks up ready tickets and implements them.

## Steps

1. **Discover JIRA-enabled apps**
   - Call `GET /api/apps` to get all managed apps
   - Filter for apps where:
     - `jira.enabled === true`
     - `jira.instanceId` is set
     - `jira.projectKey` is set
   - Skip archived apps

2. **Fetch sprint tickets for each app**
   - For each JIRA-enabled app, call `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey`
   - This returns tickets assigned to me in the current active sprint
   - Filter tickets to find implementation candidates

3. **Select a ticket to implement**

   **Selection Criteria:**
   - Status is "To Do", "Ready", "Open", or similar pre-work state
   - NOT in "In Progress", "In Review", "Done", "Blocked"
   - Ticket has clear requirements (summary + description)
   - Prefer higher priority tickets first
   - Select only ONE ticket per job run to maintain focus

   **Skip tickets that:**
   - Are already in progress or review
   - Lack clear requirements or acceptance criteria
   - Are marked as blocked
   - Have open questions in comments

4. **Create a git worktree for implementation**

   Use the PortOS worktree manager API or direct git commands:

   ```bash
   cd /path/to/app/repo
   git fetch origin
   git worktree add -b feature/TICKET-123 ../worktrees/TICKET-123 origin/main
   ```

   Or via API:
   ```
   POST /api/cos/worktrees
   Body: {
     "agentId": "jira-impl-{timestamp}",
     "sourceWorkspace": "/path/to/app/repo",
     "taskId": "TICKET-123"
   }
   ```

5. **Implement the ticket**

   In the worktree directory:
   - Read the ticket requirements carefully
   - Implement the feature/fix as described
   - Follow the project's coding conventions
   - Write tests if the project has a test suite
   - Ensure the code compiles/lints without errors

6. **Commit and push changes**

   ```bash
   git add .
   git commit -m "feat(TICKET-123): <summary from ticket>"
   git push -u origin feature/TICKET-123
   ```

7. **Create a merge/pull request**

   Using GitHub CLI:
   ```bash
   gh pr create \
     --title "TICKET-123: <summary>" \
     --body "## Summary
   Implements TICKET-123

   ## Changes
   - <list of changes>

   ## Testing
   - <how to test>

   ## JIRA
   [TICKET-123](https://jira.example.com/browse/TICKET-123)" \
     --base main
   ```

   For GitLab:
   ```bash
   glab mr create \
     --title "TICKET-123: <summary>" \
     --description "..." \
     --target-branch main
   ```

8. **Transition the JIRA ticket to In Review**

   First, get available transitions:
   ```
   GET /api/jira/instances/:instanceId/tickets/:ticketKey/transitions
   ```

   Find the transition ID for "In Review", "Code Review", or "Ready for Review" status.

   Then transition:
   ```
   POST /api/jira/instances/:instanceId/tickets/:ticketKey/transition
   Body: { "transitionId": "<transition-id>" }
   ```

9. **Add PR link to JIRA ticket**

   ```
   POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments
   Body: {
     "comment": "Implementation complete. PR: <pr-url>\n\nReady for code review."
   }
   ```

10. **Clean up worktree (optional)**

    The worktree can be kept for reference or cleaned up:
    ```bash
    git worktree remove ../worktrees/TICKET-123
    ```

11. **Generate summary report**
    - Ticket implemented
    - PR created (with link)
    - Ticket transitioned to status
    - Any issues encountered

## Expected Outputs

1. **Code Changes** - Committed to a feature branch
2. **Pull/Merge Request** - Created and linked to ticket
3. **JIRA Ticket Update** - Transitioned to "In Review" with PR link
4. **Summary Report** - Saved via CoS reporting system

## Success Criteria

- One well-defined ticket is selected and implemented per run
- Code is committed to a feature branch (not main/master)
- PR/MR is created with proper description
- JIRA ticket is transitioned to review status
- PR link is added as a JIRA comment
- No broken builds or failing tests introduced

## Job Metadata

- **Category**: jira-ticket-implementation
- **Interval**: Daily
- **Schedule**: Monday-Friday at 9:00 AM (cron: `0 9 * * 1-5`)
- **Priority**: HIGH
- **Autonomy Level**: yolo (fully autonomous implementation)

## Workflow Diagram

```
Start Job
    |
    v
Get JIRA-enabled apps
    |
    v
For each app:
    |
    v
Fetch sprint tickets --> Filter ready tickets --> Select highest priority
    |
    v
Create git worktree
    |
    v
Implement ticket
    |
    v
Commit + Push
    |
    v
Create PR/MR
    |
    v
Transition ticket to "In Review"
    |
    v
Add PR link comment
    |
    v
Generate report
    |
    v
End Job
```

## Example Report Structure

```markdown
# JIRA Ticket Implementation Report - 2026-02-24

## Summary
- Apps checked: 2
- Tickets evaluated: 8
- Ticket implemented: 1
- PR created: Yes

## Implementation Details

### App: MyWebApp (PROJ)

**Selected Ticket:** PROJ-456 (HIGH Priority)
- Summary: Add user profile settings page
- Original Status: To Do
- New Status: In Review

**Implementation:**
- Branch: `feature/PROJ-456`
- Commits: 3
- Files changed: 5
- Lines added: 247
- Lines removed: 12

**Pull Request:**
- URL: https://github.com/org/mywebapp/pull/123
- Title: PROJ-456: Add user profile settings page
- Status: Open, awaiting review

**JIRA Updates:**
- Transitioned to: In Review
- Comment added with PR link

### Skipped Tickets
- PROJ-457: Needs clarification (no acceptance criteria)
- PROJ-458: Already in progress
- PROJ-459: Low priority, well-groomed (deferred)

## Next Steps
1. Monitor PR for review feedback
2. Address any review comments in next run
3. Consider PROJ-457 after requirements clarified
```

## Notes

- This job makes actual code changes and creates PRs
- Only one ticket is implemented per run to maintain quality
- The job respects the app's existing git workflow
- Worktrees ensure the main workspace stays clean
- If implementation fails, the ticket is NOT transitioned
- Failed implementations should be reported but not block future runs
- The job runs Monday-Friday to align with typical work schedules
