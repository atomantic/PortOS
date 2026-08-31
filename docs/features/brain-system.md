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
9. **YouTube Ingest**: Pull a video's transcript (and optionally the video/audio) into the brain, mirror the transcript to Obsidian, and queue an agent to act on it

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
├── meta.json               # Settings and scheduler state
├── admin/                  # Admin tasks (collectionStore: <id>/index.json)
├── buckets/                # Custom bucket definitions (collectionStore: <id>/index.json)
├── ideas/                  # Ideas and concepts (collectionStore: <id>/index.json)
├── inbox/                  # Captured thoughts (collectionStore: <id>/index.json)
├── journals/               # Daily Log entries (collectionStore: <id>/index.json)
├── links/                  # Saved bookmarks (collectionStore: <id>/index.json)
├── memories/               # Brain memories (collectionStore: <id>/index.json)
├── people/                 # People records (collectionStore: <id>/index.json)
├── projects/               # Projects with status tracking (collectionStore: <id>/index.json)
├── songs/                  # SongBook songs (collectionStore: <id>/index.json)
├── idealoom-lists/         # Machine-local IdeaLoom lists (collectionStore: <id>/index.json)
├── imports/                # Imported conversation archives
├── scans/                  # Repository malware scan reports
├── songbook/               # Machine-local SongBook attachment files
├── youtube/                # YouTube transcripts, audio, and ingest index
├── activity-digest-settings.json # Activity digest configuration
├── journal-settings.json   # Daily Log and Obsidian mirror settings
├── journal-obsidian-locations.json # Machine-local journal mirror paths
├── memory-bridge-map.json  # Brain↔CoS memory bridge mapping
├── obsidian-vaults.json    # Obsidian vault sync config
├── youtube-ingest-settings.json # YouTube ingest defaults
├── sync_log.jsonl          # Brain peer-sync mutation history
├── digests.jsonl           # Daily digest history
└── reviews.jsonl           # Weekly review history
```

Each `collectionStore` directory contains a schema-versioned `index.json` and
stores every record at `<id>/index.json`.

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

## YouTube Ingest

Paste a single-video YouTube URL into **Quick Capture** (dashboard widget) and the
submit path switches from `/api/brain/capture` to `/api/brain/youtube/ingest`. A
sliders button next to the input expands the advanced panel: which artifacts to
capture, a free-text prompt for a follow-up agent, and tags.

**Three independent switches** — at least one is required:

| Switch | Produces |
|--------|----------|
| `captureTranscript` (default) | `data/brain/youtube/<videoId>.md`, mirrored into the Obsidian vault |
| `downloadVideo` | A `source: 'download'` entry in the shared media library (same shape the Dev Tools downloader writes) |
| `ingestAudio` | `data/brain/youtube/<videoId>.mp3`, kept next to the transcript |

**Always recorded, regardless of switches:**

- a brain `links` record (federated — the durable "saved for future reference" artifact), and
- a `media.watch` row in `human_activity_events` (machine-local), so the video appears on the Timeline next to passively-synced watch history.

**The agent prompt.** Supplying `agentPrompt` queues a CoS task pointed at the
stored transcript with that prompt as its brief — "here is what I want done with
this content." Leaving it blank queues nothing: PortOS never starts AI work the
user did not ask for (see the AI Provider Usage Policy in the root `AGENTS.md`).

**Transcripts.** yt-dlp is asked for English captions; the metadata dump's
`subtitles` key (not the produced filename, which is identical for both kinds)
distinguishes human-authored captions from auto-generated ones, and that lands on
the record as `transcript.source`. YouTube's auto-captions are a rolling two-line
display where each cue repeats the previous one, so `server/lib/vttTranscript.js`
collapses the repetition and strips inline markup — a 14-minute talk goes from
128 KB of VTT to ~14 KB of prose. A video with no captions is **not** a failure:
the ingest completes with a warning and everything else is still stored.

**Obsidian.** The transcript note is written to the vault configured under
**Brain → Config → YouTube Ingest**. An unset vault inherits the Daily Log's, so
anyone who already pointed the journal at Obsidian needs no setup. The note
carries YAML frontmatter (title, source, channel, duration, published, captured,
tags) so vault queries and Dataview can find it.

**Storage.** `data/brain/youtube/index.json` is machine-local and never
federated — every field in it is a local path, an Obsidian vault id, or a local
video-history id. See [STORAGE.md](../STORAGE.md).

**Requirements.** `yt-dlp` on PATH for any ingest; `ffmpeg` additionally for the
video/audio switches (a transcript-only ingest works without it).

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
| POST /api/brain/youtube/ingest | Start a YouTube ingest → `{ jobId, videoId }` |
| GET /api/brain/youtube/ingest/:jobId/events | SSE progress for an ingest |
| POST /api/brain/youtube/ingest/:jobId/cancel | Cancel an in-flight ingest |
| GET /api/brain/youtube/ingests | List ingests, newest first |
| GET/DELETE /api/brain/youtube/ingests/:videoId | One ingest / forget it |
| GET /api/brain/youtube/ingests/:videoId/transcript | Stored transcript markdown |
| GET/PUT /api/brain/youtube/settings | Ingest vault/folder + option defaults |

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

## IdeaLoom Obsidian exchange

The dedicated `/brain/ideas` page keeps native Brain ideas separate from
machine-local IdeaLoom lists. When the integration is enabled and an existing
Obsidian vault is selected, the page exposes explicit Import and Export actions.
Neither action runs during boot, and disabled or unconfigured integration does
not affect local list editing.

Import scans only the vault's `Idea Loom/` folder. A supported note has UUID,
title, category, draft/completed status, created/modified timestamps, an
IdeaLoom tag, a prompt heading, optional help text, and dense numbered idea
lines. Imports preserve the UUID, order, timestamps, and discovered note path;
malformed, duplicate, and iCloud-unavailable notes are reported in the result
instead of being silently accepted. Export writes the same frontmatter and
numbered Markdown shape, uses a date/title filename for new lists, and keeps an
imported filename stable.

The exchange result includes counts and per-note details for imported,
exported, skipped, conflicted, missing, malformed, unavailable, and failed
work. Each stays a distinct outcome so a deleted note never reads as a failed
one. List records and vault identifiers remain under
`data/brain/idealoom-lists/` and never enter Brain federation or the memory
bridge.

### Conflicts

Every exchanged list stores the hash of the note as it was last read or
written. That hash is the base for the next comparison:

| Vault note vs. base | Local list vs. base | Outcome |
|---|---|---|
| unchanged | unchanged | `skipped` (`unchanged`) — nothing is written |
| changed | unchanged | import updates the list; export reports `skipped` (`external-change`) |
| unchanged | changed | export writes the note |
| changed | changed | `conflicted` (`both-sides-changed`) — **neither side is overwritten** |

A conflict is resolved by hand: edit whichever side you want to keep so the
other becomes the only changed one, then run the exchange again.

### Deletions

Deleting a vault note is treated as a decision, never as drift to repair. A
list whose note is gone is reported as `missing` (`note-deleted-externally`)
by both import and export, and **nothing is written** — the local list is kept
so nothing is lost. Recreating the note takes an explicit "Recreate deleted
notes" action, which is the only path that sets `recreateMissing`. In the other
direction, deleting a local list leaves its vault note alone: removing the note
is done in Obsidian.

An iCloud note that has not been downloaded to this Mac is `unavailable`, not
`missing` — the file still exists, so it is never a recovery candidate.

### Automatic sync

Automatic export is off by default and needs two separate opt-ins: vault sync
enabled with a vault chosen, then **Export automatically after an edit**. Both
are re-read when the write actually fires, so turning either off cancels work
already queued. Automatic writes are debounced, so reordering a list one click
at a time is a single note write.

Automatic sync is deliberately the least powerful path in the feature. It can
only ever update an existing note whose content differs from the list: it never
deletes a note, never recreates a deleted one, and never resolves a conflict.
Anything it cannot do safely is reported and waits for an explicit action.

There is no import/export feedback loop: only a local list edit schedules an
automatic export, and an export whose rendered Markdown already matches the
note on disk is skipped instead of rewritten, so a freshly imported list does
not export itself back.

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/brainValidation.js` | Zod schemas for all Brain entities |
| `server/services/brain.js` | Core business logic |
| `server/services/brainStorage.js` | Per-record collectionStore persistence plus JSON/JSONL sidecars |
| `server/services/idealoomLists.js` | Machine-local ordered IdeaLoom list records and sync metadata |
| `server/services/idealoomObsidian.js` | Validated IdeaLoom Markdown import/export with base-hash conflict and deletion handling |
| `server/services/idealoomAutoSync.js` | Opt-in debounced automatic export (never deletes or recreates a note) |
| `server/services/brainScheduler.js` | Daily/weekly job scheduler |
| `server/services/youtubeIngest.js` | YouTube ingest orchestration (transcript / video / audio → brain + Obsidian + CoS task) |
| `server/lib/vttTranscript.js` | WebVTT/SRT → readable prose (collapses auto-caption repetition) |
| `server/routes/brain.js` | Aggregator router mounting brainCapture, brainIdeaLoom, brainCrud, brainDigest, brainSettings, brainLinks, brainGraph, brainSync, brainDailyLog, brainSongbook, and brainYoutube |
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
