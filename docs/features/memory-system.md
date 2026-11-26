# Memory System

Semantic memory system for the Chief of Staff that stores facts, learnings, observations, decisions, and user preferences with vector embeddings for intelligent retrieval.

## Architecture

- **Memory Backend** (`server/services/memoryBackend.js`): Selects the storage backend — `memoryDB.js` (PostgreSQL + pgvector) for real installs; `memory.js` (JSON files) is a test-only escape hatch (`MEMORY_BACKEND=file` / `NODE_ENV=test`), not a supported deployment mode
- **Memory DB Service** (`server/services/memoryDB.js`): Primary CRUD, search, and lifecycle operations against PostgreSQL
- **Embeddings Service** (`server/services/memoryEmbeddings.js`): Configured embeddings provider integration for vector generation
- **Memory Extractor** (`server/services/memoryExtractor.js`): Extract memories from agent output
- **Memory Classifier** (`server/services/memoryClassifier.js`): LLM-based quality filtering
- **Memory Retriever** (`server/services/memoryRetriever.js`): Context injection for agent prompts
- **Memory Routes** (`server/routes/memory.js`): REST API endpoints
- **Memory Tab** (`client/src/components/cos/tabs/MemoryTab.jsx`): UI with list, timeline, and graph views

## Features

1. **Six Memory Types**: fact, learning, observation, decision, preference, context
2. **Semantic Search**: Configured embeddings provider for similarity-based retrieval
3. **LLM Classification**: Intelligent memory extraction with quality filtering (M31)
4. **Auto-Extraction**: Eligible successful agent completions can propose memories; issue-claim lifecycles are excluded.
5. **Auto-Injection**: Background CoS tasks can recall a few memories from their own app, not from a global pool.
6. **Persistent Mind Reflection**: Stored importance changes through edits. For reflection,
   the Mind considers active standard memories it owns that are older than 30 days and
   lack a verdict on the current version. The reflection score starts at stored importance
   and halves every 90 idle days after a 30-day grace period. Idleness starts at the last
   access or, for unread memories, at creation. A score below 0.15 makes the memory eligible
   for review.
7. **Manual Maintenance**: API calls consolidate similar memories or clear expired memories.
8. **Real-time Updates**: WebSocket events for memory changes
9. **Graph Visualization**: React Three Fiber relationship graph (`client/src/components/cos/tabs/MemoryGraph.jsx`)

## Persistent Mind message recall

A human message also recalls up to three of the mind's own active memories that
share enough terms with the unchanged message text, even when many other memories
outrank them by importance. Search is lexical and scoped to the mind's records
before ranking; nothing is sent to a provider and no query is generated.
Acknowledgements, unrelated messages and self-wakes recall nothing.

Recalled records follow protected memories in the context and are marked
`recalled=current-message`. They share a reserved quarter of the memory budget,
so each is either whole in the prompt or left out. The turn's `mind.model.request`
event records `memoryRecallState` (`none`, `no-match`, `unavailable`, `included`,
`omitted-budget`, `already-in-baseline`), `memoryRecallIds` and
`memoryRecallOmittedIds`. A failed search leaves the normal context in place.
Access stats change only for records in a prompt whose turn ran.

## Persistent Mind memory protection

Persistent Mind memories have an explicit cleanup protection level, separate from
numerical importance: `standard`, `important`, or `core-identity`. The Memories
panel lets the user set it when creating or editing a memory. Existing records
remain standard until explicitly marked; no identity is inferred from private
conversation history during installation or startup.

Protected memories remain active through manual and self-triggered mind cleanup,
expiration, and duplicate consolidation. Cleanup reports both
archived and preserved counts. Clearing history still removes facts stored only
in that history, so save lasting identity and knowledge as protected memories
first. Protected memories take priority in the bounded context; protection is a
retention policy, not a grant of authority or an unlimited context budget.

The mind can emit `protection` in a memory candidate. With its existing
`manageMind` grant it can call `mind.protect-memory` using an existing owned
memory ID. That tool only adds protection; it cannot remove protection or demote
core identity. Only an explicit user edit to Standard makes a protected memory
eligible for bulk cleanup again. Direct record deletion in Brain remains a
separate user action.

