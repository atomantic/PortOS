# Brain Feature Implementation Plan

> **Offline-first "second brain" management system for PortOS**

## Overview

Brain is a capture-classify-store-surface system that lets users dump thoughts into a single inbox, then AI classifies and routes them to appropriate databases (People, Projects, Ideas, Admin). Daily digests and weekly reviews surface actionable insights.

**Core workflow**: capture -> classify/route -> store -> daily digest -> weekly review -> fix/correct

## Architecture

```
Client (React)                    Server (Express)                   Storage (./data/brain/)
----------------                  -----------------                  ---------------------
/brain/:tab                       /api/brain/*                       meta.json
  - Inbox (chat-like)               - capture                        inbox_log.jsonl
  - Memory (CRUD views)             - CRUD (people/projects/etc)     people.jsonl
  - Digest & Review                 - digest/review                  projects.jsonl
  - Trust Panel (audit)             - settings                       ideas.jsonl
                                                                     admin.jsonl
                                                                     digests.jsonl
                                                                     reviews.jsonl
```

## Implementation Phases

### Phase 1: Data Layer & Schemas

**Files to create:**
- `server/lib/brainValidation.js` - Zod schemas for all Brain entities
- `server/services/brainStorage.js` - JSONL file operations
- `data.sample/brain/` - Sample data directory with all files

**Schemas:**

```javascript
// InboxLogRecord
{
  id: string (UUID),
  capturedText: string,
  capturedAt: string (ISO),
  source: "brain_ui",
  ai: { providerId, modelId, promptTemplateId, temperature?, maxTokens? },
  classification: {
    destination: "people" | "projects" | "ideas" | "admin" | "unknown",
    confidence: number (0-1),
    title: string,
    extracted: object,
    reasons?: string[]
  },
  status: "filed" | "needs_review" | "corrected" | "error",
  filed?: { destination, destinationId },
  correction?: { correctedAt, previousDestination, newDestination, note? },
  error?: { message, stack? }
}

// PeopleRecord
{ id, name, context, followUps: [], lastTouched?, tags?, createdAt, updatedAt }

// ProjectRecord
{ id, name, status: "active"|"waiting"|"blocked"|"someday"|"done",
  nextAction, notes?, tags?, createdAt, updatedAt }

// IdeaRecord
{ id, title, oneLiner, notes?, tags?, createdAt, updatedAt }

// AdminRecord
{ id, title, status: "open"|"waiting"|"done", dueDate?, nextAction?,
  notes?, createdAt, updatedAt }

// meta.json
{
  version: 1,
  confidenceThreshold: 0.6,
  dailyDigestTime: "09:00",
  weeklyReviewTime: "16:00",
  weeklyReviewDay: "sunday",
  defaultProvider: "lmstudio",
  defaultModel: "gptoss-20b"
}
```

**Storage pattern (from existing codebase):**
- Use atomic file rewrites with in-memory caching (TTL ~2s)
- JSONL for append-heavy logs (inbox_log, digests, reviews)
- JSON objects for entity stores (people, projects, ideas, admin)
- `ensureDataDir()` before all file operations
- UUID for all record IDs, ISO strings for timestamps

---

### Phase 2: API Endpoints

**File to create:** `server/routes/brain.js`

**Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/brain/capture` | Capture thought, classify, store |
| GET | `/api/brain/inbox` | List inbox log (filters: status, limit, offset) |
| POST | `/api/brain/review/resolve` | Resolve needs_review item |
| POST | `/api/brain/fix` | Correct misclassified item |
| GET/POST/PUT/DELETE | `/api/brain/people/:id?` | People CRUD |
| GET/POST/PUT/DELETE | `/api/brain/projects/:id?` | Projects CRUD |
| GET/POST/PUT/DELETE | `/api/brain/ideas/:id?` | Ideas CRUD |
| GET/POST/PUT/DELETE | `/api/brain/admin/:id?` | Admin CRUD |
| GET | `/api/brain/digest/latest` | Get latest daily digest |
| GET | `/api/brain/review/latest` | Get latest weekly review |
| POST | `/api/brain/digest/run` | Manual trigger digest |
| POST | `/api/brain/review/run` | Manual trigger review |
| GET/PUT | `/api/brain/settings` | Get/update Brain settings |

**Capture flow (POST /api/brain/capture):**
1. Validate input with Zod
2. Create InboxLogRecord immediately (status: pending)
3. Call AI classifier with `capturedText`
4. Parse JSON response, validate structure
5. If `confidence >= threshold` and destination != "unknown":
   - Create record in destination DB
   - Update InboxLogRecord: status="filed", filed={...}
6. If low confidence or unknown:
   - Update InboxLogRecord: status="needs_review"
7. Return InboxLogRecord + UI message

**Error handling:** Use `asyncHandler()` wrapper, throw `ServerError` for validation/processing errors. If AI unavailable, set status="needs_review" with destination="unknown".

---

### Phase 3: AI Prompt Templates

**Files to create:**
- `data/prompts/stages/brain-classifier.md`
- `data/prompts/stages/brain-daily-digest.md`
- `data/prompts/stages/brain-weekly-review.md`
- Update `data/prompts/stage-config.json` with new stages

**Stage configurations:**
```json
{
  "brain-classifier": {
    "name": "Brain Classifier",
    "description": "Classify captured thoughts into People/Projects/Ideas/Admin",
    "model": "lmstudio:gptoss-20b",
    "provider": "lmstudio",
    "returnsJson": true,
    "variables": []
  },
  "brain-daily-digest": {
    "name": "Brain Daily Digest",
    "description": "Generate daily actionable digest",
    "model": "lmstudio:gptoss-20b",
    "provider": "lmstudio",
    "returnsJson": true,
    "variables": []
  },
  "brain-weekly-review": {
    "name": "Brain Weekly Review",
    "description": "Generate weekly review and open loops",
    "model": "lmstudio:gptoss-20b",
    "provider": "lmstudio",
    "returnsJson": true,
    "variables": []
  }
}
```

**Classifier prompt output schema:**
```json
{
  "destination": "people|projects|ideas|admin|unknown",
  "confidence": 0.0-1.0,
  "title": "Short title",
  "extracted": { /* destination-specific fields */ },
  "reasons": ["reason1", "reason2"]
}
```

**Daily digest output schema:**
```json
{
  "digestText": "< 150 words",
  "topActions": ["action1", "action2", "action3"],
  "stuckThing": "One stuck item",
  "smallWin": "One positive thing"
}
```

**Weekly review output schema:**
```json
{
  "reviewText": "< 250 words",
  "whatHappened": ["bullet1", "bullet2"],
  "biggestOpenLoops": ["loop1", "loop2"],
  "suggestedActionsNextWeek": ["action1", "action2"],
  "recurringTheme": "One sentence pattern"
}
```

---

### Phase 4: Brain Service & Scheduler

**Files to create:**
- `server/services/brain.js` - Core business logic
- `server/services/brainScheduler.js` - Daily/weekly job scheduler

**Service functions:**
```javascript
// Core
export async function captureThought(text, providerOverride?, modelOverride?)
export async function resolveReview(inboxLogId, destination, editedExtracted?)
export async function fixClassification(inboxLogId, newDestination, updatedFields?)

// CRUD (for each entity type)
export async function getPeople(filters?)
export async function createPerson(data)
export async function updatePerson(id, data)
export async function deletePerson(id)
// ... same pattern for projects, ideas, admin

// Digest/Review
export async function runDailyDigest()
export async function runWeeklyReview()
export async function getLatestDigest()
export async function getLatestReview()

// Settings
export async function getSettings()
export async function updateSettings(updates)
```

**Scheduler (adapt from taskSchedule.js pattern):**
- Start scheduler on server boot
- Check configured times against current time
- Run daily digest at configured time (default 9:00 AM)
- Run weekly review at configured day/time (default Sunday 4:00 PM)
- Handle catch-up: if server was down, run at most 1 missed job per type
- Store last run timestamps in meta.json

```javascript
// brainScheduler.js
let schedulerInterval = null;

export function startScheduler() {
  schedulerInterval = setInterval(checkSchedule, 60000); // Check every minute
  checkSchedule(); // Run immediately on start
}

export function stopScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
}

async function checkSchedule() {
  const settings = await getSettings();
  const now = new Date();
  // Check if daily digest is due
  // Check if weekly review is due
  // Handle missed runs (max 1 catch-up per type)
}
```

**AI call pattern (from existing memoryClassifier.js):**
```javascript
async function callAI(stageName, variables) {
  const provider = await getActiveProvider();
  const prompt = await buildPrompt(stageName, variables);

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  });

  const data = await response.json();
  return parseJsonResponse(data.choices?.[0]?.message?.content);
}

function parseJsonResponse(content) {
  // Remove markdown code blocks
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error('No JSON found in response');
  return JSON.parse(jsonMatch[1]);
}
```

---

### Phase 5: React UI

**Files to create:**
- `client/src/pages/Brain.jsx` - Main page with tab routing
- `client/src/components/brain/index.js` - Re-exports
- `client/src/components/brain/constants.js` - Tabs, states, colors
- `client/src/components/brain/tabs/InboxTab.jsx` - Chat-like capture
- `client/src/components/brain/tabs/MemoryTab.jsx` - CRUD views
- `client/src/components/brain/tabs/DigestTab.jsx` - Digest & Review
- `client/src/components/brain/tabs/TrustTab.jsx` - Audit trail

**Update existing files:**
- `client/src/App.jsx` - Add route `/brain/:tab`
- `client/src/components/Layout.jsx` - Add Brain to nav
- `client/src/services/api.js` - Add Brain API functions

**Brain.jsx structure (follow ChiefOfStaff.jsx pattern):**
```jsx
import { useParams, useNavigate } from 'react-router-dom';

