# Codebase Concerns

**Analysis Date:** 2026-02-26

## Tech Debt

**Large Service Files (>3000 LOC):**
- Issue: Core services have grown monolithic with mixed responsibilities
- Files: `server/services/cos.js` (3763 LOC), `server/services/subAgentSpawner.js` (3145 LOC), `server/services/digital-twin.js` (2823 LOC)
- Impact: Harder to test, refactor, and reason about code flow; increased cognitive load for maintainers
- Fix approach: Extract services into focused modules (e.g., agent indexing, state management, spawning logic into separate files); consider facade pattern to reduce coupling

**Race Conditions in File State Management:**
- Issue: Multiple services write to shared JSON state files without coordinated locking
- Files: `server/services/cos.js`, `server/services/memory.js`, `server/services/taskSchedule.js`
- Current mitigation: Mutex locks exist in `memory.js` (line 48: `createMutex()`) but not consistently applied to cos.js state mutations
- Impact: Risk of corrupted state.json, index.json, or embeddings.json on concurrent writes; loss of agent metadata
- Fix approach: Wrap all state mutations in `withLock()` in cos.js; implement atomic write-via-temp-file pattern consistently across all state files

**Unprotected Atomic Write Operations:**
- Issue: `writeFile` → `rename` sequences in `cos.js` (lines 429-430, 108-112) attempt atomicity but catch handlers swallow errors
- Files: `server/services/cos.js` (lines 108-112: agent index save), `server/lib/fileUtils.js` (no fallback for atomic writes)
- Impact: On rename failure, temp files accumulate in data/cos; corrupt writes if process crashes between writeFile and rename
- Fix approach: Implement guaranteed atomic writes with rollback; add cleanup for orphaned temp files on startup; log critical failures

**Missing Mutex in CoS State Mutations:**
- Issue: CoS daemon writes state without mutex protection while sub-agents read/update agents
- Files: `server/services/cos.js` (state writes at lines 429-430)
- Impact: Sub-agent updates to agent metadata can collide with CoS state persistence; lost updates
- Fix approach: Create dedicated state manager with `withLock()` wrapper for all state.json mutations

## Known Bugs

**Agent Index Migration Incomplete:**
- Symptoms: Agents created before date-bucket migration may not be found on subsequent runs
- Files: `server/services/cos.js` (lines 96-98, 160-228)
- Trigger: Migration runs once on first access to `loadAgentIndex()`; if migration fails silently, old flat agents are orphaned
- Workaround: Manually move agent directories from `data/cos/agents/` to `data/cos/agents/YYYY-MM-DD/` buckets
- Fix approach: Add recovery log for failed migrations; implement rollback mechanism; add startup validation

**Challenge Solver AI Timeout Vulnerability:**
- Symptoms: Moltbook posts get stuck in "verification_required" state indefinitely
- Files: `server/integrations/moltbook/challengeSolver.js` (lines 52-84)
- Trigger: AI provider timeout (specified as `provider.timeout || 300000` = 5min) exceeds verification window (Moltbook requires answer within ~5 minutes)
- Impact: Post never publishes; no retry mechanism; user must manually re-attempt
- Workaround: Lower challenge solving timeout or ensure LM Studio is responsive
- Fix approach: Add exponential backoff with per-attempt timeout reduction; implement verification retry with new challenge; cache solved challenges

**Memory Embeddings Out-of-Sync:**
- Symptoms: Memory search returns low-quality results; embeddings vector dimension mismatches
- Files: `server/services/memory.js` (lines 88-95), `server/services/memoryEmbeddings.js`
- Trigger: Provider changed without regenerating all embeddings; embedding config updated mid-operation
- Impact: New memories use correct dimension, old ones don't; BM25 fallback masks the issue
- Fix approach: Add migration tool to regenerate embeddings on provider change; validate dimension consistency on load; batch re-embed on startup