Storage uses the existing `tags` field: `mind:core-identity` and `mind:important`.
Both PostgreSQL and the test-only file backend already round-trip tags, so no new
record format, seed, migration, or federation surface is introduced. The Mind API
projects those tags as `protection`; older clients editing ordinary tags preserve
the protection unless they explicitly supply a new protection level. The cleanup
guards require this version of PortOS; downgrading to an older build cannot
provide these retention guarantees.

### Continuation note

The mind can add an optional `continuationNote` (at most 4,000 characters) to a
turn: its own note to its next wake, holding the current thread, open threads, and
next useful action. Leaving the field out keeps the note, a new string replaces it,
and an empty string clears it. Only a successful turn changes the note; a turn
replays once, and a replacement of a note changed since that wake read it is refused.

There is one current record, a `context` memory tagged `mind:continuation-note`
and `mind:important`. Replacements use the versioned update path, a clear archives
the record with its wording intact, and neither the record nor its text enters
federation, the portability bundle, or the trajectory events that rollups compact.
Every wake receives it word for word in its own fenced section, read independently
of the ordinary memory page. If it does not fit after identity, instructions,
protected identity memories, and the newest human input, the wake is told it was
omitted instead of receiving part of it.

The context panel shows the note read-only. Its author, turn, provider, and model
come from `mind.continuation.updated` runtime events, never from model-supplied
text. Wording with no matching retained event, including a later edit through Brain
or a note whose events were cleared with the history, is shown as author unknown.

## Memory Schema

```javascript
{
  id: string,              // UUID
  type: 'fact' | 'learning' | 'observation' | 'decision' | 'preference' | 'context',
  content: string,         // Full memory content
  summary: string,         // Short summary
  category: string,        // e.g., 'codebase', 'workflow', 'tools'
  tags: string[],          // Auto-extracted and user-defined
  relatedMemories: string[], // Linked memory IDs
  sourceTaskId: string,    // Origin task
  sourceAgentId: string,   // Origin agent
  embedding: number[],     // Vector (768 dims for nomic-embed)
  confidence: number,      // 0.0-1.0
  importance: number,      // Stored value from 0.0 to 1.0
  accessCount: number,
  lastAccessed: string,
  createdAt: string,
  status: 'active' | 'archived' | 'expired'
}
```

## Data Storage

Memories and links live in PostgreSQL — the `memories` and `memory_links` tables, with pgvector columns for embeddings (see [docs/STORAGE.md](../STORAGE.md)).

The test-only file backend (`MEMORY_BACKEND=file` / `NODE_ENV=test`) uses this JSON layout instead:

```
./data/cos/memory/
├── index.json         # Lightweight metadata for listing/filtering
├── embeddings.json    # Vector storage for semantic search
└── memories/          # Full memory content
    └── {id}/
        └── memory.json
```

## LLM-Based Classification (M31)

The memory classifier uses LM Studio's gptoss-20b model to intelligently evaluate agent output and extract only genuinely useful memories.

### Good Memories

- Codebase facts: File locations, architecture patterns, dependencies
- User preferences: Coding style, tool preferences, workflow patterns
- Learnings: Discovered behaviors, gotchas, workarounds
- Decisions: Architectural choices with reasoning

### Rejected Memories

- Task echoes: Just restating what the task was
- Generic summaries: "The task was successful"
- Temporary info: Session-specific data, timestamps
- Truncated/incomplete content

### Configuration

Choose **Memory extraction model** under **Settings → AI Assignments → Memory & Catalog**. The assignment is stored in `settings.memoryClassifier` as `{ providerId, model }`. The selected provider processes agent output and a summary of existing memories without tools. Choose **Disabled** to skip AI classification. The Memory tab shows whether the classifier is reachable.

Choose **Legacy LM Studio** to keep the direct LM Studio classifier, which is the default when the assignment is unset. The defaults below can be overridden in `data/memory-classifier-config.json`. Its `timeout`, `maxOutputLength` and `fallbackToPatterns` settings also apply to assigned models.

```json
{
  "enabled": true,
  "provider": "lmstudio",
  "endpoint": "http://localhost:1234/v1/chat/completions",
  "model": "gptoss-20b",
  "timeout": 60000,
  "maxOutputLength": 10000,
  "fallbackToPatterns": true
}
```

