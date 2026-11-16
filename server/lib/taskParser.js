/**
 * Task Parser for the Markdown task format
 *
 * Parse and generate the Markdown task format (a task's stored form, and the input of db-migration
 * 018), and own the vocabularies it can represent: `TASK_STATUS_VALUES` / `TASK_PRIORITY_VALUES`
 * (derived from `STATUS_MAP` / `PRIORITY_VALUES`, read by `cosValidation.js` and
 * `peerSyncValidation.js` so the HTTP and wire enums cannot drift from the store), plus
 * `UNKNOWN_STATUS_BLOCKED_CATEGORY` — the marker `generateTasksMarkdown` stamps when it REPAIRS an
 * unrepresentable task instead of dropping its row (#7239).
 *
 * The CoS task queues are rows in `cos_tasks`. This format survives as a task's
 * STORED FORM (`lib/cosTaskRows.js` round-trips every task through one row, so
 * scalar metadata reads back as strings) and as the input of db-migration 018.
 *
 * Parses markdown task text with the following format:
 *
 * # Tasks
 *
 * ## Pending
 * - [ ] #task-001 | HIGH | Task description
 *   - Context: Additional context
 *   - App: app-name
 *
 * ## In Progress
 * - [~] #task-002 | MEDIUM | Another task
 *   - Agent: agent-id
 *   - Started: 2024-01-15T10:30:00Z
 *
 * ## Blocked
 * - [!] #task-003 | HIGH | Blocked task
 *   - Blocker: Waiting for API access
 *
 * ## Completed
 * - [x] #task-004 | LOW | Done task
 *   - Completed: 2024-01-14T15:45:00Z
 *
 * Internal CoS tasks can have approval flags:
 * - [ ] #sys-001 | HIGH | AUTO | Auto-approved task
 * - [ ] #sys-002 | MEDIUM | APPROVAL | Needs user approval
 */

// Canonical prefix lists — add new prefixes here, not in scattered startsWith checks.
//
// REGISTERING A PREFIX IS MANDATORY: an id whose prefix is absent here is
// rewritten to `task-<id>` on the next read, so the producer can no longer
// address its record (and the queue may see a SECOND task). Those best-effort
// reads and writes miss SILENTLY.
const INTERNAL_PREFIXES = ['sys-', 'app-improve-', 'cd-', 'preflight-', 'self-improve-'];
const ALL_KNOWN_PREFIXES = ['task-', ...INTERNAL_PREFIXES];

export const hasKnownPrefix = (id) => ALL_KNOWN_PREFIXES.some(p => id?.startsWith(p));
export const isInternalTaskId = (id) => INTERNAL_PREFIXES.some(p => id?.startsWith(p));

const STATUS_MAP = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[!]': 'blocked',
  // A sub-agent disputing a reviewer rejection parks the task here (#2441): work
  // is neither in-flight nor terminally blocked while the challenge is resolved.
  '[?]': 'challenged'
};

export const PRIORITY_VALUES = {
  'CRITICAL': 4,
  'HIGH': 3,
  'MEDIUM': 2,
  'LOW': 1
};

/**
 * The canonical task vocabularies, derived from the two maps above so nothing
 * can re-declare a drifting copy.
 *
 * `generateTasksMarkdown` can only REPRESENT these values: a status outside the
 * set lands in no section and a priority outside it fails `matchTaskLine` on the
 * next read, deleting the task. Validate against these at every boundary that can
 * set a status or priority (cosValidation.js, peerSyncValidation.js).
 */
export const TASK_STATUS_VALUES = Object.freeze([...new Set(Object.values(STATUS_MAP))]);
export const TASK_PRIORITY_VALUES = Object.freeze(Object.keys(PRIORITY_VALUES));

/**
 * The `blockedCategory` stamped on a task whose status was outside
 * TASK_STATUS_VALUES when the file was written. The task is parked rather than
 * dropped, and its original status is preserved in `metadata.unrepresentableStatus`
 * so a human (or a later migration) can resolve what it should have been.
 */
