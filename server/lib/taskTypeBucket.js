/**
 * CoS task-learning bucket classifier. Pure and browser-safe: the server's
 * outcome store and the client's ETA lookup (client/src/lib/cosTaskType.js
 * re-exports this) must resolve a task to the same bucket, so there is one copy.
 */
import { currentTaskTypeName } from './taskTypeRenames.js';

/**
 * Sandboxed fallback type for executions the classifier can't map to a known
 * domain (issue #2333). Replaces the old blind `'unknown'` sink so untyped work
 * still flows through outcome learning + failure-signature harvesting, while
 * being explicitly walled off from routing influence (see `isSandboxedTaskType`
 * consumers in routing.js) — a heterogeneous grab-bag must never drive a tier
 * suggestion or globally skip all untyped work (which would create a routing
 * blind spot / loop).
 */
export const EXTERNAL_UNTYPED_TASK_TYPE = 'external/untyped';

// The new sandboxed fallback plus the legacy `'unknown'` sink it replaces. Older
// installs still hold `'unknown'` buckets from before the classifier (and the
// spawn-time key in agentModelSelection.js) migrated onto the sandboxed bucket, so
// it keeps the same wall: stale/heterogeneous uncategorized data must never drive a
// tier suggestion or globally skip work.
const SANDBOXED_TASK_TYPES = new Set([EXTERNAL_UNTYPED_TASK_TYPE, 'unknown']);

/**
 * True when a task type is a sandboxed fallback bucket (not a real learned
 * domain). Callers in routing.js gate on this to keep the fallback from
 * influencing model-tier suggestions or skip/rehabilitation gating.
 */
export const isSandboxedTaskType = (taskType) => SANDBOXED_TASK_TYPES.has(taskType);

/**
 * Ordered description-keyword → concrete-type rules, tried only as a last resort
 * before the sandboxed fallback. First match wins. Patterns are whole-word/stem
 * tests (`\b…`) so a substring can't false-positive (e.g. "testing" ⊄ trigger of
 * an unrelated word). Kept deliberately conservative — a wrong concrete label is
 * worse than an honest `external/untyped`.
 */
const DESCRIPTION_CLASSIFIERS = [
  { type: 'auto-fix', re: /\b(fix|bug|crash|broken|failing|regression|investigate|stack ?trace)\b/ },
  { type: 'self-improve:general', re: /\b(refactor|clean ?up|simplif\w*|optimi[sz]\w*|improve|enhance)\b/ },
  { type: 'idle-review', re: /\b(review|audit|inspect)\b/ },
  { type: 'test-task', re: /\b(unit test|coverage|test suite|write tests?)\b/ }
];

/**
 * Concrete `task.taskType` values (beyond user/internal, resolved upstream) that
 * map to a real learned domain. Allow-listed rather than accepting any string so
 * an unexpected/high-cardinality taskType can't spawn a swarm of non-sandboxed
 * singleton buckets that skew routing — anything not here falls through to the
 * description heuristics and, failing that, the sandboxed fallback.
 */
const KNOWN_UNSPECIALIZED_TASK_TYPES = new Set([
  'scheduled', 'test', 'architect', 'layered-intelligence', 'all'
]);

/** Normalize a raw task-type token to a stable, low-cardinality slug. */
function slugTaskType(raw) {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Classify a task that the primary `extractTaskType` heuristics left untyped
 * (issue #2333). Pure, deterministic (idempotent — same input → same output),
 * and side-effect free / O(1) over a few short regexes, so it stays well under
 * the <50ms execution-entry budget. Inspects additional signals in priority
 * order — a self-improvement metadata hint, an explicit `task.taskType` the
 * primary extractor didn't special-case, then broader description keyword
 * signatures — and only falls back to the sandboxed `external/untyped` type
 * (never the old `'unknown'`) when nothing matches.
 */
export function classifyUntypedTask(task) {
  if (!task || typeof task !== 'object') return EXTERNAL_UNTYPED_TASK_TYPE;

  // Round-trip safety: re-classifying an already-classified task by its own
  // recorded type must be stable and preserve the sandboxed bucket (the fallback
  // string's `/` would otherwise be slugged to a non-sandboxed `-task` below).
  if (isSandboxedTaskType(task?.taskType)) return task.taskType;

  // 1) A self-improvement hint not paired with a taskApp (that pairing is
  //    handled by the primary extractor upstream).
  const selfImprovementType = task?.metadata?.selfImprovementType;
  if (typeof selfImprovementType === 'string' && selfImprovementType.trim()) {
    return `self-improve:${slugTaskType(selfImprovementType)}`;
  }

  // 2) An explicit task.taskType the primary extractor didn't special-case
  //    (user/internal are resolved upstream). Map an already-namespaced type
  //    (`a:b`) or an allow-listed known domain to a concrete bucket; anything
  //    else falls through so an unexpected value can't skew routing.
  const explicit = task?.taskType;
  if (typeof explicit === 'string' && explicit.trim() && explicit !== 'unknown') {
    const slug = slugTaskType(explicit);
    if (slug.includes(':')) return slug;
    if (KNOWN_UNSPECIALIZED_TASK_TYPES.has(slug)) return `${slug}-task`;
  }

  // 3) Broader description keyword signatures (bracket-tag patterns already ran
  //    upstream; this catches free-form descriptions).
  const desc = (task?.description || task?.metadata?.taskDescription || '').toLowerCase();
  if (desc) {
    for (const { type, re } of DESCRIPTION_CLASSIFIERS) {
      if (re.test(desc)) return type;
    }
  }

  // 4) Nothing matched — sandboxed fallback (never 'unknown').
  return EXTERNAL_UNTYPED_TASK_TYPE;
}

/**
 * Extract task type from task description or metadata
 */
export function extractTaskType(task) {
  // Check for self-improvement type in metadata (direct or forwarded from task)
  // A task queued before a rename (TASK_TYPE_RENAMES) records into the current
  // bucket, which migration 417 moved the pre-rename history into.
  const analysisType = currentTaskTypeName(task?.metadata?.analysisType || task?.metadata?.taskAnalysisType);
  if (analysisType) {
    return `self-improve:${analysisType}`;
  }

  // Check for idle review
  const reviewType = task?.metadata?.reviewType || task?.metadata?.taskReviewType;
  if (reviewType === 'idle') {
    return 'idle-review';
  }

  // Check for mission tasks
  if (task?.metadata?.missionName) {
    return `mission:${task.metadata.missionName}`;
  }

  // Check for app improvement tasks
  if (task?.metadata?.taskApp && task?.metadata?.selfImprovementType) {
    return `app-improve:${currentTaskTypeName(task.metadata.selfImprovementType)}`;
  }

  // Check description patterns
  const desc = (task?.description || '').toLowerCase();

  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*([\w-]+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
    return 'self-improve:general';
  }

  if (desc.includes('[idle review]')) {
    return 'idle-review';
  }

  if (desc.includes('[auto-fix]') || desc.includes('[auto] investigate')) {
    return 'auto-fix';
  }

  if (desc.includes('[app-improvement]') || desc.includes('[app improvement]')) {
    return 'app-improvement';
  }

  // User task classification
  if (task?.taskType === 'user') {
    return 'user-task';
  }

  // Internal/system tasks that don't match a specific pattern
  if (task?.taskType === 'internal') {
    return 'internal-task';
  }

  // Execution-entry classification hook (issue #2333): before giving up to the
  // old blind 'unknown' sink, inspect additional signals to infer a concrete
  // domain, else return the sandboxed `external/untyped` fallback.
  return classifyUntypedTask(task);
}
