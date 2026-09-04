/**
 * Migration 234 — un-strand the CoS tasks routed at an app that doesn't exist.
 *
 * Background:
 *   `metadata.app` on a CoS task is WORKSPACE ROUTING: it must name a record in
 *   `data/apps.json`. Two producers used it as a feature/product TAG instead —
 *   the series-autopilot gap filer (`app: 'pipeline'`, a PortOS feature, not a
 *   managed app) and the auto-fixer's AI-provider investigation (`app: 'portos'`,
 *   which matches neither the seeded id `portos-default` nor the name `PortOS`).
 *
 *   That was harmless while an unresolvable app fell through to the PortOS root,
 *   which is where both kinds of work belong anyway — until the #3180 guard
 *   closed the fall-through: `prepareAgentWorkspace` now refuses to spawn an
 *   agent whose app doesn't resolve to a repo path, precisely so an agent can't
 *   silently commit into the PortOS checkout while claiming to work on someone's
 *   app. Since then both kinds were filed and then rejected at every spawn.
 *
 *   Both producers now pass no app (which resolves to the PortOS root), but
 *   nothing rewrites the tasks already on disk, and every install that ran an
 *   autopilot with `fileGaps` on — or hit a provider failure — has one or more
 *   sitting in its queue that can never spawn.
 *
 * What it writes:
 *   `data/TASKS.md` and `data/COS-TASKS.md` — deletes the mis-routed `- app: …`
 *   metadata line from NON-COMPLETED tasks whose headline identifies one of the
 *   two producers, and re-stamps `updatedAt` on each so the un-routed copy wins
 *   the last-write federation merge against a peer that hasn't migrated yet
 *   (`pickContentBase` in `cosTaskMerge.js` breaks an equal-status tie on that
 *   stamp). Completed tasks keep theirs: they already ran, and their metadata is
 *   history, not routing.
 *
 *   Scoped to those headlines rather than to the app value outright, so an
 *   install that legitimately registered an app *named* `pipeline` or `portos`
 *   keeps its own tasks routed.
 *
 *   A text-level rewrite rather than a parse/regenerate round-trip (the choice
 *   migrations 146 and 225 made for these files): regenerating would reorder,
 *   re-escape and re-sort every task in the user's live queue. The one thing
 *   that costs us is moving a task between sections, so a task already BLOCKED
 *   for this reason keeps its block — it is un-routed here and revived by the
 *   user (or aged out by the blocked-task reaper) rather than being teleported
 *   from `## Blocked` to `## Pending` by a text edit.
 *
 * Idempotent: a task with no mis-routed app line is skipped, so a second run
 * changes nothing and the files are left untouched when there is nothing to do.
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

// The two mis-routed producers, keyed by the stable first line each writes.
// `fileGap` (seriesAutopilot/session.js) names a gap kind and a series uuid;
// `createAIProviderInvestigationTask` (autoFixer.js) names the provider/model.
const STRANDED = [
  { configKey: 'userTasksFile', file: 'data/TASKS.md', headline: /^Autopilot \S+ gap — series \S+/, app: 'pipeline' },
  { configKey: 'cosTasksFile', file: 'data/COS-TASKS.md', headline: /^Investigate AI provider failure:/, app: 'portos' },
];

/**
 * Repo-relative path of a queue file, honouring an install that moved it in its
 * CoS config (`userTasksFile` / `cosTasksFile` — the same values `cosTaskStore`
 * reads). Migrating only the defaults would record this migration as applied
 * while the live queue stayed stranded.
 */
async function queuePaths(rootDir) {
  const config = await readCosConfig({ rootDir, label: 'migration 234' });
  return STRANDED.map((producer) => ({
    ...producer,
    file: typeof config[producer.configKey] === 'string' && config[producer.configKey]
      ? config[producer.configKey]
      : producer.file,
  }));
}

