# Memory System

Semantic memory system for the Chief of Staff that stores facts, learnings, observations, decisions, and user preferences with vector embeddings for intelligent retrieval.

## Architecture

- **Memory Service** (`server/services/memory.js`): Core CRUD, search, and lifecycle operations
- **Embeddings Service** (`server/services/memoryEmbeddings.js`): LM Studio integration for vector generation
- **Memory Extractor** (`server/services/memoryExtractor.js`): Extract memories from agent output
- **Memory Classifier** (`server/services/memoryClassifier.js`): LLM-based quality filtering
- **Memory Retriever** (`server/services/memoryRetriever.js`): Context injection for agent prompts
- **Memory Routes** (`server/routes/memory.js`): REST API endpoints
- **Memory Tab** (`ChiefOfStaff.jsx`): UI with list, timeline, and graph views

## Features

1. **Six Memory Types**: fact, learning, observation, decision, preference, context
2. **Semantic Search**: LM Studio embeddings for similarity-based retrieval
3. **LLM Classification**: Intelligent memory extraction with quality filtering (M31)
4. **Auto-Extraction**: Memories extracted from successful agent task completions
5. **Auto-Injection**: Relevant memories injected into agent prompts before execution
6. **Importance Decay**: Time-based decay with access-based boosts
7. **Memory Consolidation**: Merge similar memories automatically
8. **Real-time Updates**: WebSocket events for memory changes
9. **Graph Visualization**: D3.js relationship graph (planned)

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
  importance: number,      // 0.0-1.0 (decays over time)
  accessCount: number,
  lastAccessed: string,
  createdAt: string,
  status: 'active' | 'archived' | 'expired'
}
```

## Data Storage

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

```json
{
  "enabled": true,
  "provider": "lmstudio",
  "endpoint": "http://localhost:1234/v1/chat/completions",
  "model": "gptoss-20b",
  "timeout": 60000,
  "maxOutputLength": 10000,
  "minConfidence": 0.6,
  "fallbackToPatterns": true
}
```

## Memory Extraction

Memories are extracted from agent output:

1. **LLM Classification**: gptoss-20b analyzes task and output, extracts quality memories
2. **Fallback Patterns**: If LLM unavailable, falls back to pattern matching
3. **High confidence (>0.8)**: Auto-saved
4. **Medium confidence (0.5-0.8)**: Queued for user approval

## Memory Injection

Before agent task execution:

1. Generate embedding for task description
2. Find semantically similar memories (>0.7 relevance)
3. Include high-importance user preferences
4. Include relevant codebase facts
5. Format as markdown section in agent prompt

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/memory | List memories with filters |
| GET /api/memory/:id | Get single memory |
| POST /api/memory | Create memory |
| PUT /api/memory/:id | Update memory |
| DELETE /api/memory/:id | Delete (soft) memory |
| POST /api/memory/search | Semantic search |
| GET /api/memory/categories | List categories |
| GET /api/memory/tags | List tags |
| GET /api/memory/timeline | Timeline view data |
| GET /api/memory/graph | Graph visualization data |
| GET /api/memory/stats | Memory statistics |
| POST /api/memory/link | Link two memories |
| POST /api/memory/consolidate | Merge similar memories |
| POST /api/memory/decay | Apply importance decay |
| DELETE /api/memory/expired | Clear expired memories |
| GET /api/memory/embeddings/status | LM Studio connection status |

## WebSocket Events

| Event | Description |
|-------|-------------|
| cos:memory:created | New memory created |
| cos:memory:updated | Memory updated |
| cos:memory:deleted | Memory deleted |
| cos:memory:extracted | Memories extracted from agent |
| cos:memory:approval-needed | Medium-confidence memories pending approval |

## Setup Requirements

**LM Studio** must be running with an embedding model loaded:

1. Download and install [LM Studio](https://lmstudio.ai/)
2. Load an embedding model: `text-embedding-nomic-embed-text-v2-moe` (recommended)
3. Load a classification model: `gptoss-20b` or similar
4. Start the local server on port 1234 (default)
5. The memory system will automatically connect

## LM Studio Configuration

```javascript
memory: {
  enabled: true,
  embeddingProvider: 'lmstudio',
  embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
  embeddingModel: 'text-embedding-nomic-embed-text-v2-moe',
  embeddingDimension: 768,
  maxContextTokens: 2000,
  minRelevanceThreshold: 0.7,
  autoExtractEnabled: true
}
```

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/memoryValidation.js` | Zod schemas for memory operations |
| `server/lib/vectorMath.js` | Cosine similarity, clustering helpers |
| `server/services/memory.js` | Core CRUD, search, lifecycle |
| `server/services/memoryEmbeddings.js` | LM Studio embedding generation |
| `server/services/memoryExtractor.js` | Extract memories from agent output |
| `server/services/memoryClassifier.js` | LLM-based classification service |
| `server/services/memoryRetriever.js` | Retrieve and format for injection |
| `server/routes/memory.js` | REST API endpoints |
| `client/src/pages/ChiefOfStaff.jsx` | MemoryTab, MemoryTimeline, MemoryGraph |
| `client/src/services/api.js` | Memory API client functions |
| `data/prompts/stages/memory-evaluate.md` | Memory evaluation prompt template |

## Related Features

- [Chief of Staff](./chief-of-staff.md)
- [Brain System](./brain-system.md)
