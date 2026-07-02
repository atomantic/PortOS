# JIRA Sprint Manager Job

Scheduled task that triages and implements JIRA tickets for apps with JIRA integration enabled. Combines triage (reviewing, commenting, prioritizing) with implementation (worktree, PR, JIRA transition) in a single daily run.

## Overview

The JIRA Sprint Manager is a daily task in the Schedule system (defined in `server/services/taskSchedule.js`), disabled by default. When enabled, it first triages all sprint tickets across JIRA-enabled apps, then implements the highest-priority ready ticket.

## How It Works

### Phase 1 — Triage

1. **Discovery**: Scans all registered apps for JIRA integration (`jira.enabled === true`)
2. **Ticket Retrieval**: Fetches sprint tickets via `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey`
3. **Evaluation**: Each ticket is assessed for quality and readiness:

| Ticket State | Action |
|--------------|--------|
| **Poor Quality** | Add JIRA comment requesting clarification |
| **Blocked** | Add JIRA comment noting blocker and suggesting resolution |
| **Well-Defined & Ready** | Mark as implementation candidate |
| **High Priority/Blocker** | Prioritize for immediate implementation |
| **Low Priority & Well-Groomed** | No action (noted in report) |

### Phase 2 — Implement

4. **Selection**: Picks the highest-priority "To Do"/"Ready" ticket with clear requirements
5. **Worktree**: Creates an isolated git worktree for the implementation
6. **Implementation**: Codes the feature/fix following project conventions
7. **PR Creation**: Commits, pushes, and creates a merge request
8. **JIRA Update**: Transitions ticket to "In Review" and adds PR link as comment

### Phase 3 — Report

9. **Summary**: Generates a report covering triage actions and implementation work

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Interval | Daily at 09:00 | Weekdays only |
| Priority | HIGH | Job priority |
| Autonomy Level | yolo | Fully autonomous |
| Enabled | false | Disabled by default |

### App-Level JIRA Configuration

For each app to be monitored, enable JIRA integration in the app settings:
```json
{
  "jira": {
    "enabled": true,
    "instanceId": "company-jira",
    "projectKey": "WEBAPP"
  }
}
```

## API Endpoints Used

- `GET /api/apps` — List all registered apps
- `GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey` — Get sprint tickets
- `POST /api/jira/instances/:instanceId/tickets/:ticketKey/comments` — Add comment
- `GET /api/jira/instances/:instanceId/tickets/:ticketKey/transitions` — Get transitions
- `POST /api/jira/instances/:instanceId/tickets/:ticketKey/transition` — Transition ticket
- `POST /api/cos/tasks` — Create CoS task

## Skill Template

Customizable at: `data/prompts/skills/jobs/jira-sprint-manager.md`

## Related Features

- [Chief of Staff](./chief-of-staff.md) — Core autonomous agent system