**Moltbook API Verification State Not Persisted:**
- Symptoms: Successfully verified posts lose verification state on restart
- Files: `server/integrations/moltbook/api.js` (line 59: `data.verification_solved = true`)
- Trigger: State held in-memory only; not written to persistent queue file
- Impact: Post verification succeeds but isn't recorded; re-attempts verification on next run
- Fix approach: Persist verification_solved flag in post queue; check flag before re-verifying

## Security Considerations

**Challenge Solver AI Injection Risk:**
- Risk: User-controlled task descriptions flow into LLM prompt for challenge solving
- Files: `server/integrations/moltbook/challengeSolver.js` (lines 35-40)
- Current mitigation: None; prompt is user-controlled via task.metadata.context
- Recommendations: Sanitize challenge text before passing to LLM; add prompt injection detection; use structured format (JSON) instead of free-form text

**Command Security Allowlist Not Enforced in All Paths:**
- Risk: Some services may bypass `server/lib/commandSecurity.js` validation
- Files: `server/lib/commandSecurity.js`, various services executing shell commands
- Current mitigation: Primary routes validated; integrations (Moltbook/world APIs) may spawn processes without checks
- Recommendations: Audit all `exec`, `execFile`, `spawn` calls; centralize command execution with mandatory allowlist check

**Plaintext Credential Storage in Provider Configuration:**
- Risk: API keys, tokens, and credentials stored in `data/providers.json` as plaintext
- Files: `server/data/providers.json`
- Current mitigation: File permissions (644 by default); deployed behind Tailscale but accessible if machine compromised
- Recommendations: Implement encryption-at-rest for sensitive provider fields; use environment variables for critical credentials; rotate provider secrets regularly

**WebSocket Events Broadcast Without Sanitization on All Paths:**
- Risk: Error context emitted via Socket.IO may contain sensitive data
- Files: `server/lib/errorHandler.js` (lines 110-130 implements sanitization)
- Current mitigation: Context sanitization exists in errorHandler
- Recommendations: Audit all `cosEvents.emit()` and `io.emit()` calls to ensure no PII/credentials escape; add audit logging for security-relevant events

## Performance Bottlenecks

**Agent Index Loaded Into Memory:**
- Problem: Agent index (Map of agentId → date-bucket) requires full file read/parse on each access
- Files: `server/services/cos.js` (lines 83-100)
- Cause: Lazy-load pattern reads entire INDEX_FILE on first access; no caching invalidation on new agents
- Current state: Index is ~50KB (described as avoiding 16MB full cache), cached in-memory after load
- Improvement path: Use persistent cache with file-watch invalidation; consider LRU cache for large deployments; implement background index updates

**Memory Search with Dual-Path Fallback:**
- Problem: Every memory search tries vector embedding first, then falls back to BM25 if embeddings unavailable
- Files: `server/services/memory.js` (multiple search functions with fallback logic)
- Cause: Embedding provider availability is external dependency; BM25 adds latency
- Improvement path: Cache search index to disk; pre-compute BM25 on memory upsert; parallelize embedding availability check

**CoS State Loaded Synchronously on Every Daemon Cycle:**
- Problem: Full state.json read on each task cycle without incremental updates
- Files: `server/services/cos.js` (state loading in main loop)
- Cause: No state subscription/change tracking; daemon re-reads full file repeatedly
- Improvement path: Implement state change stream; use file watch or atomic updates-only; consider in-memory state with periodic flush

**History File Grows Unbounded:**
- Problem: `data/history.json` accumulates all-time execution history
- Files: Various services append to history without truncation
- Current state: Unknown size; no pruning mechanism observed
- Improvement path: Implement rolling window (keep last N entries or last 30 days); archive old history; use JSONL with streaming reads

**DevTools Page Re-renders All Components on State Change:**
- Problem: Large tabbed interface in DevTools.jsx (2758 LOC) may cause full re-renders
- Files: `client/src/pages/DevTools.jsx`
- Cause: Centralized state management; no component-level memoization observed
- Improvement path: Split tabs into separate components; implement React.memo; use context selectors; lazy-load inactive tabs

## Fragile Areas