export const UNKNOWN_STATUS_BLOCKED_CATEGORY = 'unknown-status';

const REPAIRED_STATUS = 'blocked';
const REPAIRED_PRIORITY = 'MEDIUM';

/**
 * Write-side backstop: return a task the markdown format can actually represent.
 *
 * Coerce rather than throw: a task with an out-of-vocabulary value is repaired,
 * since a row that cannot be written is silently deleted.
 *
 * Never mutates its argument; a representable task is returned as-is. Exported
 * because the constructors (`cosTaskIntake.buildQueuedTask`,
 * `cosTaskStore.updateTask`) run it so what they emit matches what is stored.
 */
export function toRepresentableTask(task) {
  const statusOk = TASK_STATUS_VALUES.includes(task?.status);
  const priorityOk = TASK_PRIORITY_VALUES.includes(task?.priority);
  if (statusOk && priorityOk) return task;

  const repairs = [];
  if (!statusOk) repairs.push(`status \`${String(task?.status)}\` -> ${REPAIRED_STATUS}`);
  if (!priorityOk) repairs.push(`priority \`${String(task?.priority)}\` -> ${REPAIRED_PRIORITY}`);
  console.warn(`⚠️ Task ${task?.id} is not representable in the task format; repairing ${repairs.join(', ')}`);

  return {
    ...task,
    status: statusOk ? task.status : REPAIRED_STATUS,
    priority: priorityOk ? task.priority : REPAIRED_PRIORITY,
    priorityValue: priorityOk ? task.priorityValue : PRIORITY_VALUES[REPAIRED_PRIORITY],
    // A status repair ALWAYS stamps `unknown-status`: a prior category describes
    // some earlier block, and a reapable one would let the 14-day auto-expiry
    // complete the rescued task (see taskBlockCategories.js). The old value is kept.
    metadata: statusOk ? (task.metadata || {}) : {
      ...task?.metadata,
      ...(task?.metadata?.blockedCategory ? { priorBlockedCategory: task.metadata.blockedCategory } : {}),
      blockedCategory: UNKNOWN_STATUS_BLOCKED_CATEGORY,
      unrepresentableStatus: String(task?.status)
    }
  };
}

/**
 * Match a single task line into a raw task (no repair — see `pushTask`).
 * Format: - [ ] #task-001 | HIGH | Description
 * Or with approval flag: - [ ] #sys-001 | HIGH | AUTO | Description
 *
 * Patterns are tried in order. The first two are the format as written; the last
 * two are the RECOVERY path for rows an older install or a hand edit wrote: they
 * accept any non-pipe priority field and any checkbox character, so the row and
 * its indented metadata (including `metadata.prompt`) survive to be repaired
 * instead of dropped. That width also matches prose sentences, so no recovered
 * row is ever auto-approved (see `matchTaskLine`).
 */
