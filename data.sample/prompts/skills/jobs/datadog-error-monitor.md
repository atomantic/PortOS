# DataDog Error Monitor Job

Autonomous job that monitors DataDog for new application errors across all configured apps. Runs daily at 8 AM. Creates JIRA tickets for new errors and queues CoS sub-agent fix tasks.

## Prompt Template

You are acting as my Chief of Staff, monitoring DataDog for new application errors and orchestrating fixes.

## Steps

### Phase 1 — Discover

1. **Find DataDog-enabled apps**
   - Call `GET /api/apps` to get all managed apps
   - Filter for apps where `datadog.enabled === true` and both `datadog.instanceId` and `datadog.serviceName` are set
   - Skip archived apps

### Phase 2 — Check Errors

2. **Search for errors in each app**
   - For each DataDog-enabled app, call:
     ```
     POST /api/datadog/instances/:instanceId/search-errors
     Body: { "serviceName": "<app.datadog.serviceName>", "environment": "<app.datadog.environment>", "fromTime": "<24h ago ISO>" }
     ```
   - Compare results against the error cache in `/data/cos/datadog-errors.json`
   - Identify new errors by fingerprint or message hash
   - Group duplicate errors by message similarity

### Phase 3 — File Issues and Queue Fixes

3. **Update the error cache**
   - For each genuinely new error (regardless of JIRA config), add its fingerprint to `/data/cos/datadog-errors.json`

4. **Create JIRA tickets for new errors** (only if fully configured)
   - For each new error where the app has `jira.enabled === true` AND `jira.instanceId` AND `jira.projectKey` are set:
     - Create a JIRA ticket:
       ```
       POST /api/jira/instances/:instanceId/tickets
       Body: {
         "projectKey": "<app.jira.projectKey>",
         "summary": "DD Error: <concise error message>",
         "description": "<full error details including stack trace, frequency, first/last seen>",
         "issueType": "Bug",
         "labels": ["datadog-auto", "cos-detected"]
       }
       ```
   - Skip JIRA ticket creation if `instanceId` or `projectKey` is missing

5. **Create CoS fix tasks**
   - For each new error, create a CoS task that will:
     - Work in an isolated worktree of the app's repo
     - Analyze the error stack trace and identify the root cause
     - Implement a fix
     - Run tests to verify the fix
     - Open a PR with the fix
   - Task configuration:
     ```
     POST /api/cos/tasks
     Body: {
       "description": "[Auto-Fix] DD Error in <app.name>: <error message>\n\nJIRA: <ticket key if created>\nStack trace: <stack>\n\nInstructions:\n1. Clone/worktree the repo at <app.repoPath>\n2. Analyze the error and identify root cause\n3. Implement a fix\n4. Run tests\n5. Open a PR referencing the JIRA ticket (if one was created)",
       "priority": "HIGH",
       "type": "internal",
       "app": "<app.id>",
       "useWorktree": true,
       "openPR": true
     }
     ```

### Phase 4 — Report

6. **Generate summary report** covering:
   - Apps checked and error counts per app
   - New errors found vs. already-known errors
   - JIRA tickets created
   - CoS fix tasks queued
   - Recurring errors that are increasing in frequency
   - Overall error trend (improving or degrading)

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/apps` | GET | List all managed apps |
| `/api/datadog/instances/:id/search-errors` | POST | Search DataDog logs for errors |
| `/api/jira/instances/:id/tickets` | POST | Create JIRA ticket for error |
| `/api/cos/tasks` | POST | Create CoS fix task |

## Expected Outputs

1. **JIRA Tickets** - Created for genuinely new errors (not duplicates)
2. **CoS Fix Tasks** - One per new error, configured with worktree isolation and PR creation
3. **Error Cache Update** - New fingerprints added to prevent duplicate alerts
4. **Summary Report** - Saved via CoS reporting system

## Success Criteria

- All DataDog-enabled apps are checked
- New errors are identified by comparing against cached fingerprints
- JIRA tickets created where applicable with `datadog-auto` label
- CoS fix tasks queued with full context (stack trace, JIRA ref, worktree instructions)
- Error cache updated with new fingerprints
- Report provides clear visibility into error trends and actions taken

## Job Metadata

- **Category**: datadog-error-monitor
- **Interval**: Daily at 8:00 AM
- **Priority**: MEDIUM
- **Autonomy Level**: manager (creates tickets and tasks, does not directly fix errors)