**SubAgent Spawner Task Classification:**
- Files: `server/services/subAgentSpawner.js` (lines 49-62: extractTaskTypeKey, 72-112: detectSkillTemplate)
- Why fragile: Task type detection relies on string matching in description; brittle pattern matching for skill templates (e.g., "[self-improvement]" marker must be exact)
- Safe modification: Add regression tests for new task types before changing matchers; implement fuzzy matching for skill detection; add logging for unmatched tasks
- Test coverage: `subAgentSpawner.test.js` exists; coverage gaps on skill detection and edge cases

**Moltbook Integration Rate Limiting:**
- Files: `server/integrations/moltbook/rateLimits.js`, `server/integrations/moltbook/api.js`
- Why fragile: External rate limits (unknown specs for Moltbook API) not enforced; API responses may contain throttle headers not currently parsed
- Safe modification: Add response header parsing for `Retry-After`, `X-RateLimit-*`; log actual rate limit responses; implement adaptive backoff
- Test coverage: No tests for rate limit edge cases

**Task Watcher File Monitoring:**
- Files: `server/services/taskWatcher.js`
- Why fragile: Depends on reliable file system watch events; TASKS.md changes may be missed if fs.watch is unreliable on the system
- Safe modification: Add poll-based fallback; implement CRC hash validation; test on target OS
- Test coverage: Unknown; watch behavior is notoriously platform-dependent

**Provider Status Fallback Chain:**
- Files: `server/services/providerStatus.js` (line 20: defaultFallbackPriority)
- Why fragile: Hard-coded fallback list may not match available providers; if all providers in chain fail, no fallback defined
- Safe modification: Generate fallback chain dynamically based on available providers; add sentinel provider (console-based); test with single provider available
- Test coverage: No tests for fallback chain exhaustion

## Scaling Limits

**Single State Machine for All Agent Executions:**
- Current capacity: Unknown; depends on PM2 process limits and concurrent CoS runner instances
- Limit: Event-driven architecture may bottleneck if many agents spawn simultaneously
- Scaling path: Implement execution lanes/queues with configurable concurrency; separate spawner process; use work queue (Redis-like) for agent scheduling

**Date-Bucket Directory Structure for Agents:**
- Current capacity: One directory per day; subdirectories per agent
- Limit: File system readdir() scales linearly with directory size; millions of agents across months will be slow
- Scaling path: Implement multi-level bucketing (YYYY/MM/DD or by agent hash); consider flat file database (SQLite) for agent metadata

**In-Memory Index for All Memories:**
- Current capacity: Unknown; embeddings cache can grow to MB for large memory databases
- Limit: 10,000 max memories configured; embeddings vector (768 dimension) = ~3KB per memory ≈ 30MB max
- Scaling path: Implement lazy-loading per category; use disk-backed vector DB (Milvus, Qdrant); implement memory consolidation/pruning

**WebSocket Event Broadcasting to All Clients:**
- Current capacity: Unknown; `io.emit()` broadcasts to all connected clients
- Limit: Many clients + large log events = saturated network
- Scaling path: Implement rooms/namespaces per dashboard view; filter events client-side; add event sampling for high-frequency logs

## Dependencies at Risk

**portos-ai-toolkit ^0.5.0:**
- Risk: Non-breaking version; if toolkit API changes (e.g., provider field structure), PortOS may break without major version bump
- Impact: Provider configuration could become incompatible; sub-agent spawning could fail if toolkit's model selection changes
- Migration plan: Pin to specific version (0.5.0) until ready to test 0.6.x; implement compatibility layer for provider config; test with toolkit updates before deploying

**PM2 ^5.4.3:**
- Risk: Node-based process manager; process spawning reliability depends on PM2 internals; ECMAScript module support was recently added
- Impact: If PM2 has bugs with ESM modules, app lifecycle management breaks; agent processes may not restart correctly
- Migration plan: Monitor PM2 changelog; test process recovery scenarios regularly; have fallback (systemd/Docker) ready

