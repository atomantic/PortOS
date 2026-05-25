# Chief of Staff Daily Report

Generate a summary report of today's work.

## Date: {{date}}

## Agent Activity
{{#agents}}
### {{id}}
- **Task**: {{taskId}} - {{taskDescription}}
- **Status**: {{status}}
- **Duration**: {{duration}}ms
- **Result**: {{result.success}}
{{/agents}}
{{^agents}}
No agents ran today.
{{/agents}}

## Tasks Completed
{{#completedTasks}}
- **{{id}}**: {{description}}
{{/completedTasks}}
{{^completedTasks}}
No tasks completed today.
{{/completedTasks}}

## Health Status
- Last Check: {{lastHealthCheck}}
{{#healthIssues}}
- [{{type}}] {{message}}
{{/healthIssues}}
{{^healthIssues}}
- No issues detected
{{/healthIssues}}

## Instructions

Generate a brief, human-readable summary of the day's work including:
1. Total tasks attempted and completed
2. Any failures or blockers encountered
3. System health observations
4. Recommendations for tomorrow

Keep the summary concise but informative.
