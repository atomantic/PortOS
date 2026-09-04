/**
 * Migration 262 — revive the merge follow-ups blocked by an app literally
 * named "null", so the pull requests they were spawned to land stop leaking.
 *
 * Background:
 *   `spawnReviewLoopFollowUp` builds its follow-up task with
 *   `app: originalTask?.metadata?.app || null`, which for a PortOS-local task is
 *   `null`. `generateTasksMarkdown` used to serialize that as the bare word
 *   `null` (`String(null)`), and `parseTasksMarkdown` read it straight back as
 *   the TRUTHY string `'null'` — an app id. `prepareAgentWorkspace` then blocked
 *   the task with `app-unresolved` before it ever started.
 *
 *   That follow-up IS the merge for every provider without slashdo commands
 *   (grok, OpenCode, codex, antigravity): PortOS owns push → PR → review → merge
 *   on their behalf, so blocking it orphans the PR, its branch, and its worktree
 *   with nothing left in the system that will ever land them.
 *
 *   The serialization is fixed at the source now (nullish metadata is dropped on
 *   write, and a bare `null` is read back as nullish so files an older install
 *   wrote self-heal). But repairing the VALUE does not repair the STATUS: the
 *   task stays in `## Blocked`, and `app-unresolved` is in BOTH
 *   `PAUSED_BLOCKED_CATEGORIES` and `USER_DECISION_BLOCKED_CATEGORIES`
 *   (`server/lib/taskBlockCategories.js`), so the failure reaper never expires it
 *   and the investigation auto-retry never revives it. Without this migration
 *   those tasks sit blocked forever on every install that hit the bug.
 *
 * What it writes:
 *   `data/COS-TASKS.md` (and `data/TASKS.md`, for an install whose follow-ups
 *   landed there) — moves a task back to `## Pending` when ALL of these hold:
 *     - it is `[!]` blocked,
 *     - it carries `reviewLoopPRUrl` (it exists to land a PR),
 *     - its `blockedCategory` is `app-unresolved`,
 *     - it carries a bare `- app: null` line — i.e. the block is provably this
 *       serialization artifact and not a real routing mistake.
 *   The `app`, `blockedReason`, `blockedCategory` and `blockedAt` lines are
 *   dropped and `updatedAt` is re-stamped, so the revived copy wins the
 *   last-write federation merge against a peer that hasn't migrated yet
 *   (`pickContentBase` in `cosTaskMerge.js` breaks an equal-status tie on that
 *   stamp).
 *
 *   Migration 234 deliberately left blocked tasks in place because the block
 *   there encoded a real routing mistake a human had to judge. The opposite is
 *   true here: the four conditions above identify a block that only ever came
 *   from the serialization bug, so reviving is the correct call and nothing else
 *   will ever do it.
 *
 *   A text-level rewrite rather than a parse/regenerate round-trip (234's
 *   choice, for the same reason): regenerating would reorder, re-escape and
 *   re-sort every task in the user's live queue. Moving a task between sections
 *   is the one thing that costs — handled by lifting the matched blocks out and
 *   re-inserting them under `## Pending`.
 *
 * Idempotent: a revived task no longer matches (it is `[ ]` and has no
 * `blockedCategory`), so a second run changes nothing.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { readCosConfig } from './_lib.js';

// The task header line, per `server/lib/taskParser.js`. Both spellings — with
// and without the AUTO/APPROVAL flag — since internal tasks carry it and the
// legacy shape does not.
const TASK_LINE = /^-\s*\[([ x~!?])\]\s*#([\w-]+)\s*\|\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(?:(?:AUTO|APPROVAL)\s*\|\s*)?(.+)$/i;
const METADATA_LINE = /^(\s+)-\s*(\w+):\s*(.*)$/;
const SECTION_LINE = /^##\s+(.+?)\s*$/;

// Metadata the revival drops: the bad routing key plus the whole block record.
// `blocker` is the legacy spelling still accepted by the parser.
const DROPPED_KEYS = new Set(['app', 'blocker', 'blockedReason', 'blockedCategory', 'blockedAt']);

const QUEUE_FILES = [
  { configKey: 'cosTasksFile', file: 'data/COS-TASKS.md' },
  { configKey: 'userTasksFile', file: 'data/TASKS.md' },
];

/**
 * Repo-relative paths of the queue files, honouring an install that moved them
 * in its CoS config (`cosTasksFile` / `userTasksFile` — the same values
 * `cosTaskStore` reads). Migrating only the defaults would record this
 * migration as applied while the live queue stayed stranded.
 */
async function queuePaths(rootDir) {
  const config = await readCosConfig({ rootDir, label: 'migration 262' });
  return QUEUE_FILES.map(({ configKey, file }) => (
    typeof config[configKey] === 'string' && config[configKey] ? config[configKey] : file
  ));
}

/**
 * Split a task file into an ordered list of blocks. A task's block runs to the
 * NEXT task header or section heading — not to the first non-metadata line: a
 * description written with embedded newlines is interpolated verbatim by
 * `generateTasksMarkdown`, so a freshly-filed task can carry blank/prose lines
 * between its header and its metadata.
 *
 * @returns {Array<{ kind: 'section'|'task'|'other', lines: string[], … }>}
 */
function splitBlocks(markdown) {
  const blocks = [];
  for (const line of markdown.split('\n')) {
    const section = line.match(SECTION_LINE);
    if (section) {
      blocks.push({ kind: 'section', title: section[1], lines: [line] });
      continue;
    }
    const header = line.match(TASK_LINE);
    if (header) {
      blocks.push({ kind: 'task', status: header[1], id: header[2], lines: [line] });
      continue;
    }
    if (blocks.length && blocks[blocks.length - 1].kind === 'task') blocks[blocks.length - 1].lines.push(line);
    else blocks.push({ kind: 'other', lines: [line] });
  }
  return blocks;
}