const TASK_LINE_PATTERNS = [
  { withFlag: true, re: /^-\s*\[([ x~!?])\]\s*#([\w-]+)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(AUTO|APPROVAL)\s*\|\s*(.+)$/i },
  { withFlag: false, re: /^-\s*\[([ x~!?])\]\s*#([\w-]+)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(.+)$/i },
  { withFlag: true, recovery: true, re: /^-\s*\[([^\]])\]\s*#([\w-]+)\s*\|\s*([^|]+)\|\s*(AUTO|APPROVAL)\s*\|\s*(.+)$/i },
  { withFlag: false, recovery: true, re: /^-\s*\[([^\]])\]\s*#([\w-]+)\s*\|\s*([^|]+)\|\s*(.+)$/i }
];

function matchTaskLine(line) {
  for (const { re, withFlag, recovery } of TASK_LINE_PATTERNS) {
    const match = line.match(re);
    if (!match) continue;

    const [, statusChar, id, priority, ...rest] = match;
    // Lower-cased so a hand-written [X] means completed. A truly unknown marker
    // stays raw so toRepresentableTask parks the row as blocked instead of
    // defaulting it to a runnable pending row.
    const statusKey = `[${statusChar.toLowerCase()}]`;
    const approvalFlag = withFlag ? rest[0].toUpperCase() : null;
    const description = withFlag ? rest[1] : rest[0];

    const taskId = hasKnownPrefix(id) ? id : `task-${id}`;

    return {
      id: taskId,
      status: STATUS_MAP[statusKey] ?? statusKey,
      priority: priority.trim().toUpperCase(),
      priorityValue: PRIORITY_VALUES[priority.trim().toUpperCase()] || 2,
      // NO recovered row is auto-approved (#7300): recovery patterns can match a
      // `- [ ] #id | text | text` SENTENCE inside a legacy multi-line description,
      // and auto-approving it would spawn an agent from prose. The split is also
      // ambiguous when the priority field itself held a pipe, so which segment was
      // the approval flag is a guess. Recovered rows land in the approval queue.
      //
      // `approvalRequired`, not `autoApproved: false`, carries the hold: it is the
      // one signal BOTH files can write (`APPROVAL`), and every user task carries
      // `autoApproved: false`, so flagging on that would hold the whole user queue.
      // A strict match is untouched.
      approvalRequired: recovery || approvalFlag === 'APPROVAL',
      autoApproved: !recovery && (withFlag ? approvalFlag === 'AUTO' : true),
      description: description.trim(),
      metadata: {}
    };
  }
  return null;
}

// Sentinel prefix for JSON-encoded metadata values
const JSON_SENTINEL = '__json__:';

/**
 * Unescape newlines in metadata values.
 *
 * For values prefixed with the JSON sentinel (produced by escapeNewlines),
 * this uses JSON.parse to correctly restore backslashes, newlines, etc.
 * For legacy or simple values, falls back to simple replacement for backwards compatibility.
 */
function unescapeNewlines(value) {
  if (typeof value !== 'string') return value;
  // Check for explicit JSON sentinel prefix
  if (value.startsWith(JSON_SENTINEL)) {
    const jsonPart = value.slice(JSON_SENTINEL.length);
    try {
      return JSON.parse(jsonPart);
    } catch {
      // Fall through to legacy behavior if parsing fails
    }
  }
  // A genuine string `"null"` round-trips through the JSON sentinel, so an
  // unsentineled bare `null`/`undefined` is unambiguously nullish (older installs
  // persisted nullish values that way).
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  // Legacy pre-sentinel escaping only; new special-character values always use the
  // sentinel prefix (see escapeNewlines).
  return value.replace(/\\n/g, '\n');
}

/**
 * Escape newlines in metadata values.
 *
 * For values containing special characters (newlines, backslashes), uses JSON
 * string escaping with a sentinel prefix for reversibility. Simple values are stored as-is.
 * Arrays and objects are always JSON-encoded with the sentinel prefix.
 */
function escapeNewlines(value) {
  // Handle arrays and objects - always JSON encode
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON_SENTINEL + JSON.stringify(value);
  }
  if (typeof value !== 'string') return String(value);
  // Only use JSON encoding if the value contains characters that need escaping,
  // or would collide with the bare `null`/`undefined` unescapeNewlines reads
  // back as the nullish value.
  if (value.includes('\n') || value.includes('\\') || value === 'null' || value === 'undefined') {
    return JSON_SENTINEL + JSON.stringify(value);
  }
  return value;
}

/**
 * Parse metadata line (indented under task)
 * Format:   - key: Value
 * Keys are written in camelCase (e.g., openPR, useWorktree, reviewLoop).
 * Legacy Title-Case keys (e.g., Context, App) are accepted and normalized
 * to camelCase by lowercasing the first character.
 */
function parseMetadataLine(line) {
  const match = line.match(/^\s+-\s*(\w+):\s*(.+)$/);
  if (!match) return null;

  // Normalize key: lowercase first character to handle legacy Title-Case keys (Context→context,
  // App→app) while preserving camelCase keys (openPR stays openPR, useWorktree stays useWorktree)
  const rawKey = match[1];
  const key = rawKey.charAt(0).toLowerCase() + rawKey.slice(1);
  return {
    key,
    value: unescapeNewlines(match[2].trim())
  };
}

/**
 * Parse TASKS.md content into structured data
 */
export function parseTasksMarkdown(content) {
  const lines = content.split('\n');
  const tasks = [];
  const seenIds = new Set();
  let currentTask = null;
  let currentSection = null;

  // Pre-scan ids so suffix assignment never collides with a later user-authored
  // id; we rename the duplicate, never the unique original.
  const rawIds = new Set();
  for (const line of lines) {
    if (line.startsWith('- [')) {
      const parsed = matchTaskLine(line);
      if (parsed) rawIds.add(parsed.id);
    }
  }

  // Push a fully-parsed task with a file-unique id: duplicates would collapse in
  // id-keyed consumers (reorderTasks' Map). Suffix (`-dup2`, …) and warn rather
  // than throw, so one corrupted file cannot crash every read. Called once per
  // task, after its metadata lines are attached.
  const pushTask = (task) => {
    if (!task) return;
    if (seenIds.has(task.id)) {
      const originalId = task.id;
      let suffix = 2;
      // Skip suffixes already taken AND any raw id in the file, so we never
      // rename a distinct task that happens to look like a generated suffix.
      while (seenIds.has(`${originalId}-dup${suffix}`) || rawIds.has(`${originalId}-dup${suffix}`)) suffix++;
      task.id = `${originalId}-dup${suffix}`;
      console.warn(`⚠️ Duplicate task id "${originalId}" in tasks markdown — renamed to "${task.id}"`);
    }
    seenIds.add(task.id);
    // Repair HERE, not at match time: a later `blockedCategory` metadata line
    // would otherwise overwrite the `unknown-status` hold the repair stamped.
    tasks.push(toRepresentableTask(task));
  };

  for (const line of lines) {
    // Section headers
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, '_');
      continue;
    }

    // Skip main title and empty lines
    if (line.startsWith('# ') || line.trim() === '') {
      continue;
    }

    // Task line
    if (line.startsWith('- [')) {
      pushTask(currentTask);
      currentTask = matchTaskLine(line);
      if (currentTask) {
        currentTask.section = currentSection;
      }
      continue;
    }

    // Metadata line (indented)
    if (currentTask && line.match(/^\s+-\s*\w+:/)) {
      const meta = parseMetadataLine(line);
      if (meta) {
        currentTask.metadata[meta.key] = meta.value;
      }
    }
  }

  // Don't forget last task
  pushTask(currentTask);

  return tasks;
}

