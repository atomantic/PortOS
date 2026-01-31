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

const STATUS_MAP = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[!]': 'blocked'
};

const PRIORITY_VALUES = {
  'CRITICAL': 4,
  'HIGH': 3,
  'MEDIUM': 2,
  'LOW': 1
};

/**
 * Parse a single task line
 * Format: - [ ] #task-001 | HIGH | Description
 * Or with approval flag: - [ ] #sys-001 | HIGH | AUTO | Description
 */
function parseTaskLine(line) {
  // First try: - [status] #id | PRIORITY | APPROVAL_FLAG | description
  let match = line.match(/^-\s*\[([ x~!])\]\s*#([\w-]+)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(AUTO|APPROVAL)\s*\|\s*(.+)$/i);

  if (match) {
    const [, statusChar, id, priority, approvalFlag, description] = match;
    const statusKey = `[${statusChar}]`;

    return {
      id: id.startsWith('task-') || id.startsWith('sys-') ? id : `task-${id}`,
      status: STATUS_MAP[statusKey] || 'pending',
      priority: priority.toUpperCase(),
      priorityValue: PRIORITY_VALUES[priority.toUpperCase()] || 2,
      approvalRequired: approvalFlag.toUpperCase() === 'APPROVAL',
      autoApproved: approvalFlag.toUpperCase() === 'AUTO',
      description: description.trim(),
      metadata: {}
    };
  }

  // Fallback: - [status] #id | PRIORITY | description (no approval flag)
  match = line.match(/^-\s*\[([ x~!])\]\s*#([\w-]+)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(.+)$/i);

  if (!match) return null;

  const [, statusChar, id, priority, description] = match;
  const statusKey = `[${statusChar}]`;

  return {
    id: id.startsWith('task-') || id.startsWith('sys-') ? id : `task-${id}`,
    status: STATUS_MAP[statusKey] || 'pending',
    priority: priority.toUpperCase(),
    priorityValue: PRIORITY_VALUES[priority.toUpperCase()] || 2,
    approvalRequired: false,
    autoApproved: true,
    description: description.trim(),
    metadata: {}
  };
}

/**
 * Unescape newlines in metadata values.
 *
 * For values stored as JSON string literals (produced by escapeNewlines),
 * this uses JSON.parse to correctly restore backslashes, newlines, etc.
 * For legacy or simple values, falls back to simple replacement for backwards compatibility.
 */
function unescapeNewlines(value) {
  if (typeof value !== 'string') return value;
  // Check if this looks like a JSON-encoded string (starts and ends with quotes)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through to legacy behavior if parsing fails
    }
  }
  // Legacy fallback for backwards compatibility with existing data
  return value.replace(/\\n/g, '\n');
}

/**
 * Escape newlines in metadata values.
 *
 * For values containing special characters (newlines, backslashes), uses JSON
 * string escaping for reversibility. Simple values are stored as-is.
 */
function escapeNewlines(value) {
  if (typeof value !== 'string') return String(value);
  // Only use JSON encoding if the value contains characters that need escaping
  if (value.includes('\n') || value.includes('\\')) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Parse metadata line (indented under task)
 * Format:   - Key: Value
 */
function parseMetadataLine(line) {
  const match = line.match(/^\s+-\s*(\w+):\s*(.+)$/);
  if (!match) return null;

  return {
    key: match[1].toLowerCase(),
    value: unescapeNewlines(match[2].trim())
  };
}

/**
 * Parse TASKS.md content into structured data
 */
export function parseTasksMarkdown(content) {
  const lines = content.split('\n');
  const tasks = [];
  let currentTask = null;
  let currentSection = null;

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
      if (currentTask) {
        tasks.push(currentTask);
      }
      currentTask = parseTaskLine(line);
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
  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

/**
 * Group tasks by status
 */
export function groupTasksByStatus(tasks) {
  return {
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
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
 * Generate TASKS.md content from tasks array
 * @param {boolean} includeApprovalFlags - Whether to include AUTO/APPROVAL flags (for internal CoS tasks)
 */
export function generateTasksMarkdown(tasks, includeApprovalFlags = false) {
  const grouped = groupTasksByStatus(tasks);
  const lines = ['# Tasks', ''];

  const statusToCheckbox = {
    'pending': '[ ]',
    'in_progress': '[~]',
    'blocked': '[!]',
    'completed': '[x]'
  };

  const sections = [
    { key: 'pending', title: 'Pending' },
    { key: 'in_progress', title: 'In Progress' },
    { key: 'blocked', title: 'Blocked' },
    { key: 'completed', title: 'Completed' }
  ];

  for (const section of sections) {
    const sectionTasks = grouped[section.key];
    if (sectionTasks.length === 0) continue;

    lines.push(`## ${section.title}`);

    for (const task of sortByPriority(sectionTasks)) {
      const checkbox = statusToCheckbox[task.status];
      const approvalFlag = includeApprovalFlags && (task.approvalRequired || task.autoApproved !== undefined)
        ? ` | ${task.approvalRequired ? 'APPROVAL' : 'AUTO'}`
        : '';
      lines.push(`- ${checkbox} #${task.id} | ${task.priority}${approvalFlag} | ${task.description}`);

      // Add metadata (escape newlines in values for single-line storage)
      for (const [key, value] of Object.entries(task.metadata)) {
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        const escapedValue = escapeNewlines(String(value));
        lines.push(`  - ${capitalizedKey}: ${escapedValue}`);
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
    id: id.startsWith('task-') ? id : `task-${id}`,
    status: 'pending',
    priority: priority.toUpperCase(),
    priorityValue: PRIORITY_VALUES[priority.toUpperCase()] || 2,
    description,
    metadata,
    section: 'pending'
  };

  return [...tasks, newTask];
}

/**
 * Remove a task by ID
 */
export function removeTask(tasks, taskId) {
  return tasks.filter(t => t.id !== taskId);
}

/**
 * Check if a task is a critical auto-fix task that should be prioritized
 */
function isCriticalAutoFix(task) {
  const desc = (task.description || '').toLowerCase();
  const isSysTask = task.id?.startsWith('sys-');
  const isCritical = task.priority === 'CRITICAL';
  const isHighPriorityFix = task.priority === 'HIGH' && (
    desc.includes('fix critical error') ||
    desc.includes('[auto-fix]') ||
    desc.includes('fix error:') ||
    task.metadata?.autoFix === true
  );

  return isSysTask && (isCritical || isHighPriorityFix);
}

/**
 * Get next pending task
 * Priority: Critical auto-fix tasks first, then queue order
 */
export function getNextTask(tasks) {
  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length === 0) return null;

  // First, check for critical auto-fix tasks that need immediate attention
  const criticalAutoFix = pending.find(isCriticalAutoFix);
  if (criticalAutoFix) return criticalAutoFix;

  // Otherwise, return tasks in queue order (first pending task)
  return pending[0];
}

/**
 * Validate task format
 */
export function validateTask(task) {
  const errors = [];

  if (!task.id || typeof task.id !== 'string') {
    errors.push('Task must have a valid id');
  }

  if (!task.description || typeof task.description !== 'string') {
    errors.push('Task must have a description');
  }

  if (!['pending', 'in_progress', 'blocked', 'completed'].includes(task.status)) {
    errors.push('Invalid task status');
  }

  if (!Object.keys(PRIORITY_VALUES).includes(task.priority)) {
    errors.push('Invalid priority (must be CRITICAL, HIGH, MEDIUM, or LOW)');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
