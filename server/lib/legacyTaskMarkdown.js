/**
 * The retired Markdown task-file format (`TASKS.md` / `COS-TASKS.md`): parse and generate it, for db-migration 018 and tests only.
 *
 * The CoS task queues are rows in `cos_tasks`; nothing at runtime reads or writes
 * this format (#16407). It stays importable because db-migration 018 still has to
 * read files an install wrote before the move to Postgres, the file-era migration
 * tests in `scripts/migrations/` build their fixtures with it, and
 * `cosTaskRows.storedForm` is pinned against `parseTasksMarkdown(generateTasksMarkdown(…))`
 * by an equivalence test. Do not import it from runtime code.
 *
 * Format:
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

import { groupTasksByStatus, hasKnownPrefix, PRIORITY_VALUES, toRepresentableTask } from './taskParser.js';

/** Checkbox marker of each status. Every `TASK_STATUS_VALUES` entry has one (pinned by the test). */
export const STATUS_CHECKBOXES = Object.freeze({
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  blocked: '[!]',
  // A sub-agent disputing a reviewer rejection parks the task here (#2441).
  challenged: '[?]',
});

const STATUS_BY_CHECKBOX = Object.fromEntries(Object.entries(STATUS_CHECKBOXES).map(([status, box]) => [box, status]));

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
      status: STATUS_BY_CHECKBOX[statusKey] ?? statusKey,
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
  // id-keyed consumers. Suffix (`-dup2`, …) and warn rather than throw, so one
  // corrupted file cannot crash every read. Called once per task, after its
  // metadata lines are attached.
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
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, '_');
      continue;
    }

    if (line.startsWith('# ') || line.trim() === '') {
      continue;
    }

    if (line.startsWith('- [')) {
      pushTask(currentTask);
      currentTask = matchTaskLine(line);
      if (currentTask) {
        currentTask.section = currentSection;
      }
      continue;
    }

    if (currentTask && line.match(/^\s+-\s*\w+:/)) {
      const meta = parseMetadataLine(line);
      if (meta) {
        currentTask.metadata[meta.key] = meta.value;
      }
    }
  }

  pushTask(currentTask);

  return tasks;
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

const SECTIONS = [
  { key: 'pending', title: 'Pending' },
  { key: 'in_progress', title: 'In Progress' },
  { key: 'challenged', title: 'Challenged' },
  { key: 'blocked', title: 'Blocked' },
  { key: 'completed', title: 'Completed' }
];

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

  for (const section of SECTIONS) {
    const sectionTasks = grouped[section.key];
    if (sectionTasks.length === 0) continue;

    lines.push(`## ${section.title}`);

    for (const task of sortByPriority(sectionTasks)) {
      const checkbox = STATUS_CHECKBOXES[task.status];
      const approvalFlag = approvalFlagSegment(task, includeApprovalFlags);
      lines.push(`- ${checkbox} #${task.id} | ${task.priority}${approvalFlag} | ${flattenDescription(task)}`);

      // Pass the raw value: escapeNewlines JSON-encodes arrays/objects itself, and
      // pre-stringifying would flatten them.
      // Nullish values are DROPPED: a bare `null` would re-parse as the TRUTHY
      // string `'null'`, and producers build metadata with `?? null` placeholders.
      for (const [key, value] of Object.entries(task.metadata)) {
        if (value === null || value === undefined) continue;
        lines.push(`  - ${key}: ${escapeNewlines(value)}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