const TABS = [
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'trust', label: 'Trust', icon: Shield }
];

export default function Brain() {
  const { tab = 'inbox' } = useParams();
  const navigate = useNavigate();

  // Fetch data, handle socket events

  return (
    <div className="flex flex-col h-full">
      {/* Tab navigation */}
      {/* Tab content based on tab param */}
    </div>
  );
}
```

**InboxTab.jsx (chat-like UI):**
- Single input field at bottom ("One thought at a time...")
- Message list showing: capturedText, destination badge, confidence, status, timestamp
- For filed items: link to view record
- For needs_review: inline destination picker + "Reclassify" button
- "Fix" button on each filed item for corrections

**MemoryTab.jsx:**
- Sub-tabs: People | Projects | Ideas | Admin | Needs Review
- Each sub-tab: list view with filters + basic CRUD
- Projects: filter by status (active/waiting/blocked/someday/done)
- Admin: filter by status + sort by due date
- Inline edit or modal edit for records

**DigestTab.jsx:**
- Latest daily digest (rendered markdown-like)
- Latest weekly review
- History list (collapsible)
- "Run Now" buttons for manual trigger

**TrustTab.jsx:**
- Full inbox log with filters (status, date range, confidence range)
- Expandable rows showing full classification JSON
- Debug view for AI responses

---

### Phase 6: Sample Data & Tests

**Sample data files (./data.sample/brain/):**
- `meta.json` - Default settings
- `inbox_log.jsonl` - 10-15 sample entries (mix of statuses)
- `people.jsonl` - 5 sample people
- `projects.jsonl` - 5 sample projects (various statuses)
- `ideas.jsonl` - 3 sample ideas
- `admin.jsonl` - 3 sample admin items
- `digests.jsonl` - 2 sample digests
- `reviews.jsonl` - 1 sample review

**Tests (./server/tests/brain.test.js):**
- Capture creates InboxLogRecord always
- Confidence threshold gates filing
- Fix/move updates records correctly
- Digest word limit enforced
- Review word limit enforced
- CRUD operations work for all entity types
- Settings update persists

---

## File Tree Summary

```
server/
  lib/
    brainValidation.js           # Zod schemas
  services/
    brain.js                     # Core business logic
    brainStorage.js              # JSONL/JSON file operations
    brainScheduler.js            # Daily/weekly scheduler
  routes/
    brain.js                     # API endpoints
  tests/
    brain.test.js                # Unit tests

client/src/
  pages/
    Brain.jsx                    # Main page
  components/
    brain/
      index.js                   # Re-exports
      constants.js               # TABS, states
      tabs/
        InboxTab.jsx
        MemoryTab.jsx
        DigestTab.jsx
        TrustTab.jsx
  services/
    api.js                       # Add brain endpoints

data/prompts/stages/
  brain-classifier.md
  brain-daily-digest.md
  brain-weekly-review.md

data.sample/brain/
  meta.json
  inbox_log.jsonl
  people.jsonl
  projects.jsonl
  ideas.jsonl
  admin.jsonl
  digests.jsonl
  reviews.jsonl
```

---

## Verification Plan

1. **Data layer**: Create sample data, verify file read/write
2. **API**: Test each endpoint with curl/Postman
3. **AI integration**: Test classifier with sample inputs, verify JSON parsing
4. **UI**: Navigate to /brain, verify all tabs render
5. **End-to-end capture flow**:
   - Enter thought in inbox
   - Verify classification + filing
   - Check record appears in Memory tab
   - Check inbox log shows entry
6. **Fix flow**: Correct a misclassified item, verify both records update
7. **Needs review flow**: Submit low-confidence item, resolve via UI
8. **Digest**: Run manual digest, verify output < 150 words
9. **Review**: Run manual review, verify output < 250 words
10. **Scheduler**: Verify jobs run at configured times (or test with short intervals)
11. **Offline resilience**: Stop LM Studio, capture thought, verify queued for later

---

## Implementation Order

1. Data layer (schemas + storage)
2. API endpoints (capture + CRUD)
3. AI prompt templates
4. Brain service (classification logic)
5. Scheduler
6. React UI (Inbox tab first)
7. Remaining UI tabs
8. Sample data
9. Tests

---

## Key Decisions

- **JSONL for append-heavy data**: inbox_log, digests, reviews use JSONL for easy appending and diffing
- **JSON objects for entities**: people/projects/ideas/admin use JSON objects keyed by ID for efficient lookups
- **Confidence threshold 0.6**: Default, configurable in settings
- **No try/catch**: Per CLAUDE.md, errors bubble to asyncHandler middleware
- **URL-based tabs**: `/brain/:tab` for deep linking (follow CoS pattern)
- **Default to LM Studio**: Use `lmstudio:gptoss-20b` as default provider/model
- **Word limits enforced server-side**: Truncate or request re-generation if AI exceeds limits
