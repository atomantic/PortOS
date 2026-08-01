// CoS task-learning bucket resolver for client-side duration displays.
//
// MIRROR: keep this aligned with server/services/taskLearning/store.js's
// extractTaskType(). The server owns outcome metrics; matching its bucket here
// keeps an ETA attached to the same historical runs that produced it.

export const EXTERNAL_UNTYPED_TASK_TYPE = 'external/untyped';

const SANDBOXED_TASK_TYPES = new Set([EXTERNAL_UNTYPED_TASK_TYPE, 'unknown']);
const KNOWN_UNSPECIALIZED_TASK_TYPES = new Set([
  'scheduled', 'test', 'architect', 'layered-intelligence', 'all'
]);

const DESCRIPTION_CLASSIFIERS = [
  { type: 'auto-fix', re: /\b(fix|bug|crash|broken|failing|regression|investigate|stack ?trace)\b/ },
  { type: 'self-improve:general', re: /\b(refactor|clean ?up|simplif\w*|optimi[sz]\w*|improve|enhance)\b/ },
  { type: 'idle-review', re: /\b(review|audit|inspect)\b/ },
  { type: 'test-task', re: /\b(unit test|coverage|test suite|write tests?)\b/ }
];

const slugTaskType = (raw) => String(raw).trim().toLowerCase()
  .replace(/[^a-z0-9:_-]+/g, '-')
  .replace(/^-+|-+$/g, '');

function classifyUntypedTask(task) {
  if (!task || typeof task !== 'object') return EXTERNAL_UNTYPED_TASK_TYPE;
  if (SANDBOXED_TASK_TYPES.has(task.taskType)) return task.taskType;

  const selfImprovementType = task.metadata?.selfImprovementType;
  if (typeof selfImprovementType === 'string' && selfImprovementType.trim()) {
    return `self-improve:${slugTaskType(selfImprovementType)}`;
  }

  const explicit = task.taskType;
  if (typeof explicit === 'string' && explicit.trim() && explicit !== 'unknown') {
    const slug = slugTaskType(explicit);
    if (slug.includes(':')) return slug;
    if (KNOWN_UNSPECIALIZED_TASK_TYPES.has(slug)) return `${slug}-task`;
  }

  const desc = (task.description || task.metadata?.taskDescription || '').toLowerCase();
  for (const { type, re } of DESCRIPTION_CLASSIFIERS) {
    if (re.test(desc)) return type;
  }
  return EXTERNAL_UNTYPED_TASK_TYPE;
}

// Resolve the same low-cardinality task-learning bucket used by the server.
// Accepts both live task records and archived agent metadata projections.
export function extractCosTaskType(task) {
  const analysisType = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType;
  if (analysisType) return `self-improve:${analysisType}`;

  const reviewType = task?.metadata?.reviewType || task?.metadata?.taskReviewType;
  if (reviewType === 'idle') return 'idle-review';

  if (task?.metadata?.missionName) return `mission:${task.metadata.missionName}`;

  if (task?.metadata?.taskApp && task?.metadata?.selfImprovementType) {
    return `app-improve:${task.metadata.selfImprovementType}`;
  }

  const desc = (task?.description || '').toLowerCase();
  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*([\w-]+)/i);
    return typeMatch ? `self-improve:${typeMatch[1]}` : 'self-improve:general';
  }
  if (desc.includes('[idle review]')) return 'idle-review';
  if (desc.includes('[auto-fix]') || desc.includes('[auto] investigate')) return 'auto-fix';
  if (desc.includes('[app-improvement]') || desc.includes('[app improvement]')) return 'app-improvement';
  if (task?.taskType === 'user') return 'user-task';
  if (task?.taskType === 'internal') return 'internal-task';

  return classifyUntypedTask(task);
}
