# JIRA Sprint Manager Job

Autonomous job that triages and implements JIRA tickets for apps with JIRA integration enabled. Runs Monday-Friday at 9 AM.

## Prompt Template

You are acting as my Chief of Staff, triaging and implementing JIRA tickets for apps with JIRA integration enabled.

This job runs Monday-Friday. It triages all sprint tickets first, then implements the top-priority ready ticket.

## Steps

### Phase 1 — Triage

1. **Discover JIRA-enabled apps**
   - Call `GET /api/apps` to get all managed apps
   - Filter for apps where `jira.enabled === true` and both `jira.instanceId` and `jira.projectKey` are set
   - Skip archived apps

2. **Fetch sprint tickets for each app**
   - For each JIRA-enabled app, call `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey`
   - This returns tickets assigned to me in the current active sprint

3. **Evaluate each ticket**

   For each ticket, assess quality and readiness:

   | Ticket State | Action to Take |
   |--------------|----------------|
   | **Poor quality** - Vague summary, missing details | Add JIRA comment requesting clarification with specific questions |
   | **Blocked or needs discussion** - Dependencies, unclear approach | Add JIRA comment noting the blocker and suggesting paths forward |
   | **Well-defined & ready** - Clear requirements, no blockers | Mark as implementation candidate |
   | **High priority or blocker** - Marked urgent | Prioritize for implementation |
   | **Low priority & well-groomed** - Can wait | No immediate action needed |

4. **Take triage actions via API**

   **To add a JIRA comment:**
   ```
   POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments
   Body: { "comment": "Your comment text here" }
   ```

### Phase 2 — Implement

5. **Select a ticket to implement**
   - From triage results, select the highest priority ticket in "To Do" or "Ready" status
   - Must have clear requirements (summary + description)
   - Select only ONE ticket per run to maintain focus
   - Skip if no tickets are ready

6. **Create a git worktree for implementation**
   ```bash
   cd /path/to/app/repo
   git fetch origin
   git worktree add -b feature/TICKET-123 ../worktrees/TICKET-123 origin/main
   ```

7. **Implement the ticket** in the worktree directory
   - Read the ticket requirements carefully
   - Follow the project's coding conventions
   - Write tests if the project has a test suite
   - Ensure the code compiles/lints without errors

8. **Commit and push changes**
   ```bash
   git add .
   git commit -m "feat(TICKET-123): <summary from ticket>"
   git push -u origin feature/TICKET-123
   ```

9. **Create a merge/pull request** using `gh pr create` or `glab mr create`

10. **Transition the JIRA ticket to In Review**
    ```
    GET /api/jira/instances/:instanceId/tickets/:ticketKey/transitions
    POST /api/jira/instances/:instanceId/tickets/:ticketKey/transition
    Body: { "transitionId": "<transition-id>" }
    ```

11. **Add PR link to JIRA ticket**
    ```
    POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments
    Body: { "comment": "Implementation complete. PR: <pr-url>\n\nReady for code review." }
    ```

### Phase 3 — Report

12. **Generate summary report** covering:
    - Total tickets reviewed per app
    - Triage actions taken (comments added, blockers noted)
    - Ticket implemented (if any) with PR link
    - Recommendations for next steps

## Expected Outputs

1. **JIRA Comments** - Added to tickets needing clarification or blocked
2. **Code Changes** - Committed to a feature branch (if implementing)
3. **Pull/Merge Request** - Created and linked to ticket (if implementing)
4. **JIRA Ticket Update** - Transitioned to "In Review" with PR link (if implementing)
5. **Summary Report** - Saved via CoS reporting system

## Success Criteria

- All JIRA-enabled apps are checked
- Every ticket in current sprint is evaluated
- Unclear tickets have clarifying comments added
- If a ready ticket exists, it is implemented with PR created
- JIRA ticket transitioned to review status with PR link
- Report provides clear visibility into all actions taken

## Job Metadata

- **Category**: jira-sprint-manager
- **Interval**: Daily at 9:00 AM, Monday-Friday
- **Priority**: HIGH
- **Autonomy Level**: yolo (fully autonomous triage and implementation)
