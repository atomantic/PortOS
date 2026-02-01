# Brain Second-Brain System

Offline-first "second brain" management system for capturing, classifying, and surfacing thoughts.

## Overview

Brain provides a capture-classify-store-surface workflow:

1. **Capture**: Dump thoughts into a single inbox
2. **Classify**: AI routes thoughts to appropriate databases
3. **Store**: Persist to People, Projects, Ideas, or Admin
4. **Surface**: Daily digests and weekly reviews

## Features

1. **Chat-like Inbox**: Single input for capturing thoughts
2. **AI Classification**: LM Studio classifies with confidence scores
3. **Four Databases**: People, Projects, Ideas, Admin
4. **Needs Review Queue**: Low-confidence items await user decision
5. **Fix/Correct Flow**: Reclassify misrouted thoughts
6. **Daily Digest**: AI-generated summary of actions and status
7. **Weekly Review**: GTD-style open loops and accomplishments
8. **Trust Panel**: Full audit trail of classifications

## Databases

### People

Track individuals with:
- Contact info
- Last interaction date
- Topics discussed
- Follow-up actions
- Relationship context

### Projects

Manage projects with:
- Status (active, planned, on-hold, completed)
- Goals and objectives
- Next actions
- Deadlines
- Related people

### Ideas

Capture ideas with:
- Category (product, content, business, tech)
- Maturity (raw, explored, validated, implemented)
- Related projects or people
- Evaluation notes

### Admin

Track administrative tasks:
- Due dates
- Priority
- Status
- Related people or projects
- Completion notes

## Data Storage

```
./data/brain/
├── meta.json           # Settings and scheduler state
├── inbox_log.jsonl     # All captured thoughts with classifications
├── people.jsonl        # People records
├── projects.jsonl      # Projects with status tracking
├── ideas.jsonl         # Ideas and concepts
├── admin.jsonl         # Administrative tasks
├── digests.jsonl       # Daily digest history
└── reviews.jsonl       # Weekly review history
```

## AI Classification

The classifier uses LM Studio to analyze captured thoughts and:

- Determine the appropriate database (People, Projects, Ideas, Admin)
- Extract structured data (names, dates, priorities, etc.)
- Calculate confidence score (0.0-1.0)
- Provide reasoning for classification decision

### Confidence Levels

- **High (≥0.8)**: Auto-routed to database
- **Medium (0.5-0.8)**: Suggested route, user can confirm or change
- **Low (<0.5)**: Marked "needs review", user must choose

## Daily Digest

Generated daily (configurable schedule):

- Summary of captured thoughts
- Actions taken
- Projects with recent activity
- People interacted with
- Admin items due soon
- Ideas ready for next steps

## Weekly Review

Generated weekly (GTD-style):

- Open loops by database
- Accomplishments
- Projects to review
- People to follow up with
- Ideas to explore
- Admin items to address

## API Endpoints

| Route | Description |
|-------|-------------|
| POST /api/brain/capture | Capture and classify thought |
| GET /api/brain/inbox | List inbox log with filters |
| POST /api/brain/review/resolve | Resolve needs_review item |
| POST /api/brain/fix | Correct misclassified item |
| GET/POST/PUT/DELETE /api/brain/people/:id? | People CRUD |
| GET/POST/PUT/DELETE /api/brain/projects/:id? | Projects CRUD |
| GET/POST/PUT/DELETE /api/brain/ideas/:id? | Ideas CRUD |
| GET/POST/PUT/DELETE /api/brain/admin/:id? | Admin CRUD |
| GET /api/brain/digest/latest | Get latest daily digest |
| GET /api/brain/review/latest | Get latest weekly review |
| POST /api/brain/digest/run | Trigger daily digest |
| POST /api/brain/review/run | Trigger weekly review |
| GET/PUT /api/brain/settings | Get/update settings |

## Prompt Templates

| Template | Purpose |
|----------|---------|
| brain-classifier | Classify captured thoughts |
| brain-daily-digest | Generate daily summary |
| brain-weekly-review | Generate weekly review |

## UI Tabs

- **Inbox**: Chat-like capture interface with classification results
- **Memory**: CRUD views for People, Projects, Ideas, Admin
- **Digest**: Daily and weekly summaries with run buttons
- **Trust**: Audit trail with classification confidence and reasoning

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/brainValidation.js` | Zod schemas for all Brain entities |
| `server/services/brain.js` | Core business logic |
| `server/services/brainStorage.js` | JSONL/JSON file operations |
| `server/services/brainScheduler.js` | Daily/weekly job scheduler |
| `server/routes/brain.js` | API endpoints |
| `client/src/pages/Brain.jsx` | Main page with tabs |
| `client/src/components/brain/tabs/*.jsx` | Tab components |
| `data/prompts/stages/brain-*.md` | Prompt templates |

## Setup Requirements

**LM Studio** must be running with a capable chat model:

1. Download and install [LM Studio](https://lmstudio.ai/)
2. Load a chat model (e.g., gptoss-20b, qwen-2.5, etc.)
3. Start the local server on port 1234 (default)
4. Configure the Brain system to use the model

## Configuration

```javascript
brain: {
  enabled: true,
  provider: 'lmstudio',
  endpoint: 'http://localhost:1234/v1/chat/completions',
  model: 'gptoss-20b',
  minConfidence: 0.5,
  digestSchedule: '0 18 * * *',  // Daily at 6pm
  reviewSchedule: '0 9 * * 0'    // Weekly on Sunday at 9am
}
```

## Workflow Example

```
1. User captures: "Met with Sarah about the new project. Need to follow up next week."

2. AI classifies:
   - Database: People + Projects
   - Confidence: 0.85
   - Reasoning: "Mentions person (Sarah) and project context with action item"

3. System creates:
   - Person record: "Sarah" with last interaction today
   - Project record: "New project" with status "planned"
   - Admin task: "Follow up with Sarah" due next week

4. Daily digest includes:
   - "New person added: Sarah"
   - "New project started: New project"
   - "Action due: Follow up with Sarah"

5. Weekly review shows:
   - Open loop: "New project (planned) - needs next actions"
   - Follow-up needed: "Sarah - follow up scheduled"
```

## Related Features

- [Memory System](./memory-system.md)
- [Chief of Staff](./chief-of-staff.md)
