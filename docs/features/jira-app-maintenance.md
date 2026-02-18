# JIRA App Maintenance Job

Autonomous job that monitors and maintains JIRA tickets for apps with JIRA integration enabled.

## Overview

The JIRA App Maintenance job proactively manages JIRA tickets across all managed apps that have JIRA integration configured. It runs on a daily schedule (configurable) and evaluates each ticket assigned to you in the current sprint to determine appropriate actions.

## How It Works

### 1. Discovery Phase
- Scans all registered apps in PortOS
- Identifies apps with JIRA integration enabled (`jira.enabled === true`)
- Collects JIRA instance ID and project key for each app

### 2. Ticket Retrieval
For each JIRA-enabled app:
- Fetches tickets assigned to the current user in active sprint
- Uses the JIRA API endpoint: `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey`

### 3. Evaluation & Action
Each ticket is evaluated against quality and readiness criteria:

#### Ticket Quality Assessment
- **Summary clarity**: Is the title descriptive?
- **Description completeness**: Are requirements detailed?
- **Acceptance criteria**: Are success conditions defined?
- **Technical details**: Is context provided?

#### Action Decision Matrix

| Ticket State | Automated Action |
|--------------|------------------|
| **Poor Quality** | Add JIRA comment requesting clarification with specific questions |
| **Well-Defined & Ready** | Create CoS task to implement the ticket |
| **Blocked** | Add JIRA comment noting blocker and suggesting resolution paths |
| **High Priority/Blocker** | Create HIGH priority CoS task for immediate attention |
| **Low Priority & Well-Groomed** | No action (noted in report for future reference) |

### 4. Actions Taken

**JIRA Comments** - Added to tickets needing:
- Clarification of requirements
- Additional technical details
- Discussion of blockers
- Architectural decisions

**CoS Tasks** - Created for tickets that are:
- Well-defined and ready to implement
- High priority or blocking other work
- Have clear acceptance criteria

**Report Generation** - Comprehensive summary including:
- Total tickets reviewed per app
- Actions taken (comments, tasks created)
- Urgent items requiring attention
- Recommendations for next steps

## Configuration

### Enabling the Job

1. Navigate to Chief of Staff → Jobs tab
2. Find "JIRA App Maintenance" in the list
3. Click the toggle to enable
4. Configure schedule (default: daily)

### Job Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Interval | Daily | How often the job runs |
| Priority | MEDIUM | Task priority for created work items |
| Autonomy Level | manager | Can add comments and create tasks without approval |
| Enabled | false | Must be manually enabled |

### App-Level JIRA Configuration

For each app you want monitored, configure JIRA integration:

1. Go to Apps page
2. Edit the app
3. Enable JIRA integration
4. Select JIRA instance
5. Enter project key (e.g., "PROJ")
6. Save

Example app configuration:
```json
{
  "name": "My Web App",
  "jira": {
    "enabled": true,
    "instanceId": "company-jira",
    "projectKey": "WEBAPP"
  }
}
```

## API Endpoints Used

### Apps API
- `GET /api/apps` - List all registered apps

### JIRA API
- `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey` - Get sprint tickets
- `POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments` - Add comment

### CoS API
- `POST /api/cos/tasks` - Create task

## Example Workflow

### Scenario: Poor Quality Ticket

**Ticket**: PROJ-123 - "Fix login"
- No description
- No acceptance criteria
- No priority

**Action**: Adds JIRA comment
```
Hi! I'm reviewing sprint tickets and need more information about PROJ-123:

1. What specific login issue is occurring? (Error message, behavior, etc.)
2. Which login flow is affected? (username/password, SSO, OAuth, etc.)
3. What is the expected behavior?
4. Are there steps to reproduce?
5. What acceptance criteria should be met for this fix?

Please update the ticket description with these details so I can prioritize implementation.
```

### Scenario: Well-Defined Ticket

**Ticket**: PROJ-124 - "Add password reset flow"
- Detailed requirements in description
- Clear acceptance criteria
- Medium priority

**Action**: Creates CoS task
```markdown
Implement JIRA-124: Add password reset flow

JIRA: https://company.atlassian.net/browse/PROJ-124
Project: My Web App
Priority: MEDIUM

Requirements:
- Add "Forgot Password?" link on login page
- Email reset link (expires in 1 hour)
- Validate token on reset page
- Update password with confirmation

Acceptance Criteria:
- User receives email within 1 minute
- Link expires after 1 hour
- Invalid/expired tokens show error
- Password meets security requirements
- Success redirects to login
```

### Scenario: High Priority Blocker

**Ticket**: PROJ-125 - "Production API failing"
- Clear description
- CRITICAL priority
- Marked as blocker

