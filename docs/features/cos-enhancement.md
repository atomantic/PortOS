# Chief of Staff Enhancement (M35)

> **Status:** This M35 milestone spec shipped, except the Phase 5 agent-architecture services (`agentGateway.js`, `errorRecovery.js`, `agentRunCache.js`, `contextUpgrader.js`) and `sessionDelta.js`, which were never built under those names. Their rows below are marked "(not built)" and kept for historical legibility.

Comprehensive upgrade from reactive task executor to proactive autonomous agent with hybrid memory, missions, local model integration, and dynamic thinking levels.

## Architecture

### New Services

| Service | Purpose |
|---------|---------|
| `server/lib/bm25.js` | BM25 algorithm with IDF weighting |
| `server/services/memoryBM25.js` | BM25 index manager for memory search |
| `server/services/sessionDelta.js` | Session delta tracking for pending bytes/messages (not built) |
| `server/services/toolStateMachine.js` | Tool execution state machine |
| `server/services/agentGateway.js` | Request deduplication and caching (not built) |
| `server/services/errorRecovery.js` | Error analysis and recovery strategies (not built) |
| `server/services/agentRunCache.js` | Agent output caching with TTL (not built) |
| `server/services/eventScheduler.js` | Cron-based event scheduling |
| `server/services/executionLanes.js` | Concurrent execution lane management |
| `server/services/missions.js` | Long-term goal and mission management |
| `server/services/lmStudioManager.js` | LM Studio model discovery and health |
| `server/services/localThinking.js` | Local model completions |
| `server/services/thinkingLevels.js` | Dynamic model selection |
| `server/services/contextUpgrader.js` | Complexity analysis for model upgrade (not built) |

## Features

### Phase 1: Hybrid Memory Search

- BM25 algorithm with IDF weighting and inverted index
- Reciprocal Rank Fusion (RRF) combining BM25 + vector search
- 40% BM25 / 60% vector weighting for optimal retrieval
- Session delta tracking for pending bytes/messages

### Phase 2: Proactive Execution

- Event scheduler with cron expressions and timeout-safe timers (clamps to 2^31-1)
- Execution lanes: critical (1), standard (2), background (3) concurrent slots
- Mission system for long-term goals with sub-tasks
- Mission-driven task generation in evaluation loop

### Phase 3: Local Model Integration

- LM Studio availability checking and model discovery
- Quick completions for local thinking without cloud costs
- Memory classification using local models
- Embeddings via local LM Studio

### Phase 4: Dynamic Model Selection

- Thinking levels: off, minimal, low, medium, high, xhigh
- Level resolution hierarchy: task → hooks → agent → provider
- Context upgrader with complexity analysis
- COS self-evolution with automatic model changes

### Phase 5: Agent Architecture

- Tool execution state machine (IDLE → START → RUNNING → UPDATE → END → ERROR)
- Agent gateway with request deduplication and 10-minute cache
- Error recovery with 6 strategies: retry, escalate, fallback, decompose, defer, investigate
- Agent run cache for outputs, tool results, and contexts

## Execution Lanes

| Lane | Concurrent Slots | Purpose |
|------|------------------|---------|
| critical | 1 | Emergency fixes, blocking issues |
| standard | 2 | Normal development tasks |
| background | 3 | Self-improvement, documentation |

## Thinking Levels

| Level | Description | Model Tier |
|-------|-------------|------------|
| off | No extended thinking | light |
| minimal | Brief analysis | light |
| low | Standard analysis | medium |
| medium | Thorough analysis | medium |
| high | Deep analysis | heavy |
| xhigh | Maximum analysis | heavy |

## Error Recovery Strategies

| Strategy | When Used |
|----------|-----------|
| retry | Transient errors (rate limit, timeout) |
| escalate | Persistent failures requiring human review |
| fallback | Model unavailable, try alternative |
| decompose | Complex task, break into subtasks |
| defer | Non-urgent, schedule for later |
| investigate | Unknown error, create investigation task |

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/lmstudio/status | Check LM Studio availability |
| GET /api/lmstudio/models | List loaded models |
| POST /api/lmstudio/completion | Local model completion |
| POST /api/lmstudio/analyze-task | Analyze task complexity |
| POST /api/lmstudio/classify-memory | Classify memory content |

## Design Decisions

1. **Mission Autonomy**: Full autonomy - COS can implement changes, run tests, commit without approval for managed apps
2. **Model Usage**: Local-first with LM Studio, no cloud API costs for thinking
3. **Self-Modification**: Full autonomy - COS can change its own base thinking model without user approval
4. **Failure Investigation**: Unattended by default - an `[Auto] Investigate agent failure` task runs without approval, because an isolated agent failure is exactly the work CoS exists to diagnose for itself. Approval is reserved for a failure *loop*, where another unattended agent would only repeat what already didn't work: the same cause investigated again within 24h (`repeat-fingerprint`), or the circuit-breaker hour already one slot from its cap (`failure-storm`). The reason is stamped on the task as the producer-agnostic `metadata.approvalReason` (`investigation-loop:<signal>`), which the Tasks UI turns into a hint on the APPROVE button. See `resolveInvestigationApproval` in `server/services/agentErrorAnalysis.js`.

## Persistent Mind task filing

The Persistent Mind has one explicit, default-off typed action, `cos.create-task`.
When the grant is enabled, each wake receives a bounded server-built catalog of
runnable apps and enabled CLI/TUI coding providers. The catalog includes each
provider's selectable models and effort levels, and marks apps whose effective
work tracker supports the issue-only **Plan & File Issue** workflow.

The mind may select the provider, model, effort, priority, delivery mode, and PR
completion policy per request. Implementation mode requires one of
`review-then-merge`, `merge-on-green`, or `leave-open`; plan-only mode is only
valid for GitHub/GitLab apps and is normalized to the existing unattended
`plan-task --yes` no-code/no-PR contract. The queue path revalidates every choice
after inference, so stale prompts, disabled providers, invented model ids, and
unsupported trackers fail closed.

Task model selection can be restricted in Persistent Mind Tools with an exact
provider/model allowlist. An empty list preserves the unrestricted catalog; a
non-empty list is applied to both the model choices sent to the mind and the
server-side queue admission check, which supports subscription-specific or
local-only task lanes. A removed or malformed allowlist fails closed.

`GET /api/cos/mind/tools` returns the authority inventory and, when task access is
granted, the same redacted task catalog used in the mind prompt. This keeps the
Mind Tools UI and the model-facing contract discoverable without granting the
mind arbitrary shell, filesystem, or general API access. Broader PortOS APIs
remain governed by their own authenticated route contracts and are not silently
made callable by enabling task filing.

## Test Coverage

| Test File | Module |
|-----------|--------|
| `server/lib/bm25.test.js` | BM25 Algorithm |
| `server/services/toolStateMachine.test.js` | Tool State Machine |
| `server/services/thinkingLevels.test.js` | Thinking Levels |
| `server/services/executionLanes.test.js` | Execution Lanes |
| `server/services/errorRecovery.test.js` | Error Recovery (not built) |
| `server/services/agentRunCache.test.js` | Agent Run Cache (not built) |
| `server/services/missions.test.js` | Missions Service |

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Core orchestration
- [Memory System](./memory-system.md) - Memory search integration
- [Error Handling](./error-handling.md) - Error recovery integration