## Memory Extraction

Memories are extracted from agent output:

1. The configured classifier analyzes the task and agent output for memories.
2. When classification is disabled, unavailable, or fails, extraction uses pattern matching if `fallbackToPatterns` is enabled.
3. In execute mode, memories with confidence of at least 0.85 are saved automatically.
4. Memories with confidence from 0.7 up to (but below) 0.85 are queued for approval; lower-confidence memories are dropped. In dry-run mode for the `memory` autonomy domain, every memory that passes this quality filter—including high-confidence memories that would otherwise be auto-saved—is sent to approval.

## Memory Injection

An issue claim uses the tracker item, repository instructions, and explicit
handoff context. CoS does not automatically add stored memories or Digital Twin
context to that prompt, and it does not mine the claim transcript for memories.

Other eligible CoS jobs with an app and task description search active memories
from that exact app, up to three hits within the prompt budget. An unscoped task
or a search without matches contributes no memory section. Global preferences and
high-importance rows are not automatic fallbacks. Voice, manual memory search,
and Persistent Mind recall keep their separate context rules.

The CoS run card's **Memories sent** means that the listed memory versions
contributed text to the prompt; it does not imply that the model relied on them.
Classification of other eligible runs receives deduplication examples only from
the same app. Existing memories and run lineage are not modified.

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/memory | List memories with filters |
| GET /api/memory/:id | Get single memory |
| POST /api/memory | Create memory |
| PUT /api/memory/:id | Update memory |
| DELETE /api/memory/:id | Delete (soft) memory |
| POST /api/memory/search | Searches semantically when embeddings are available and by text otherwise. Returns `searchMode` as `semantic` or `lexical`. |
| GET /api/memory/graph | Graph visualization data |
| GET /api/memory/stats | Memory statistics |
| GET /api/memory/embeddings/status | Embedding and classifier availability |
| GET /api/memory/backend/status | Active storage backend status |
| GET /api/memory/sync | File↔DB sync status |
| POST /api/memory/sync | Trigger file↔DB sync |
| POST /api/memory/:id/approve | Approve a pending memory |
| POST /api/memory/:id/reject | Reject a pending memory |

## WebSocket Events

| Event | Description |
|-------|-------------|
| cos:memory:created | New memory created |
| cos:memory:updated | Memory updated |
| cos:memory:deleted | Memory deleted |
| cos:memory:extracted | Memories extracted from agent |
| cos:memory:approval-needed | Medium-confidence memories pending approval |

## Setup Requirements

Configure the embedding backend under **Models → Embeddings**. Select an embedding
provider (Ollama, LM Studio, or **Disabled**) and its model. The memory system
uses that shared embedding setting; no particular local server is required when
embeddings are disabled or another provider is selected. Configure the memory
classifier separately under **Settings → AI Assignments → Memory & Catalog**.

Memory injection has a fixed budget of 2,000 tokens and uses a relevance floor
of 0.7. These are implementation limits, not settings in the CoS configuration
store.

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/memoryValidation.js` | Zod schemas for memory operations |
| `server/lib/vectorMath.js` | Cosine similarity, clustering helpers |
| `server/services/memoryBackend.js` | Backend switcher (Postgres primary, file test-only) |
| `server/services/memoryDB.js` | Core CRUD, search, lifecycle (PostgreSQL + pgvector) |
| `server/services/memory.js` | File-backed CRUD (test-only backend) |
| `server/services/memoryEmbeddings.js` | Configured embeddings provider integration |
| `server/services/memoryExtractor.js` | Extract memories from agent output |
| `server/services/memoryClassifier.js` | LLM-based classification service |
| `server/services/memoryRetriever.js` | Retrieve and format for injection |
| `server/routes/memory.js` | REST API endpoints |
| `client/src/pages/ChiefOfStaff.jsx` | MemoryTab, MemoryTimeline, MemoryGraph |
| `client/src/services/apiMemory.js` | Memory API client functions |
| `data/prompts/stages/memory-evaluate.md` | Memory evaluation prompt template |

## Related Features

- [Chief of Staff](./chief-of-staff.md)
- [Brain System](./brain-system.md)