**Action**: Creates HIGH priority CoS task
```markdown
🚨 URGENT - Implement JIRA-125: Fix production API failure

JIRA: https://company.atlassian.net/browse/PROJ-125
Project: API Server
Priority: HIGH (BLOCKER)

Issue: Payment processing endpoint returning 500 errors
Impact: Blocking customer transactions
Details: [From JIRA description]

This task requires immediate attention - marked as blocker in sprint.
```

## Report Format

The job generates a structured report after each run:

```markdown
# JIRA App Maintenance Report - 2026-02-17

## Summary
- Apps reviewed: 3
- Total tickets: 12
- Comments added: 4
- Tasks created: 3
- Urgent items: 2

## App: MyWebApp (PROJ)
### Tickets Reviewed: 5

**PROJ-123** (HIGH) - Implement user authentication
- Status: To Do
- Action: ✅ Created CoS task for implementation
- Notes: Well-defined, ready to start

**PROJ-124** (MEDIUM) - Fix login redirect bug
- Status: In Progress
- Action: 💬 Added comment requesting reproduction steps
- Notes: Missing technical details

**PROJ-125** (LOW) - Update documentation
- Status: To Do
- Action: None - well-defined, low priority
- Notes: Can be addressed later

### Urgent Items
- PROJ-123 (HIGH) - Ready for immediate implementation

## App: APIServer (API)
### Tickets Reviewed: 7
[...]

## Recommendations
1. Focus on PROJ-123 (high priority, ready to implement)
2. Follow up on PROJ-124 comment responses
3. Schedule PROJ-125 for next sprint planning
```

## Limitations & Best Practices

### What the Job Does NOT Do
- ❌ Does not make code changes directly
- ❌ Does not commit to repositories
- ❌ Does not modify JIRA ticket fields (only adds comments)
- ❌ Does not create JIRA tickets

### What the Job DOES Do
- ✅ Evaluates ticket quality
- ✅ Adds clarifying comments
- ✅ Creates CoS tasks for implementation
- ✅ Prioritizes urgent work
- ✅ Generates actionable reports

### Best Practices

1. **Keep JIRA Integration Updated**
   - Ensure project keys are correct
   - Verify JIRA instance credentials are valid
   - Archive apps you no longer maintain

2. **Review Reports Regularly**
   - Check daily reports for urgent items
   - Respond to JIRA comments the job adds
   - Approve or adjust created CoS tasks

3. **Tune for Your Workflow**
   - Adjust job frequency (daily, twice-daily, etc.)
   - Set appropriate priority thresholds
   - Customize the skill template for your team's conventions

4. **Provide Feedback**
   - If the job creates incorrect comments, improve ticket templates
   - If tasks are poorly formatted, update the skill template
   - Use CoS learning system to improve over time

## Skill Template

The job uses a skill template at:
```
data/prompts/skills/jobs/jira-app-maintenance.md
```

You can customize this template to:
- Change evaluation criteria
- Adjust comment templates
- Modify prioritization logic
- Add team-specific conventions

## Troubleshooting

### Job Runs But No Actions Taken

**Possible causes:**
1. No apps have JIRA integration enabled
2. No tickets assigned to you in current sprint
3. All tickets are low priority and well-defined

**Solution:** Check the job report for details on what was evaluated.

### JIRA API Errors

**Possible causes:**
1. Invalid JIRA credentials
2. Project key doesn't exist
3. User doesn't have permissions

**Solution:**
- Test JIRA connection from JIRA settings page
- Verify project key is correct
- Ensure API token has required permissions

### Created Tasks Are Poorly Formatted

**Possible causes:**
1. JIRA tickets have inconsistent structure
2. Skill template needs tuning

**Solution:**
- Standardize JIRA ticket templates
- Edit `data/prompts/skills/jobs/jira-app-maintenance.md`
- Add examples for your specific project types

### Too Many Comments Being Added

**Possible causes:**
1. Ticket quality in JIRA is generally poor
2. Evaluation criteria too strict

**Solution:**
- Improve ticket creation process
- Add ticket templates in JIRA
- Adjust skill template evaluation logic

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Core autonomous agent system
- [Autonomous Jobs](./autonomous-jobs.md) - Recurring job scheduler
- [Task Management](./task-management.md) - CoS task system
- [JIRA Integration](./jira-integration.md) - JIRA API setup

## Future Enhancements

Potential improvements for future versions:

1. **Smart Ticket Assignment** - Auto-assign tickets based on expertise
2. **Sprint Planning Assistant** - Help estimate and allocate sprint work
3. **Dependency Detection** - Identify blocking relationships between tickets
4. **Auto-Grooming** - Suggest improvements to ticket descriptions
5. **Metrics Dashboard** - Track ticket velocity and quality over time
6. **Multi-Sprint Planning** - Look ahead to backlog for proactive grooming
