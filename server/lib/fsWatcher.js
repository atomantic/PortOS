/**
 * Owned file/directory watcher over node:fs.watch, emitting add/change/unlink/all/error events with optional write-stability debouncing.
 *
 * Replaces chokidar (#17251). Directory targets use a recursive native watch;
 * file targets (which may not exist yet, or be replaced by atomic rename as git
 * does for HEAD and packed-refs) watch the parent directory and filter by
 * basename, so the watch survives an inode swap. Every native handle always
 * carries an 'error' listener: on Windows, deleting a watched directory emits
 * EPERM and an unlistened handle error is an uncaught exception that exits the
 * server. Omitted by design: globs, polling, symlink following, depth limits,
 * directory events and dynamic add/unwatch.
 */

import { EventEmitter } from 'node:events';
import { watch as fsWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const DEFAULT_WRITE_FINISH = { stabilityThreshold: 300, pollInterval: 100 };

const statOrNull = async (path) => {
  try {
    return await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
};

// Files under a directory, best-effort: a missing or unreadable dir seeds nothing.
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isFile()).map(e => join(e.parentPath ?? e.path, e.name));
}

/**
 * @param {string|string[]} targets files and/or directories to watch
 * @param {{persistent?: boolean, ignoreInitial?: boolean, ignored?: RegExp|null,
 *   awaitWriteFinish?: boolean|{stabilityThreshold?: number, pollInterval?: number}}} [options]
 * @returns {EventEmitter & {close: () => Promise<void>}}
 */
export function watchPaths(targets, options = {}) {
  const { persistent = true, ignoreInitial = true, ignored = null, awaitWriteFinish = false } = options;
  const { stabilityThreshold, pollInterval } = awaitWriteFinish
    ? { ...DEFAULT_WRITE_FINISH, ...(awaitWriteFinish === true ? {} : awaitWriteFinish) }
    : {};
  const emitter = new EventEmitter();
  const handles = [];
  // path → size/mtime signature last reported. Native watchers re-fire for files
  // written just before the watch started (macOS) and double-fire per write; an
  // unchanged signature is not a change.
  const known = new Map();
  const pending = new Map(); // path → { timer }
  let closed = false;

  const isIgnored = (path) => {
    if (!ignored) return false;
    ignored.lastIndex = 0;
    return ignored.test(path);
  };

  // A handler throwing, or an 'error' with no listener, must not escape a
  // native callback — that is an uncaught exception.
  const fail = (err) => {
    if (closed) return;
    if (emitter.listenerCount('error') > 0) emitter.emit('error', err);
    else console.log(`⚠️ fsWatcher: unhandled watcher error ${err?.message || err}`);
  };

  const emitEvent = (event, path) => {
    if (closed) return;
    emitter.emit(event, path);
    emitter.emit('all', event, path);
  };

  const signature = (info) => `${info.size}:${info.mtimeMs}`;

  const settle = (path, info) => {
    if (closed) return;
    const sig = signature(info);
    const previous = known.get(path);
    if (previous === sig) return;
    known.set(path, sig);
    emitEvent(previous === undefined ? 'add' : 'change', path);
  };

  const dropPending = (path) => {
    const entry = pending.get(path);
    if (entry) clearTimeout(entry.timer);
    pending.delete(path);
  };

  // Poll until size and mtime hold for the stability window, so a file a sync
  // client is still writing is not reported half-written.
  const pollUntilStable = (path, previous, stableSince) => {
    const timer = setTimeout(() => {
      stat(path).then((current) => {
        if (closed || pending.get(path)?.timer !== timer) return;
        if (!current.isFile()) { pending.delete(path); return; }
        const unchanged = current.size === previous.size && current.mtimeMs === previous.mtimeMs;
        const since = unchanged ? stableSince : Date.now();
        if (unchanged && Date.now() - since >= stabilityThreshold) {
          pending.delete(path);
          settle(path, current);
          return;
        }
        pollUntilStable(path, current, since);
      }).catch((err) => {
        if (closed || pending.get(path)?.timer !== timer) return;
        pending.delete(path);
        // Vanished mid-write: the unlink path owns reporting it.
        if (err?.code === 'ENOENT') { if (known.delete(path)) emitEvent('unlink', path); return; }
        fail(err);
      });
    }, pollInterval);
    if (!persistent) timer.unref?.();
    pending.set(path, { timer });
  };

  const classify = async (path) => {
    const info = await statOrNull(path);
    if (closed) return;
    if (!info) {
      dropPending(path);
      if (known.delete(path)) emitEvent('unlink', path);
      return;
    }
    if (!info.isFile()) return;
    if (!awaitWriteFinish) { settle(path, info); return; }
    // A pending poll already tracks this path and sees any further change.
    if (pending.has(path)) return;
    pollUntilStable(path, info, Date.now());
  };

  let ready = Promise.resolve();
  const onFsEvent = (path) => {
    if (closed || isIgnored(path)) return;
    ready.then(() => classify(path)).catch(fail);
  };

  const attach = (dir, recursive, accept) => {
    if (closed) return;
    const handle = fsWatch(dir, { persistent, recursive }, (_event, filename) => {
      if (filename == null) return;
      const path = join(dir, filename.toString());
      if (accept(path)) onFsEvent(path);
    });
    handle.on('error', fail);
    handles.push(handle);
  };

  const setup = async () => {
    const dirs = new Set();
    const fileTargets = new Map(); // parent dir → Set of watched paths
    for (const raw of [targets].flat()) {
      const target = resolve(raw);
      const info = await statOrNull(target);
      if (info?.isDirectory()) { dirs.add(target); continue; }
      const parent = dirname(target);
      if (!fileTargets.has(parent)) fileTargets.set(parent, new Set());
      fileTargets.get(parent).add(basename(target));
    }
    if (closed) return;

    const initial = []; // candidate paths present at start
    for (const dir of dirs) {
      attach(dir, true, () => true);
      for (const path of await listFiles(dir)) initial.push(path);
    }
    for (const [parent, names] of fileTargets) {
      // Parent absent: nothing to watch yet. Not retried; callers pass paths
      // inside directories that exist (git dir, bucket layout).
      if (!await statOrNull(parent)) continue;
      attach(parent, false, path => names.has(basename(path)));
      for (const name of names) {
        const full = join(parent, name);
        initial.push(full);
      }
    }
    for (const path of initial) {
      if (isIgnored(path)) continue;
      const info = await statOrNull(path);
      if (!info?.isFile()) continue;
      known.set(path, signature(info));
      if (!ignoreInitial) emitEvent('add', path);
    }
  };

  ready = setup().catch(fail);

  emitter.close = async () => {
    closed = true;
    await ready;
    for (const path of [...pending.keys()]) dropPending(path);
    for (const handle of handles.splice(0)) handle.close();
    emitter.removeAllListeners();
  };
  return emitter;
}
