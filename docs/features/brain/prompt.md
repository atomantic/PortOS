You are an AI coding agent implementing a new PortOS feature called **Brain**: an offline-first “second brain” management + communication system.

# 0) Core problem + product intent
Human brains are for thinking, not storage. Forgetting creates hidden taxes: dropped relationship details, repeated project failures, and constant open-loop anxiety. The goal is a system that lets the user capture thoughts in seconds, then the system actively processes those thoughts in the background: classifies, routes, structures, stores, and proactively surfaces what matters—without the user having to remember to organize or retrieve anything.

This is not “a notes app.” It is a behavior-changing loop:
capture → classify/route → store → surface daily → review weekly → correct easily → maintain trust.

# 1) Non-negotiable design principles (implement as requirements)
1) **One reliable human behavior**: the user does only one thing consistently—capture a thought in a single Inbox UI. No tagging, folders, taxonomy decisions at capture time.

2) **Separate Interface / Compute / Memory**
- Interface: Brain page UI (chat-like capture + dashboards).
- Compute: local server endpoints + scheduled local jobs + AI calls.
- Memory: local storage files as source-of-truth.

3) **Treat prompts like APIs**: fixed input + fixed output JSON schemas. The model must output JSON only (no markdown, no prose). Reliability beats creativity.

4) **Trust mechanisms**: always log what happened (audit trail), include confidence, make errors visible + traceable. Users abandon systems when they stop trusting them.

5) **Default to safe behavior**: if uncertain, do NOT write low-quality guesses into the memory store. Hold items for review and ask for clarification.

6) **Small, frequent, actionable outputs**
- Daily digest MUST be <150 words, fit on a phone screen.
- Weekly review MUST be <250 words.
- Outputs must contain concrete actions, not motivational fluff.

7) **Next action is the unit of execution**
Project entries must have a single explicit “nextAction” that is concrete and executable (e.g., “Email Sarah to confirm copy deadline”).

8) **Prefer routing over organizing**
The system routes into a small set of stable buckets. Do not require ongoing folder maintenance.

9) **Keep categories & fields painfully small**
Start with only these categories:
- People
- Projects
- Ideas
- Admin
Plus an Inbox Log (audit trail).
Avoid expanding schema unless necessary.

10) **Design for restart**
If the user falls off, the system must be easy to resume without backlog guilt. The UI should encourage “just restart” rather than “catch up.”

11) **Build one core workflow, then attach modules**
Core loop: capture → file → daily digest → weekly review → fix/correct. Future integrations (Apple Notes, email/calendar) are out of scope for now; design modular hooks but don’t implement them.

12) **Maintainability over cleverness**
Few moving parts. Clear logs. Easy to debug. Do not add heavy dependencies or complex pipelines unless needed.

# 2) Translate the classic stack into PortOS (offline)
Classic tools equivalents:
- “Slack capture channel” → Brain Inbox UI (chat-like)
- “Notion databases” → local file-based databases (People/Projects/Ideas/Admin + InboxLog)
- “Zapier automations” → local server workflows + scheduler (daily/weekly)
- “Claude/ChatGPT intelligence” → PortOS AI provider abstraction (default: LM Studio → model `openai/gpt-oss-20b`)

Everything must work offline and be self-contained.