**Node-PTY ^1.2.0-beta.10:**
- Risk: Beta version with ongoing development; PTY handling is low-level and platform-specific
- Impact: Shell command execution may fail or hang; character encoding issues in CLI output; terminal resize events may be lost
- Migration plan: Monitor for stable release; implement timeout/cancellation for PTY commands; test on target OS before updating

**Zod ^3.24.1:**
- Risk: While stable, no major concerns; however, validation schemas scattered across `server/lib/validation.js` and route files
- Impact: Schema changes require updates in multiple places; potential inconsistency
- Migration plan: Consider centralized schema registry; implement schema versioning

## Missing Critical Features

**No Persistent Queue for Failed Tasks:**
- Problem: If CoS daemon crashes mid-task, in-progress agents may be lost or orphaned
- Blocks: Reliable autonomous job execution; task recovery after outages
- Fix approach: Implement persistent task queue (file-based or Redis); implement checkpoint/resume for agents; track agent lineage

**No Data Validation on Load (JSON Files):**
- Problem: Corrupted state.json, embeddings.json, or index.json can crash services
- Blocks: Reliable startup after unclean shutdown
- Fix approach: Implement Zod schema validation on all file loads; add recovery/rollback for corrupted files; implement backup rotation

**No Audit Logging for Critical Operations:**
- Problem: No record of who triggered what, when, or why (important for autonomous system)
- Blocks: Debugging issues; security investigation; accountability
- Fix approach: Implement audit log to `data/cos/audit.jsonl`; log all task creations, agent spawns, provider changes, memory mutations; implement retention policy

**No Graceful Degradation for Missing Providers:**
- Problem: If embedding provider (LM Studio) is offline, all memory operations hang or fail
- Blocks: Resilience to infrastructure changes; usability during provider maintenance
- Fix approach: Add provider health checks; implement memory-only mode without embeddings; queue embeddings until provider recovers

**No Rate Limiting on Sub-Agent Spawning:**
- Problem: Rapid task creation could spawn unbounded agents, exhausting system resources
- Blocks: Resource safety; preventing runaway CoS daemon
- Fix approach: Implement execution lanes with configurable limits; add task queue with backpressure; expose limits in settings

## Test Coverage Gaps

**Critical Services Without Tests:**
- Files: `server/services/cos.js` (no dedicated test file; core daemon logic untested)
- What's not tested: Daemon startup/shutdown cycles, state persistence, agent spawning coordination, error recovery
- Risk: Daemon bugs can cause data loss or orphaned processes; hard to refactor safely
- Priority: High

**File System Operations Not Tested:**
- Files: `server/services/cos.js`, `server/lib/fileUtils.js`
- What's not tested: Atomic write failures, concurrent file access, corruption recovery, migration edge cases
- Risk: State corruption under load or after crashes
- Priority: High

**External Integration Failures:**
- Files: `server/integrations/moltbook/` and `server/integrations/moltworld/`
- What's not tested: Rate limit exhaustion, network timeouts, malformed API responses, challenge solving edge cases
- Risk: Silent failures in autonomous posting; posts get stuck in unknown states
- Priority: Medium

**Provider Fallback Chain:**
- Files: `server/services/providerStatus.js`, `server/services/subAgentSpawner.js`
- What's not tested: All providers in fallback chain unavailable, provider switching mid-execution, model availability edge cases
- Risk: Sub-agents fail with unclear errors; no model available to escalate to
- Priority: Medium

**Memory Search Path with Embeddings Unavailable:**
- Files: `server/services/memory.js`, `server/services/memoryBM25.js`
- What's not tested: Embedding provider offline, partial embeddings available (some memories have vectors, some don't), vector dimension mismatch
- Risk: Memory search returns inconsistent results or crashes
- Priority: Medium

**Client WebSocket Reconnection:**
- Files: `client/src/services/socket.js`
- What's not tested: Rapid reconnect/disconnect cycles, message loss during disconnection, stale state after reconnect
- Risk: UI out of sync with server; lost notifications
- Priority: Low

---

*Concerns audit: 2026-02-26*
