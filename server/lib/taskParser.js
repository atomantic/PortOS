/**
 * Task Parser for TASKS.md format
 *
 * Parses markdown task files with the following format:
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
// REGISTERING A PREFIX IS MANDATORY, not cosmetic. An id whose prefix is absent
// here is rewritten to `task-<id>` the next time the row is read, so a producer
// that re-derives its own id can never address its record again — and because
// those reads and writes are deliberately best-effort, they miss SILENTLY. That
// is how a preflight card (`preflight-`) sat at "Waiting for a free task slot"
// through an entire pr-reviewer run, then got reaped as interrupted.
const INTERNAL_PREFIXES = ['sys-', 'app-improve-', 'cd-', 'preflight-'];
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
 * These exist because `generateTasksMarkdown` can only REPRESENT these values:
 * a status outside the set lands in no section and a priority outside it fails
 * `matchTaskLine`'s regex on the next read. TASKS.md is the only store for a
 * queued task, so an unrepresentable value used to delete the task and its
 * `metadata.prompt` outright (#7239). Validate against these at every boundary
 * that can set a status or priority — the HTTP schemas (cosValidation.js) and
 * the peer wire schema (peerSyncValidation.js) both read them from here.
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
 * Coerce rather than throw. A peer or an install that already holds a task with
 * an out-of-vocabulary value must be repaired on READ, not made to crash every
 * subsequent task-file write — and a row that cannot be written is a row that is
 * silently deleted, which is the failure this guard exists to stop.
 *
 * Never mutates its argument; a representable task is returned as-is, so the
 * common path allocates nothing. Exported because the two places that CONSTRUCT
 * a task (`cosTaskIntake.buildQueuedTask`, `cosTaskStore.updateTask`) run it on
 * the object they are about to persist, so the task they return and emit on
 * `tasks:changed` says exactly what the file says. Applying it here as well keeps
 * it a backstop for rows an older install or a peer already wrote.
 */