/**
 * Group tasks by status
 */
export function groupTasksByStatus(tasks) {
  return {
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    challenged: tasks.filter(t => t.status === 'challenged'),
    blocked: tasks.filter(t => t.status === 'blocked'),
    completed: tasks.filter(t => t.status === 'completed')
  };
}

/**
 * Sort tasks by priority (highest first)
 */
export function sortByPriority(tasks) {
  return [...tasks].sort((a, b) => b.priorityValue - a.priorityValue);
}

/**
 * Last-resort write-side guard: a task row is a ONE-LINE record, so a newline in
 * `description` re-parses as file structure (injected metadata such as
 * `  - app: x`, or a whole extra auto-approved task).
 *
 * Callers normalize first (`cosTaskStore.addTask` / `writeTaskUpdate` re-home the
 * body into `metadata.prompt` / `metadata.context`); reaching this means the body
 * was NOT preserved anywhere, hence the loud warning.
 */
function flattenDescription(task) {
  const description = task.description;
  if (typeof description !== 'string' || !/\r?\n/.test(description)) return description;
  console.warn(`⚠️ Flattened newline(s) in task ${task.id} description for single-line markdown storage`);
  return description.replace(/\r?\n/g, ' ');
}

/**
 * The `| AUTO |` / `| APPROVAL |` segment a task row carries, or `''`.
 *
 * The internal file uses the whole vocabulary: a task carrying `autoApproved`
 * states it, and a held one says APPROVAL.
 *
 * The user file carries ONLY the hold (`APPROVAL` when withheld from the
 * unattended spawn), so the hold is never inferred from a recovery match that the
 * next write erases. It keys on `approvalRequired`, not the internal side's wider
 * `heldBack`: `buildQueuedTask` mints every user task with `autoApproved: false`,
 * so flagging that would hold the entire user queue on its first rewrite.
 */