# 3) Technical constraints + integration with PortOS
- PortOS is an Express + React + Tailwind webapp.
- Implement a new navigation entry **Brain** and route **/brain**.
- Implement Express API routes under **/api/brain/**.
- Use PortOS’s existing AI Provider/Model config + prompt templates system:
  - Default Brain to LM Studio with model `openai/gpt-oss-20b`.
  - Allow runtime override per request (provider/model).
- Local persistence under **./data/brain/** (gitignored), with sample data under **./data.sample/brain/**.

# 4) Data model (schemas + file layout)
Use JSON Lines (preferred) for append-only audit and easy diffs. Keep records human-readable.

Directory:
- ./data/brain/meta.json
- ./data/brain/inbox_log.jsonl
- ./data/brain/people.jsonl
- ./data/brain/projects.jsonl
- ./data/brain/ideas.jsonl
- ./data/brain/admin.jsonl

IDs:
- Use UUID for all records.
- Timestamps: ISO strings.
- Every record: createdAt, updatedAt.

## 4.1 Inbox Log (Receipt / Audit Trail) — ALWAYS write one per capture
InboxLogRecord schema:
- id: string
- capturedText: string
- capturedAt: string
- source: "brain_ui"  (future: notes/email/calendar)
- ai: {
    providerId: string,
    modelId: string,
    promptTemplateId: string,
    temperature?: number,
    maxTokens?: number
  }
- classification: {
    destination: "people" | "projects" | "ideas" | "admin" | "unknown",
    confidence: number,          // 0..1
    title: string,               // AI-generated concise title
    extracted: object,           // destination-specific extracted fields (see below)
    reasons?: string[]           // short debug/trust hints
  }
- status: "filed" | "needs_review" | "corrected" | "error"
- filed?: {
    destination: "people" | "projects" | "ideas" | "admin",
    destinationId: string
  }
- correction?: {
    correctedAt: string,
    previousDestination: string,
    newDestination: string,
    note?: string
  }
- error?: { message: string, stack?: string }

## 4.2 People DB
PeopleRecord:
- id
- name: string
- context: string            // who they are / how you know them
- followUps: string[]        // things to remember next time
- lastTouched?: string       // date/time of last interaction or update
- tags?: string[]
- createdAt, updatedAt

## 4.3 Projects DB
ProjectRecord:
- id
- name: string
- status: "active" | "waiting" | "blocked" | "someday" | "done"
- nextAction: string         // MUST be concrete + executable
- notes?: string
- tags?: string[]
- createdAt, updatedAt

## 4.4 Ideas DB
IdeaRecord:
- id
- title: string
- oneLiner: string           // core insight in 1 sentence
- notes?: string
- tags?: string[]
- createdAt, updatedAt

## 4.5 Admin DB
AdminRecord:
- id
- title: string
- status: "open" | "waiting" | "done"
- dueDate?: string
- nextAction?: string        // if applicable
- notes?: string
- createdAt, updatedAt

# 5) The “AI Loop” workflows to implement (must ship)
## 5.1 Capture → Classify/Route → Store → Log
User enters one thought per message in Brain Inbox.
Server workflow:
1) Create InboxLogRecord immediately with capturedText + capturedAt.
2) Call AI classifier prompt with capturedText.
3) Receive strict JSON output:
   - destination + confidence + title + extracted fields.
4) If confidence >= THRESHOLD (default 0.6):
   - Write a record into the chosen DB (people/projects/ideas/admin) using extracted fields.
   - Update InboxLogRecord status=filed + filed.destinationId.
5) If confidence < THRESHOLD or destination="unknown":
   - Set InboxLogRecord status=needs_review.
   - Do NOT write to target DB.
   - Return UI response asking for clarification and offering one-click re-route.

## 5.2 Bouncer (Confidence filter)
- Threshold is configurable in ./data/brain/meta.json and in UI settings.
- Low confidence never pollutes the memory store.

## 5.3 Fix Button (human-in-loop correction)
Every filed item must be correctable in one step:
- In UI, each Inbox item shows what it was filed as + confidence + “Fix” action.
- Fix flow:
  - User selects correct destination (and optionally edits extracted fields).
  - System updates the destination DB record or moves it:
    - If moving: create new record in new DB and mark old record as archived OR delete (choose a safe approach, default archive).
  - Update InboxLogRecord status=corrected with correction info.
  - Corrections must be trivial; no deep navigation.

## 5.4 Tap on the Shoulder (daily + weekly surfacing)
Implement scheduled jobs on the local server:
- Daily Digest job (default 9:00 AM local time, configurable)
  - Query: active projects, admin open items, people with followUps/lastTouched stale, and any needs_review items.
  - Call AI summarizer prompt.
  - Store digest output to ./data/brain/digests.jsonl (or similar) AND surface in UI notifications panel.
- Weekly Review job (default Sunday 4:00 PM local time, configurable)
  - Query: last 7 days inbox log + active projects + open loops (waiting/blocked) + needs_review.
  - Call AI review prompt.
  - Store review output and surface in UI.

Outputs must be short:
- Daily digest <150 words.
- Weekly review <250 words.
Also store structured metadata alongside the text, e.g. list of recommended actions.

# 6) Brain Page UI requirements
Implement /brain with 3 primary areas (tabs or layout sections):
1) **Inbox (Chat-style)**
   - Single input, “one thought per message” hint.
   - Message list includes: capturedText, destination, confidence, status, createdAt.
   - For filed items: link to the created record.
   - For needs_review: inline clarification controls (choose category + optional short prefix + resubmit).
   - “Fix” button for corrections.

2) **Memory (Databases)**
   - Views for People / Projects / Ideas / Admin with simple filters:
     - Projects filter by status.
     - Admin filter by status/due date.
     - Needs review list.
   - Basic CRUD editing for records.

3) **Digest & Review**
   - Show latest Daily Digest and Weekly Review.
   - List previous digests/reviews (history).
   - “Run now” buttons (manual trigger) for digest/review.

Additional UI:
- **Trust panel** / “Inbox Log” view:
  - Audit trail with filters by status, date, confidence range.
  - Inspect raw AI JSON for a record (for debugging).

# 7) API endpoints (Express)
Implement:
- POST /api/brain/capture
  - body: { text: string, providerOverride?, modelOverride? }
  - returns: inboxLogRecord + uiMessage (filed/needs_review)
- GET /api/brain/inbox?status=&limit=&offset=
- POST /api/brain/review/resolve
  - resolves needs_review: { inboxLogId, destination, editedExtracted? }
- POST /api/brain/fix
  - { inboxLogId, newDestination, updatedFields? }
- CRUD endpoints for each DB:
  - /api/brain/people, /projects, /ideas, /admin
- GET /api/brain/digest/latest
- GET /api/brain/review/latest
- POST /api/brain/digest/run
- POST /api/brain/review/run
- GET /api/brain/settings
- POST /api/brain/settings (threshold, schedule times, defaults)

# 8) Scheduler
Implement a simple in-process scheduler:
- Reads settings from ./data/brain/meta.json.
- Runs daily + weekly jobs at configured times.
- Handles restarts cleanly:
  - If server was down during scheduled time, run “catch-up” lightly:
    - At most one missed daily digest.
    - Weekly review runs next time it detects it missed the window.
  - No backlog explosion.

# 9) AI prompt templates (must implement as strict JSON contracts)
Create 3 prompt templates stored in PortOS’s prompt system:
1) brain_classifier_v1
2) brain_daily_digest_v1
3) brain_weekly_review_v1

They must:
- Demand JSON only.
- Define allowed enum values.
- Define how to handle ambiguity and confidence scoring.
- Prefer safe behavior.

## 9.1 brain_classifier_v1 (JSON-only)
Input variables:
- capturedText: string
- now: ISO string

Output JSON schema:
{
  "destination": "people" | "projects" | "ideas" | "admin" | "unknown",
  "confidence": number,          // 0..1
  "title": string,               // short
  "extracted": object,           // depends on destination
  "reasons": string[]            // <=3 short strings
}

Destination-specific extracted schemas:
- people:
  { "name": string, "context": string, "followUps": string[], "lastTouched": string|null, "tags": string[] }
- projects:
  { "name": string, "status": "active"|"waiting"|"blocked"|"someday"|"done", "nextAction": string, "notes": string, "tags": string[] }
- ideas:
  { "title": string, "oneLiner": string, "notes": string, "tags": string[] }
- admin:
  { "title": string, "status": "open"|"waiting"|"done", "dueDate": string|null, "nextAction": string|null, "notes": string }

Rules:
- If ambiguity is high, set destination="unknown" and confidence <0.6.
- Confidence meaning: likelihood the chosen destination + extracted fields are correct.
- “nextAction” must be explicit and executable when destination=projects; if not inferable, lower confidence.
- Keep tags optional and minimal; do not invent many tags.

## 9.2 brain_daily_digest_v1 (JSON-only)
Input variables:
- activeProjects: ProjectRecord[]
- openAdmin: AdminRecord[]
- peopleFollowUps: PeopleRecord[]
- needsReview: InboxLogRecord[]
- now: ISO string

Output JSON schema:
{
  "digestText": string,                // MUST be <150 words
  "topActions": string[],              // 3 items max
  "stuckThing": string,                // 1 item
  "smallWin": string                   // 1 item
}

Rules:
- Must be operational, not motivational.
- Fit on a phone screen.
- If data is sparse, be honest and suggest a simple next step.

## 9.3 brain_weekly_review_v1 (JSON-only)
Input variables:
- inboxLogLast7Days: InboxLogRecord[]
- activeProjects: ProjectRecord[]
- now: ISO string

Output JSON schema:
{
  "reviewText": string,                // MUST be <250 words
  "whatHappened": string[],            // 3-5 bullets (short)
  "biggestOpenLoops": string[],        // 1-3 items
  "suggestedActionsNextWeek": string[],// 3 items max
  "recurringTheme": string             // 1 sentence
}

Rules:
- Must focus on actionable follow-through and open loops.
- No long analysis.

# 10) Local storage implementation details
Implement an append-safe storage layer:
- Append JSONL for new records.
- For updates, either:
  - rewrite full file safely (atomic write), OR
  - maintain a small “patch log” file and materialize views (choose simplest maintainable approach).
Given maintainability, prefer atomic rewrite per DB file with file lock or single-threaded write queue.

Include:
- Validation of records against schemas (lightweight runtime checks).
- Basic search/filter by fields.
- Sorting by timestamps.
- Robust error handling; errors logged to InboxLogRecord status=error.

# 11) Offline-first behavior
- If AI provider is unavailable (LM Studio down), capture must still work:
  - Create InboxLogRecord with status=needs_review and destination=unknown.
  - UI tells user “AI unavailable; queued for later classification” with a “Retry classification” action.
- Add a small queue processor to retry classification when AI becomes available.

# 12) Testing + sample data
- Provide sample data under ./data.sample/brain to demo UI instantly.
- Add minimal tests for:
  - capture flow creates inbox log always
  - confidence threshold gating
  - fix/move behavior updates records + log
  - digest/review prompt enforcement (word limits enforced server-side too)

# 13) Implementation sequence (do in this order)
1) Data layer + schemas + file IO + meta settings.
2) API endpoints: capture + CRUD + digest/review run.
3) AI prompt templates + strict JSON parsing/validation.
4) Scheduler + manual trigger.
5) React UI for Inbox + Memory + Digest/Review + Trust panel.
6) Sample data + tests.

# 14) Output expectations
Return a PR-quality implementation:
- Clean code, minimal dependencies.
- Works end-to-end locally.
- Default Brain uses LM Studio / `openai/gpt-oss-20b` unless overridden.
- UI and audit trail make the system trustworthy and easy to repair.

Do not implement Apple Notes/email/calendar integrations; only stub extension points.