export function toRepresentableTask(task) {
  const statusOk = TASK_STATUS_VALUES.includes(task?.status);
  const priorityOk = TASK_PRIORITY_VALUES.includes(task?.priority);
  if (statusOk && priorityOk) return task;

  const repairs = [];
  if (!statusOk) repairs.push(`status \`${String(task?.status)}\` -> ${REPAIRED_STATUS}`);
  if (!priorityOk) repairs.push(`priority \`${String(task?.priority)}\` -> ${REPAIRED_PRIORITY}`);
  console.warn(`⚠️ Task ${task?.id} is not representable in TASKS.md; repairing ${repairs.join(', ')}`);

  return {
    ...task,
    status: statusOk ? task.status : REPAIRED_STATUS,
    priority: priorityOk ? task.priority : REPAIRED_PRIORITY,
    priorityValue: priorityOk ? task.priorityValue : PRIORITY_VALUES[REPAIRED_PRIORITY],
    // A status repair ALWAYS stamps `unknown-status`, never defers to a category
    // the task already carried: that prior value is arbitrary (it describes some
    // earlier block, not this one) and a reapable one would let the 14-day
    // auto-expiry flip the rescued task to `completed` — the exact loss the
    // exemption in taskBlockCategories.js exists to prevent. The old value is kept
    // beside it rather than discarded.
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
 * The four patterns are tried in order, and the first two are the format as
 * written — a well-formed file never reaches the others, so their behavior is
 * unchanged. The last two are the RECOVERY path (#7239) for a row an older
 * install already wrote, or a hand edit: they accept any priority field and any
 * checkbox character, so the row and its indented metadata (which includes
 * `metadata.prompt`, the whole agent-facing payload) survive to be repaired
 * instead of being dropped along with everything indented under it.
 *
 * Recovery accepts ANY non-pipe priority field, because the boundary that wrote
 * these rows accepted any string — `VERY HIGH`, `123` and `URGENT!` were all
 * reachable through the route before this issue, and a narrower pattern would
 * leave exactly those rows to be deleted by the next write. The cost of that
 * width is that a `- [ ] #id | text | text` SENTENCE inside a legacy multi-line
 * description also matches, so no recovered row is ever auto-approved (#7300) —
 * see the approval flags in `matchTaskLine`.
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
    // Lower-cased because the patterns are case-insensitive: a hand-written [X]
    // means completed, not an unknown marker. A marker that really is unknown
    // stays as its raw token so toRepresentableTask parks the row as blocked
    // rather than defaulting it to pending, which would make a hand-edited row
    // auto-approved and runnable.
    const statusKey = `[${statusChar.toLowerCase()}]`;
    const approvalFlag = withFlag ? rest[0].toUpperCase() : null;
    const description = withFlag ? rest[1] : rest[0];

    const taskId = hasKnownPrefix(id) ? id : `task-${id}`;

    return {
      id: taskId,
      status: STATUS_MAP[statusKey] ?? statusKey,
      priority: priority.trim().toUpperCase(),
      priorityValue: PRIORITY_VALUES[priority.trim().toUpperCase()] || 2,
      // NO recovered row is auto-approved (#7300). The recovery patterns accept any
      // non-pipe priority field, which is right for a row the old free-string
      // boundary really wrote — but it also matches a `- [ ] #id | text | text`
      // SENTENCE sitting at column 0 inside a legacy multi-line description body,
      // and a match there mints a task nobody wrote. Handing that to the dequeue is
      // an agent spawn from prose, so a recovered row is preserved for a human and
      // withheld from `getAutoApprovedTasks` regardless of its id. This is the same
      // hold the unknown-checkbox path takes, from the other side of the row.
      //
      // A recovered row of EITHER kind lands in the approval queue, because its
      // split is ambiguous in a second way — the priority field could itself have
      // held a pipe ('UR|GENT', 'UR|AUTO' were both reachable), so which segment was
      // the approval flag is a guess, and that flag gates an agent spawn.
      //
      // `approvalRequired` — not `autoApproved: false` alone — is what carries the
      // hold, because it is the one signal BOTH files can write (`APPROVAL`). The
      // hold used to be inferred on the user side and evaporate on the next write:
      // the row healed into a strict row with no flag, and the read after that
      // parsed it as auto-approved and spawned an agent from what #7300 established
      // was prose. `autoApproved: false` cannot stand in for it there — every user
      // task `buildQueuedTask` mints carries that value, so writing a flag for it
      // would hold the entire user queue. A strict match on either kind is
      // untouched.
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
  // Self-heal task files a pre-fix install already wrote, where a nullish value
  // was persisted as the bare word `null` and read back as a TRUTHY string (see
  // generateTasksMarkdown for what that broke). A genuine string `"null"` now
  // round-trips through the JSON sentinel, so an unsentineled bare
  // `null`/`undefined` is unambiguously the nullish value.
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  // Legacy fallback for backwards compatibility with pre-sentinel data only.
  // New values with special characters always use the sentinel prefix (see escapeNewlines),
  // so this branch only runs on historical data that was escaped with the old method.
  // Values that were never intended to be newline-escaped won't have \\n sequences.
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

  // Pre-scan every task line's normalized id so suffix assignment below can
  // avoid colliding with any *stable, user-authored* id present in the file —
  // not just ids we've parsed so far. Without this a duplicate could grab
  // `task-001-dup2` only for a real later `task-001-dup2` to be bumped to
  // `task-001-dup2-dup2`, needlessly mutating an id the user chose. We rename
  // the duplicate, never the unique original.
  const rawIds = new Set();
  for (const line of lines) {
    if (line.startsWith('- [')) {
      const parsed = matchTaskLine(line);
      if (parsed) rawIds.add(parsed.id);
    }
  }

  // Push a fully-parsed task, guaranteeing its id is unique across the file.
  // Duplicate ids corrupt downstream consumers that key on id — most notably
  // reorderTasks' `new Map(tasks.map(t => [t.id, t]))`, which silently collapses
  // collisions so only the last duplicate survives the reorder write-back. We
  // warn and suffix the colliding id (`-dup2`, `-dup3`, …) rather than throw:
  // throwing would make a single hand-edited or corrupted TASKS.md crash every
  // read of the CoS task system, whereas suffixing keeps every task alive with a
  // distinct id. Called once per task, after its metadata lines are attached.
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
    // Repair HERE, not at match time: the row's indented metadata lines are
    // attached between the two, and one of them can be a `blockedCategory` left
    // over from an earlier block. Repairing first would let that line overwrite
    // the `unknown-status` hold the repair just stamped, dropping the rescued
    // task back into the 14-day auto-expiry it is exempt from.
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
 * `description` does not merely look wrong — it re-parses as file structure. The
 * lines after the break are read as the task's own metadata (`  - app: x`
 * re-targets which app the agent runs against) or, for a `- [ ] #id | …` row, as
 * a whole extra auto-approved task the spawner will run, while the description
 * itself is silently truncated to its first line (#7240).
 *
 * Callers normalize first (`cosTaskStore.addTask` / `writeTaskUpdate` re-home the
 * body into the newline-safe `metadata.prompt` / `metadata.context`); this only
 * stops a future writer from reintroducing the corruption, and says so loudly
 * because reaching it means the body was NOT preserved anywhere.
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
 * The internal file uses the whole vocabulary: every task that carries an
 * `autoApproved` at all states it, and a held one says APPROVAL.
 *
 * The user file carries ONLY the hold. `APPROVAL` when the row is withheld from
 * the unattended spawn (#7300, #7367), nothing otherwise — so an ordinary user
 * row keeps the flagless shape it has always had, and the hold stops being
 * inferred from a recovery match that the very next write erases.
 *
 * Which is why the user side keys on `approvalRequired` and NOT on the
 * internal side's wider `heldBack`: `buildQueuedTask` mints every user task
 * with `autoApproved: false` (only an internal task is ever auto-approved in
 * memory), so writing a flag for that value would hold the entire user queue on
 * its first rewrite.
 */
function approvalFlagSegment(task, includeApprovalFlags) {
  if (!includeApprovalFlags) return task.approvalRequired === true ? ' | APPROVAL' : '';
  // `autoApproved === false` writes APPROVAL, not AUTO (#7300). A task that says
  // it is not auto-approved must not be healed into a row the next read dequeues:
  // APPROVAL is the only flag this format has that survives the round trip as a
  // hold. An `undefined` autoApproved is NOT that claim — it stays on the old
  // path so a task that never carried the field keeps its flagless row.
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
  // Repair BEFORE grouping: groupTasksByStatus buckets only the five known
  // statuses, so an unrepresentable task would fall out of every bucket and be
  // written nowhere. Every task handed in gets a row (#7239).
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

      // Add metadata (escape newlines in values for single-line storage).
      // Pass the raw value — escapeNewlines JSON-encodes arrays/objects itself;
      // pre-stringifying here would flatten them to "a,b" or "[object Object]"
      // before it ever sees the array/object shape.
      //
      // Nullish values are DROPPED rather than written. `String(null)` used to
      // put the bare word `null` in the file, which re-parsed as the TRUTHY
      // string `'null'` — so a review-loop follow-up carrying `app: null` came
      // back as an app id of `'null'`, got blocked with `app-unresolved` before
      // it started, and the PR it existed to merge was orphaned. Producers
      // legitimately build metadata with `?? null` placeholders
      // (spawnReviewLoopFollowUp's `app`, `reviewLoopPRNumber`, …), so this is
      // the one place that can stop that habit from corrupting task state. An
      // absent key already means "not set" to every reader.
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
