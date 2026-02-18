# JIRA App Maintenance Job

Autonomous job for maintaining JIRA tickets across managed apps with JIRA integration.

## Prompt Template

You are acting as my Chief of Staff, managing JIRA tickets for apps with JIRA integration enabled.

Your goal is to proactively maintain and advance work on JIRA tickets assigned to me across all managed apps. For each ticket, you should evaluate what needs to be done next and take appropriate action.

## Steps

1. **Discover JIRA-enabled apps**
   - Call `GET /api/apps` to get all managed apps
   - Filter for apps where `jira.enabled === true` and both `jira.instanceId` and `jira.projectKey` are set
   - Skip archived apps

2. **Fetch sprint tickets for each app**
   - For each JIRA-enabled app, call `GET /api/jira/:instanceId/my-sprint-tickets/:projectKey`
   - This returns tickets assigned to me in the current active sprint

3. **Evaluate each ticket and determine next action**

   For each ticket, analyze:

   **Ticket Quality Assessment:**
   - Is the summary clear and descriptive?
   - Is the description detailed enough to implement?
   - Are acceptance criteria defined?
   - Are there technical details or context missing?

   **Readiness Assessment:**
   - Is this ticket ready to be worked on?
   - Are there dependencies or blockers mentioned?
   - Does the priority suggest urgency?

   **Action Decision Matrix:**

   | Ticket State | Action to Take |
   |--------------|----------------|
   | **Poor quality** - Vague summary, missing details, no acceptance criteria | Add JIRA comment requesting clarification. List specific questions about requirements, expected behavior, edge cases, etc. |
   | **Well-defined & ready** - Clear requirements, no blockers, medium/high priority | Create a CoS task to implement the ticket. Include ticket key, summary, and link in the task description. |
   | **Blocked or needs discussion** - Dependencies mentioned, unclear approach, needs architectural decision | Add JIRA comment noting the blocker and suggesting paths forward or requesting input. |
   | **High priority or blocker** - Marked as urgent or blocking other work | Create a CoS task with HIGH priority to address immediately. Consider spawning an agent to start work if well-defined. |
   | **Low priority & well-groomed** - Can wait, already has good details | No immediate action needed. Note in your report for future reference. |

4. **Take actions via API**

   **To add a JIRA comment:**
   ```
   POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments
   Body: { "comment": "Your comment text here" }
   ```

   **To create a CoS task:**
   ```
   POST /api/cos/tasks
   Body: {
     "description": "Implement JIRA-123: Feature name\n\nJIRA: [link]\nDetails: ...",
     "priority": "HIGH|MEDIUM|LOW",
     "taskType": "internal",
     "metadata": {
       "jiraTicket": "JIRA-123",
       "appId": "app-uuid",
       "appName": "App Name"
     }
   }
   ```

5. **Prioritization Guidelines**
   - Handle HIGH priority and Blocker tickets first
   - Group tickets by app for context
   - Focus on tickets that can be moved forward (either by clarifying or implementing)
   - Avoid spending time on low-priority tickets that are already well-groomed

6. **Generate Summary Report**
   - Total tickets reviewed
   - Actions taken per app (comments added, tasks created)
   - Tickets requiring urgent attention
   - Tickets that need human input
   - Tickets ready for implementation

## Expected Outputs

1. **JIRA Comments** - Added to tickets needing clarification or blocked tickets
2. **CoS Tasks** - Created for tickets ready to be implemented
3. **Summary Report** - Saved via CoS reporting system with:
   - Breakdown by app
   - Actions taken
   - Recommendations for next steps

## Success Criteria

- All JIRA-enabled apps are checked
- Every ticket in current sprint is evaluated
- Actionable tickets have CoS tasks created
- Unclear tickets have clarifying comments added
- Report provides clear visibility into ticket status and next steps

## Job Metadata

- **Category**: jira-app-maintenance
- **Interval**: Daily
- **Priority**: MEDIUM
- **Autonomy Level**: manager (can add comments and create tasks autonomously)

## Example Report Structure

```markdown
# JIRA App Maintenance Report - 2026-02-17

## Summary
- Apps reviewed: 3
- Total tickets: 12
- Comments added: 4
- Tasks created: 3
- Urgent items: 2

## App: MyWebApp (PROJ-KEY)
### Tickets Reviewed: 5
- **PROJ-123** (HIGH) - Implement user authentication
  - Action: Created CoS task for implementation
- **PROJ-124** (MEDIUM) - Fix login redirect bug
  - Action: Added comment requesting reproduction steps
- **PROJ-125** (LOW) - Update documentation
  - Action: None - well-defined, low priority

### Urgent Items
- PROJ-123 needs immediate attention (blocker)

## App: APIServer (API-KEY)
### Tickets Reviewed: 7
...

## Recommendations
1. Focus on PROJ-123 (blocker)
2. Follow up on PROJ-124 comment responses
3. Schedule PROJ-125 for next week
```

## Notes

- This job should NOT make code changes directly
- It should NOT commit to repositories
- It focuses on ticket management and task planning
- For implementation work, it creates CoS tasks that spawn separate agents
- Always include JIRA ticket keys and links in created tasks for traceability
