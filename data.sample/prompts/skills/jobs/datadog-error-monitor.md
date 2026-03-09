# DataDog Error Monitor Job

Autonomous job that monitors DataDog for new application errors across all configured apps. Runs daily at 8 AM. Creates CoS tasks for new errors and optionally creates JIRA tickets for apps with JIRA integration enabled.

## Prompt Template

You are acting as my Chief of Staff, monitoring DataDog for new application errors.

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

### Phase 3 — Act on New Errors

3. **Create tasks and tickets for new errors**
   - For each new error:
     - Create a CoS task describing the error, affected app, stack trace, and frequency
     - If the app also has `jira.enabled === true`, create a JIRA ticket:
       ```
       POST /api/jira/instances/:instanceId/tickets
       Body: { "projectKey": "<app.jira.projectKey>", "summary": "DD Error: <error message>", "description": "<full error details>", "issueType": "Bug" }
       ```
     - Update the error cache with the new error fingerprint

### Phase 4 — Report

4. **Generate summary report** covering:
   - Apps checked and error counts per app
   - New errors found and tasks/tickets created
   - Recurring errors that are increasing in frequency
   - Overall error trend (improving or degrading)

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/apps` | GET | List all managed apps |
| `/api/datadog/instances/:id/search-errors` | POST | Search DataDog logs for errors |
| `/api/jira/instances/:id/tickets` | POST | Create JIRA ticket for error |

## Expected Outputs

1. **CoS Tasks** - One per new error discovered
2. **JIRA Tickets** - Created for errors in apps with JIRA enabled
3. **Error Cache Update** - New fingerprints added to prevent duplicate alerts
4. **Summary Report** - Saved via CoS reporting system

## Success Criteria

- All DataDog-enabled apps are checked
- New errors are identified by comparing against cached fingerprints
- CoS tasks created for each new error
- JIRA tickets created where applicable
- Error cache updated with new fingerprints
- Report provides clear visibility into error trends

## Job Metadata

- **Category**: datadog-error-monitor
- **Interval**: Daily at 8:00 AM
- **Priority**: MEDIUM
- **Autonomy Level**: manager (creates tasks and tickets but does not fix errors)
