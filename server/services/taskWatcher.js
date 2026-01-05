/**
 * Task Watcher Service
 *
 * Watches TASKS.md and COS-TASKS.md for changes and emits events
 * when tasks are added, modified, or completed.
 */

import { watch } from 'chokidar';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, getUserTasks, getCosTasks, getConfig } from './cos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../../');

let watcher = null;
let isWatching = false;
let lastUserTasks = null;
let lastCosTasks = null;

/**
 * Start watching task files
 */
export async function startWatching() {
  if (isWatching) {
    return { success: false, error: 'Already watching' };
  }

  const config = await getConfig();
  const userTasksPath = join(ROOT_DIR, config.userTasksFile);
  const cosTasksPath = join(ROOT_DIR, config.cosTasksFile);

  // Load initial state
  lastUserTasks = await getUserTasks();
  lastCosTasks = await getCosTasks();

  watcher = watch([userTasksPath, cosTasksPath], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on('change', async (path) => {
    if (path.endsWith(config.userTasksFile)) {
      await handleUserTasksChange();
    } else if (path.endsWith(config.cosTasksFile)) {
      await handleCosTasksChange();
    }
  });

  watcher.on('add', async (path) => {
    if (path.endsWith(config.userTasksFile)) {
      lastUserTasks = await getUserTasks();
      cosEvents.emit('tasks:user:created', lastUserTasks);
    } else if (path.endsWith(config.cosTasksFile)) {
      lastCosTasks = await getCosTasks();
      cosEvents.emit('tasks:cos:created', lastCosTasks);
    }
  });

  watcher.on('unlink', async (path) => {
    if (path.endsWith(config.userTasksFile)) {
      cosEvents.emit('tasks:user:deleted', { file: path });
      lastUserTasks = null;
    } else if (path.endsWith(config.cosTasksFile)) {
      cosEvents.emit('tasks:cos:deleted', { file: path });
      lastCosTasks = null;
    }
  });

  watcher.on('error', (error) => {
    cosEvents.emit('watcher:error', { error: error.message });
  });

  isWatching = true;
  cosEvents.emit('watcher:started', {
    files: [userTasksPath, cosTasksPath]
  });

  return { success: true };
}

/**
 * Stop watching task files
 */
export async function stopWatching() {
  if (!isWatching || !watcher) {
    return { success: false, error: 'Not watching' };
  }

  await watcher.close();
  watcher = null;
  isWatching = false;

  cosEvents.emit('watcher:stopped');
  return { success: true };
}

/**
 * Handle changes to user tasks file
 */
async function handleUserTasksChange() {
  const current = await getUserTasks();

  if (!lastUserTasks) {
    lastUserTasks = current;
    cosEvents.emit('tasks:user:changed', current);
    return;
  }

  const changes = diffTasks(lastUserTasks.tasks, current.tasks);

  if (changes.added.length > 0) {
    cosEvents.emit('tasks:user:added', { tasks: changes.added });
  }

  if (changes.completed.length > 0) {
    cosEvents.emit('tasks:user:completed', { tasks: changes.completed });
  }

  if (changes.modified.length > 0) {
    cosEvents.emit('tasks:user:modified', { tasks: changes.modified });
  }

  if (changes.removed.length > 0) {
    cosEvents.emit('tasks:user:removed', { tasks: changes.removed });
  }

  lastUserTasks = current;
  cosEvents.emit('tasks:user:changed', current);
}

/**
 * Handle changes to CoS internal tasks file
 */
async function handleCosTasksChange() {
  const current = await getCosTasks();

  if (!lastCosTasks) {
    lastCosTasks = current;
    cosEvents.emit('tasks:cos:changed', current);
    return;
  }

  const changes = diffTasks(lastCosTasks.tasks, current.tasks);

  if (changes.added.length > 0) {
    cosEvents.emit('tasks:cos:added', { tasks: changes.added });
  }

  if (changes.completed.length > 0) {
    cosEvents.emit('tasks:cos:completed', { tasks: changes.completed });
  }

  if (changes.modified.length > 0) {
    cosEvents.emit('tasks:cos:modified', { tasks: changes.modified });
  }

  if (changes.removed.length > 0) {
    cosEvents.emit('tasks:cos:removed', { tasks: changes.removed });
  }

  lastCosTasks = current;
  cosEvents.emit('tasks:cos:changed', current);
}

/**
 * Diff two task arrays to find changes
 */
function diffTasks(oldTasks, newTasks) {
  const oldMap = new Map(oldTasks.map(t => [t.id, t]));
  const newMap = new Map(newTasks.map(t => [t.id, t]));

  const added = [];
  const completed = [];
  const modified = [];
  const removed = [];

  // Find added and modified tasks
  for (const [id, task] of newMap) {
    const oldTask = oldMap.get(id);

    if (!oldTask) {
      added.push(task);
    } else if (oldTask.status !== 'completed' && task.status === 'completed') {
      completed.push(task);
    } else if (JSON.stringify(oldTask) !== JSON.stringify(task)) {
      modified.push({ old: oldTask, new: task });
    }
  }

  // Find removed tasks
  for (const [id, task] of oldMap) {
    if (!newMap.has(id)) {
      removed.push(task);
    }
  }

  return { added, completed, modified, removed };
}

/**
 * Get watcher status
 */
export function getWatcherStatus() {
  return {
    watching: isWatching,
    lastUserTasks: lastUserTasks?.tasks?.length ?? 0,
    lastCosTasks: lastCosTasks?.tasks?.length ?? 0
  };
}

/**
 * Force refresh of cached tasks
 */
export async function refreshTasks() {
  lastUserTasks = await getUserTasks();
  lastCosTasks = await getCosTasks();

  cosEvents.emit('tasks:refreshed', {
    user: lastUserTasks,
    cos: lastCosTasks
  });

  return { user: lastUserTasks, cos: lastCosTasks };
}