/** Read a task block's metadata into a flat `{ key: rawValue }` map. */
function readMetadata(block) {
  const meta = {};
  for (const line of block.lines.slice(1)) {
    const m = line.match(METADATA_LINE);
    if (m && !(m[2] in meta)) meta[m[2]] = m[3].trim();
  }
  return meta;
}

/**
 * Is this block a merge follow-up stranded by the `app: null` serialization bug
 * — as opposed to one blocked for a reason a human still has to judge?
 */
function isNullAppStrandedFollowUp(block) {
  if (block.kind !== 'task' || block.status !== '!') return false;
  const meta = readMetadata(block);
  return meta.app === 'null'
    && meta.blockedCategory === 'app-unresolved'
    && !!meta.reviewLoopPRUrl;
}

/**
 * Rewrite one blocked task block as a pending one: flip the checkbox, drop the
 * bad routing key and the block record, and re-stamp `updatedAt`.
 */
function revive(block, stamp) {
  const indent = block.lines.slice(1).map(l => l.match(METADATA_LINE)).find(Boolean)?.[1] ?? '  ';
  const lines = [block.lines[0].replace(/^-\s*\[!\]/, '- [ ]')];
  let stamped = false;
  for (const line of block.lines.slice(1)) {
    const m = line.match(METADATA_LINE);
    if (m && DROPPED_KEYS.has(m[2])) continue;
    if (m && m[2] === 'updatedAt') { lines.push(`${indent}- updatedAt: ${stamp}`); stamped = true; continue; }
    lines.push(line);
  }
  // No stamp yet — append one after the last metadata line rather than at the
  // end of the block, which may hold trailing blank/prose lines.
  if (!stamped) {
    const lastMeta = lines.reduce((at, line, i) => (METADATA_LINE.test(line) ? i : at), 0);
    lines.splice(lastMeta + 1, 0, `${indent}- updatedAt: ${stamp}`);
  }
  return { ...block, status: ' ', lines };
}

/**
 * Move every `app: null`-stranded merge follow-up out of `## Blocked` and into
 * `## Pending`. Pure — exported for the test.
 *
 * @param {string} markdown raw COS-TASKS.md / TASKS.md
 * @param {string} stamp ISO timestamp for the `updatedAt` re-stamp
 * @returns {{ markdown: string, revived: string[] }} ids of the tasks revived
 */
export function reviveStrandedFollowUps(markdown, stamp) {
  const blocks = splitBlocks(markdown);
  const stranded = blocks.filter(isNullAppStrandedFollowUp);
  if (!stranded.length) return { markdown, revived: [] };

  const strandedSet = new Set(stranded);
  const revived = stranded.map(b => revive(b, stamp));
  const kept = blocks.filter(b => !strandedSet.has(b));

  // Re-insert under `## Pending` — at the END of that section so the queue's
  // existing priority order is untouched (`generateTasksMarkdown` re-sorts on
  // the next save anyway). A file with no Pending section gets one, placed
  // before the first section that exists so it reads in the usual order.
  const out = [];
  let inserted = false;
  for (let i = 0; i < kept.length; i++) {
    const block = kept[i];
    // End of the Pending section = the next section heading after it.
    if (!inserted && block.kind === 'section' && /^pending$/i.test(block.title)) {
      out.push(block);
      let j = i + 1;
      for (; j < kept.length && kept[j].kind !== 'section'; j++) out.push(kept[j]);
      // Trailing blank line before the next heading belongs after our blocks.
      const trailing = [];
      while (out.length && out[out.length - 1].kind === 'other' && out[out.length - 1].lines.every(l => !l.trim())) {
        trailing.unshift(out.pop());
      }
      out.push(...revived, ...trailing);
      i = j - 1;
      inserted = true;
      continue;
    }
    if (!inserted && block.kind === 'section') {
      out.push({ kind: 'section', title: 'Pending', lines: ['## Pending'] }, ...revived, { kind: 'other', lines: [''] });
      inserted = true;
    }
    out.push(block);
  }
  if (!inserted) out.push({ kind: 'section', title: 'Pending', lines: ['## Pending'] }, ...revived);

  return {
    markdown: out.flatMap(b => b.lines).join('\n'),
    revived: revived.map(b => b.id),
  };
}

export default {
  async up({ rootDir, now = new Date().toISOString() }) {
    const revived = [];
    let seenAFile = false;

    for (const relative of await queuePaths(rootDir)) {
      const file = join(rootDir, relative);
      const raw = await readFile(file, 'utf-8').catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (raw == null) continue;
      seenAFile = true;

      const result = reviveStrandedFollowUps(raw, now);
      if (!result.revived.length) continue;
      await atomicWrite(file, result.markdown);
      revived.push(...result.revived);
    }

    if (!seenAFile) {
      console.log('🔥 migration 262: no task queue on this install — nothing to revive');
      return { ok: true, reason: 'no-task-file' };
    }
    if (!revived.length) {
      console.log('🔥 migration 262: no merge follow-ups stranded by a null app');
      return { ok: true, reason: 'none-stranded', revived: 0 };
    }
    console.log(`🔥 migration 262: revived ${revived.length} merge follow-up(s) whose PR was left orphaned`);
    return { ok: true, revived: revived.length };
  },
};