function approvalFlagSegment(task, includeApprovalFlags) {
  if (!includeApprovalFlags) return task.approvalRequired === true ? ' | APPROVAL' : '';
  // `autoApproved === false` writes APPROVAL: it is the only flag that survives
  // the round trip as a hold. `undefined` is NOT that claim and stays flagless.
  const heldBack = task.approvalRequired || task.autoApproved === false;
  if (heldBack) return ' | APPROVAL';
  return task.autoApproved !== undefined ? ' | AUTO' : '';
}

/**
 * Generate TASKS.md content from tasks array
 * @param {boolean} includeApprovalFlags - Whether to include the full AUTO/APPROVAL
 *   vocabulary (for internal CoS tasks). The user file writes only the APPROVAL
 *   hold — see `approvalFlagSegment`.
 */
export function generateTasksMarkdown(tasks, includeApprovalFlags = false) {
  // Repair BEFORE grouping: an unrepresentable status falls out of every bucket
  // and would be written nowhere.
  const grouped = groupTasksByStatus(tasks.map(toRepresentableTask));
  const lines = ['# Tasks', ''];

  const statusToCheckbox = {
    'pending': '[ ]',
    'in_progress': '[~]',
    'challenged': '[?]',
    'blocked': '[!]',
    'completed': '[x]'
  };

  const sections = [
    { key: 'pending', title: 'Pending' },
    { key: 'in_progress', title: 'In Progress' },
    { key: 'challenged', title: 'Challenged' },
    { key: 'blocked', title: 'Blocked' },
    { key: 'completed', title: 'Completed' }
  ];

  for (const section of sections) {
    const sectionTasks = grouped[section.key];
    if (sectionTasks.length === 0) continue;

    lines.push(`## ${section.title}`);

    for (const task of sortByPriority(sectionTasks)) {
      const checkbox = statusToCheckbox[task.status];
      const approvalFlag = approvalFlagSegment(task, includeApprovalFlags);
      lines.push(`- ${checkbox} #${task.id} | ${task.priority}${approvalFlag} | ${flattenDescription(task)}`);

      // Pass the raw value: escapeNewlines JSON-encodes arrays/objects itself, and
      // pre-stringifying would flatten them.
      // Nullish values are DROPPED: a bare `null` would re-parse as the TRUTHY
      // string `'null'`, and producers build metadata with `?? null` placeholders.
      // An absent key already means "not set" to every reader.
      for (const [key, value] of Object.entries(task.metadata)) {
        if (value === null || value === undefined) continue;
        const escapedValue = escapeNewlines(value);
        lines.push(`  - ${key}: ${escapedValue}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Filter tasks that can be auto-executed
 */
export function getAutoApprovedTasks(tasks) {
  return tasks.filter(t => t.autoApproved && !t.approvalRequired && t.status === 'pending');
}

/**
 * Filter tasks awaiting user approval
 */
export function getAwaitingApprovalTasks(tasks) {
  return tasks.filter(t => t.approvalRequired && t.status === 'pending');
}

/**
 * Update a task's status in the tasks array
 */
export function updateTaskStatus(tasks, taskId, newStatus, metadata = {}) {
  return tasks.map(task => {
    if (task.id === taskId) {
      return {
        ...task,
        status: newStatus,
        metadata: { ...task.metadata, ...metadata }
      };
    }
    return task;
  });
}

/**
 * Add a new task
 */
export function addTask(tasks, { id, priority = 'MEDIUM', description, metadata = {} }) {
  const newTask = {
    id: hasKnownPrefix(id) ? id : `task-${id}`,
    status: 'pending',
    priority: priority.toUpperCase(),
    priorityValue: PRIORITY_VALUES[priority.toUpperCase()] || 2,
    description,
    metadata,
    section: 'pending'
  };

  return [...tasks, newTask];
}
