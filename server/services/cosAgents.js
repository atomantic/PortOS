/**
 * CoS Agents Module (barrel)
 *
 * Agent lifecycle management, previously a single ~1090-line file. Decomposed
 * (issue #2530) into focused sibling modules; this file stays as a thin barrel
 * so every existing `from './cosAgents.js'` import path keeps working:
 *
 * - cosAgentIndex.js     — date-bucket index, migration, prune, archive layout
 * - cosAgentLifecycle.js — register / update / complete / output / terminate /
 *                          pause / kill / BTW / zombie cleanup / single reads
 * - cosAgentFeedback.js  — per-agent feedback capture + aggregation + classifier
 * - cosAgentArchive.js   — state-eviction sweeps (archive stale, clear completed)
 */

export * from './cosAgentIndex.js';
export * from './cosAgentLifecycle.js';
export * from './cosAgentFeedback.js';
export * from './cosAgentArchive.js';