/**
 * Delete the mis-routed app line from every non-completed task of one producer,
 * re-stamping `updatedAt` on the ones changed. Pure — exported for the test.
 *
 * @param {string} markdown raw TASKS.md / COS-TASKS.md
 * @param {{ headline: RegExp, app: string, stamp: string }} producer
 * @returns {{ markdown: string, unrouted: string[] }} ids of the tasks fixed
 */
export function unrouteTasks(markdown, { headline, app, stamp }) {
  const lines = markdown.split('\n');
  const out = [];
  const unrouted = [];
  // Id of the task whose block we are currently inside, when that task is one
  // this producer stranded; null everywhere else.
  let target = null;
  // Indices in `out` of the current target's app / updatedAt / last metadata
  // lines, so the rewrite happens once the whole block has been seen.
  let appAt = -1;
  let stampAt = -1;
  let lastMetaAt = -1;
  let indent = '  ';

  // Drop the app line and refresh (or add) the LWW stamp on the block we just
  // finished walking. No-op unless this block actually carried the bad app.
  const finish = () => {
    if (target && appAt >= 0) {
      out.splice(appAt, 1);
      const shift = (i) => (i > appAt ? i - 1 : i);
      const stampLine = `${indent}- updatedAt: ${stamp}`;
      if (stampAt >= 0) out[shift(stampAt)] = stampLine;
      // No stamp yet — insert one directly after the last metadata line rather
      // than at the end of the block, so it can't land after a description that
      // spilled onto its own lines (see the block-scan note below). `lastMetaAt`
      // is the right index post-splice either way: when a later metadata line
      // exists it shifted down one, so inserting there lands just after it; when
      // the app line WAS the last metadata line, that index is the hole it left.
      else out.splice(lastMetaAt, 0, stampLine);
      unrouted.push(target);
    }
    target = null;
    appAt = -1;
    stampAt = -1;
    lastMetaAt = -1;
  };

  for (const line of lines) {
    const header = line.match(TASK_LINE);
    // A task's block runs to the NEXT task header or section heading — not to
    // the first non-metadata line. A description written with embedded newlines
    // is interpolated into the file verbatim by `generateTasksMarkdown`, so a
    // freshly-filed task can carry blank/prose lines between its header and its
    // metadata (they are dropped on the next parse round-trip, but a migration
    // may well run before that happens). Ending the block at those lines would
    // walk right past the `app:` line this migration exists to remove.
    if (header || line.startsWith('#')) {
      finish();
      out.push(line);
      // Completed tasks already ran; their metadata is history, not routing.
      if (header && header[1] !== 'x' && headline.test(header[3].trim())) target = header[2];
      continue;
    }
    const meta = target ? line.match(METADATA_LINE) : null;
    if (meta) {
      indent = meta[1];
      lastMetaAt = out.length;
      if (meta[2] === 'app' && meta[3].trim() === app) appAt = out.length;
      else if (meta[2] === 'updatedAt') stampAt = out.length;
    }
    out.push(line);
  }
  finish();

  return { markdown: out.join('\n'), unrouted };
}

export default {
  async up({ rootDir, now = new Date().toISOString() }) {
    const unrouted = [];
    let seenAFile = false;

    for (const producer of await queuePaths(rootDir)) {
      const file = join(rootDir, producer.file);
      const raw = await readFile(file, 'utf-8').catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (raw == null) continue;
      seenAFile = true;

      const result = unrouteTasks(raw, { ...producer, stamp: now });
      if (!result.unrouted.length) continue;
      await atomicWrite(file, result.markdown);
      unrouted.push(...result.unrouted);
    }

    if (!seenAFile) {
      console.log('🔥 migration 234: no task queue on this install — nothing to un-route');
      return { ok: true, reason: 'no-task-file' };
    }
    if (!unrouted.length) {
      console.log('🔥 migration 234: no mis-routed tasks');
      return { ok: true, reason: 'already-unrouted', unrouted: 0 };
    }
    console.log(`🔥 migration 234: un-routed ${unrouted.length} task(s) from an app that does not exist`);
    return { ok: true, unrouted: unrouted.length };
  },
};
