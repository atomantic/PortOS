/**
 * Migration 270 — move on-disk CoS task PROMPT payloads out of `metadata.context`
 * and into `metadata.prompt` (issue #4153).
 *
 * Background:
 *   `metadata.context` carried two unrelated kinds of content: a one-line human
 *   note, and a multi-thousand-character agent prompt (the generator's Phase 1–7
 *   body, a `/do:*` claim prompt, a repo-study brief). The prompt landed there
 *   because `generateTasksMarkdown` flattens `description` onto one line, so a
 *   multi-line description would corrupt the queue file — `metadata.context` was
 *   the newline-escaped escape hatch that survived serialization.
 *
 *   The two are now separate fields (`server/lib/cosTaskPrompt.js`), and
 *   `cosTaskStore.addTask` routes new tasks at write time. This migration does
 *   the same for the tasks already queued on this install.
 *
 * What it writes:
 *   `data/TASKS.md` and `data/COS-TASKS.md` — renames the `- context: …`
 *   metadata line to `- prompt: …` on every task whose context value is a PROMPT
 *   payload, and re-stamps `updatedAt` on each so the migrated copy wins the
 *   last-write federation merge against a peer that hasn't migrated yet
 *   (`pickContentBase` in `cosTaskMerge.js` breaks an equal-status tie on that
 *   stamp). `PORTOS_SCHEMA_VERSIONS.cosTasks` is bumped to 5 in the same change,
 *   so a not-yet-upgraded peer skips cos-task sync rather than receiving a
 *   `metadata.prompt` its prompt builder cannot read.
 *
 *   The classification is `isPromptPayload` from `server/lib/cosTaskPrompt.js` —
 *   the SAME predicate the store's write path uses, so a task can't be sorted
 *   one way at creation and the other way here. A single-line context is a note
 *   and is left exactly where it is.
 *
 *   A text-level rewrite rather than a parse/regenerate round-trip (the choice
 *   migration 234 made for these files): regenerating would reorder, re-escape
 *   and re-sort every task in the user's live queue.
 *
 * Safety:
 *   Under-migrating is harmless — every reader goes through `getTaskPrompt`,
 *   which falls back to `metadata.context`. So a task this skips (or an install
 *   that never runs it) keeps resolving correctly; the rewrite just makes the
 *   file on disk say what the code means.
 *
 * Idempotent: a task that already carries a `prompt:` line, or whose context is
 * a one-line note, is skipped — so a second run changes nothing and the files
 * are left untouched when there is nothing to do.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { readCosConfig } from './_lib.js';
import { isPromptPayload, TASK_PROMPT_KEY, TASK_CONTEXT_KEY } from '../../server/lib/cosTaskPrompt.js';

// The task header line, per `server/lib/taskParser.js`. Both spellings — with
// and without the AUTO/APPROVAL flag — since internal tasks carry it and the
// legacy shape does not.
const TASK_LINE = /^-\s*\[([ x~!?])\]\s*#([\w-]+)\s*\|\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(?:(?:AUTO|APPROVAL)\s*\|\s*)?(.+)$/i;
const METADATA_LINE = /^(\s+)-\s*(\w+):\s*(.*)$/;

// Sentinel prefix `taskParser.js#escapeNewlines` writes in front of a
// JSON-encoded metadata value. Every multi-line value written since that
// encoding landed carries it; older ones use bare `\n` escapes.
const JSON_SENTINEL = '__json__:';

const QUEUE_FILES = [
  { configKey: 'userTasksFile', file: 'data/TASKS.md' },
  { configKey: 'cosTasksFile', file: 'data/COS-TASKS.md' },
];

/**
 * Decode a persisted metadata value back to the string a reader would see.
 * Mirrors `unescapeNewlines` in `server/lib/taskParser.js` — the sentinel form
 * first, then the legacy bare-`\n` form. Returns null for anything that does not
 * decode to a string, so a JSON-encoded array/object can never be reclassified.
 */
function decodeMetadataValue(raw) {
  if (raw.startsWith(JSON_SENTINEL)) {
    let parsed;
    try { parsed = JSON.parse(raw.slice(JSON_SENTINEL.length)); } catch { return null; }
    return typeof parsed === 'string' ? parsed : null;
  }
  if (raw === 'null' || raw === 'undefined') return null;
  return raw.replace(/\\n/g, '\n');
}

/**
 * Rename the prompt-carrying `context:` metadata line to `prompt:` on every task
 * that has one, re-stamping `updatedAt` on the ones changed. Pure — exported for
 * the test.
 *
 * @param {string} markdown raw TASKS.md / COS-TASKS.md
 * @param {{ stamp: string }} options
 * @returns {{ markdown: string, split: string[] }} ids of the tasks rewritten
 */
export function splitPromptMetadata(markdown, { stamp }) {
  const lines = markdown.split('\n');
  const out = [];
  const split = [];
  // Id of the task whose block we are currently inside.
  let taskId = null;
  // Indices in `out` of the current task's context / prompt / updatedAt / last
  // metadata lines, so the rewrite happens once the whole block has been seen.
  let contextAt = -1;
  let hasPrompt = false;
  let stampAt = -1;
  let lastMetaAt = -1;
  let indent = '  ';

  // Rewrite the block we just finished walking. No-op unless it carried a
  // prompt payload under `context` and no `prompt` of its own.
  const finish = () => {
    if (taskId && contextAt >= 0 && !hasPrompt) {
      const meta = out[contextAt].match(METADATA_LINE);
      out[contextAt] = `${meta[1]}- ${TASK_PROMPT_KEY}: ${meta[3]}`;
      const stampLine = `${indent}- updatedAt: ${stamp}`;
      if (stampAt >= 0) out[stampAt] = stampLine;
      // No stamp yet — insert directly after the last metadata line rather than
      // at the end of the block, so it can't land after a description that
      // spilled onto its own lines (see the block-scan note below).
      else out.splice(lastMetaAt + 1, 0, stampLine);
      split.push(taskId);
    }
    taskId = null;
    contextAt = -1;
    hasPrompt = false;
    stampAt = -1;
    lastMetaAt = -1;
  };

  for (const line of lines) {
    const header = line.match(TASK_LINE);
    // A task's block runs to the NEXT task header — NOT to the first
    // non-metadata line, and NOT to a `#` heading. Two reasons, both load-bearing
    // for exactly the payloads this migration targets:
    //   - A description written with embedded newlines is interpolated into the
    //     file verbatim by `generateTasksMarkdown`, so a freshly-filed task can
    //     carry blank/prose lines between its header and its metadata (they are
    //     dropped on the next parse round-trip, but a migration may well run
    //     before that happens).
    //   - Those spilled lines are usually MARKDOWN HEADINGS (`## Phase 1` — the
    //     generator's Phase 1–7 body is the canonical case). Ending the block at
    //     a `#` line would walk right past the `context:` line below it.
    // `parseTasksMarkdown` does the same: a `##` section heading advances the
    // section but never clears `currentTask`, so metadata after one still
    // attaches to the preceding task. Mirror it, or this rewrite and the parser
    // would disagree about which task owns a line.
    if (header) {
      finish();
      out.push(line);
      taskId = header[2];
      continue;
    }
    const meta = taskId ? line.match(METADATA_LINE) : null;
    if (meta) {
      indent = meta[1];
      lastMetaAt = out.length;
      // Normalize the key exactly as `parseMetadataLine` does — legacy
      // Title-Case keys (`Context`, `Prompt`) are real on older installs and
      // read back as the camelCase key, so a case-sensitive compare here would
      // skip them, record the migration applied, and leave them unsplit forever.
      const key = meta[2].charAt(0).toLowerCase() + meta[2].slice(1);
      if (key === TASK_PROMPT_KEY) hasPrompt = true;
      else if (key === TASK_CONTEXT_KEY) {
        const decoded = decodeMetadataValue(meta[3].trim());
        if (isPromptPayload(decoded)) contextAt = out.length;
      } else if (key === 'updatedAt') stampAt = out.length;
    }
    out.push(line);
  }
  finish();

  return { markdown: out.join('\n'), split };
}

/**
 * Repo-relative path of a queue file, honouring an install that moved it in its
 * CoS config (`userTasksFile` / `cosTasksFile` — the same values `cosTaskStore`
 * reads). Migrating only the defaults would record this migration as applied
 * while the live queue stayed unsplit.
 */
async function queuePaths(rootDir) {
  const config = await readCosConfig({ rootDir, label: 'migration 270' });
  return QUEUE_FILES.map(({ configKey, file }) => (
    typeof config[configKey] === 'string' && config[configKey] ? config[configKey] : file
  ));
}

export default {
  async up({ rootDir, now = new Date().toISOString() }) {
    const split = [];
    let seenAFile = false;

    for (const relPath of await queuePaths(rootDir)) {
      const file = join(rootDir, relPath);
      const raw = await readFile(file, 'utf-8').catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (raw == null) continue;
      seenAFile = true;

      const result = splitPromptMetadata(raw, { stamp: now });
      if (!result.split.length) continue;
      await atomicWrite(file, result.markdown);
      split.push(...result.split);
    }

    if (!seenAFile) {
      console.log('🧩 migration 270: no task queue on this install — nothing to split');
      return { ok: true, reason: 'no-task-file' };
    }
    if (!split.length) {
      console.log('🧩 migration 270: no task carries a prompt payload under `context`');
      return { ok: true, reason: 'already-split', split: 0 };
    }
    console.log(`🧩 migration 270: moved ${split.length} task prompt payload(s) from metadata.context to metadata.prompt`);
    return { ok: true, split: split.length };
  },
};
